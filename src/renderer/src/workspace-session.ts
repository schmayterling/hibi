import type { EditorView } from '@codemirror/view'
import { flushSync } from 'react-dom'
import type { DocumentState } from '../../shared/desktop.ts'
import {
  type DocumentView,
  isDocumentView,
} from '../../shared/document-types.ts'
import {
  type SourceSelection,
  sourceSelection,
} from '../../shared/source-selection.ts'
import type { DocumentRuntime } from './document-runtime.ts'
import type { EditorViewRegistry } from './editor-view-api.ts'
import { sourcePosition, sourceView } from './source-view.ts'

export interface ObsidianSessionBridge {
  readonly pending: boolean
  onCapture(callback: () => unknown | Promise<unknown>): () => void
  onResume(callback: (message?: string) => void): () => void
  restore(): Promise<{ ui: unknown; documents: DocumentState[] } | null>
  ready(): Promise<void>
  abort(message: string): void
  switch(): void
}
let workspaceRestored = false
export const hasRestoredWorkspace = () => workspaceRestored

type Side = 'left' | 'right'
export type WorkspaceShell = {
  split: {
    left: string
    right: string
    active: Side
    leftMode: DocumentView
    rightMode: DocumentView
  } | null
  selectedMode: DocumentView
  settings: { open: boolean; category: string }
  sidebar: { left: boolean; right: boolean; zen: boolean }
}
type View = {
  id: Side | 'primary'
  /** Markdown's separate source editor uses `${base}:source`; other editors use the base. */
  source: boolean
  selection: SourceSelection | null
  top: SourceSelection | null
  margin: number | null
  scrollLeft: number
}
export type WorkspaceUi = WorkspaceShell & {
  version: 1
  activeTab: string
  activeEditor: 'source' | 'rich' | null
  tabs: {
    tabId: string
    revision: number
    contentVersion: number
    views: View[]
  }[]
}
export type WorkspaceSessionHost = {
  runtime: DocumentRuntime
  views: EditorViewRegistry
  shell: WorkspaceShell
  accept(document: DocumentState, focus?: boolean): void
  suspend(value: boolean): void
  settle(): Promise<unknown>
  autosaving: boolean
  error(message: string): void
}
const invalid = () => new Error('Invalid workspace session.')
const maxBytes = 2 * 1024 * 1024
const validMode = (value: string) => value === 'image' || isDocumentView(value)
const validId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256
const bases = (tabId: string, split: WorkspaceShell['split']): View['id'][] => {
  const sides = (['left', 'right'] as const).filter(
    (side) => split?.[side] === tabId,
  )
  return sides.length ? sides : ['primary']
}
const viewKey = (
  runtime: DocumentRuntime,
  tabId: string,
  view: Pick<View, 'id' | 'source'>,
) => {
  const base = view.id === 'primary' ? runtime.primaryViewId(tabId) : view.id
  if (!base) throw invalid()
  return base + (view.source ? ':source' : '')
}

function checkSize(value: unknown) {
  if (new TextEncoder().encode(JSON.stringify(value)).length > maxBytes)
    throw invalid()
}

/** UI only: reading a session never materializes or copies its source. */
export function captureWorkspaceUi(
  runtime: DocumentRuntime,
  shell: WorkspaceShell,
  activeEditor: WorkspaceUi['activeEditor'] = null,
): WorkspaceUi {
  const active = runtime.get()
  if (!active) throw invalid()
  const ui: WorkspaceUi = {
    ...shell,
    version: 1,
    activeTab: active.tabId,
    activeEditor,
    tabs: runtime.documents().map((document) => {
      const session = runtime.session(document.tabId)
      if (!session) throw invalid()
      return {
        tabId: document.tabId,
        revision: document.revision,
        contentVersion: document.contentVersion,
        views: bases(document.tabId, shell.split).flatMap((id) =>
          [false, true].flatMap((source) => {
            const key = viewKey(runtime, document.tabId, { id, source })
            const selection = session.selection(key)
            const margin = session.keptMargins.get(key) ?? null
            const top =
              margin === null
                ? null
                : (session.selection(`${key}:workspace-top`) ??
                  session.selection(`${key}\0top`))
            return selection || top
              ? [
                  {
                    id,
                    source,
                    selection,
                    top,
                    margin: top ? margin : null,
                    scrollLeft:
                      session.keptMargins.get(`${key}:workspace-left`) ?? 0,
                  },
                ]
              : []
          }),
        ),
      }
    }),
  }
  checkSize(ui)
  if (ui.tabs.length > 1024) throw invalid()
  return ui
}

function parseUi(value: unknown, documents: readonly DocumentState[]) {
  checkSize(value)
  const ui = value as WorkspaceUi
  if (
    !ui ||
    ui.version !== 1 ||
    !validId(ui.activeTab) ||
    (ui.activeEditor !== null &&
      ui.activeEditor !== 'source' &&
      ui.activeEditor !== 'rich') ||
    !validMode(ui.selectedMode) ||
    !ui.settings ||
    typeof ui.settings.open !== 'boolean' ||
    !validId(ui.settings.category) ||
    !ui.sidebar ||
    !['left', 'right', 'zen'].every(
      (key) =>
        typeof ui.sidebar[key as keyof WorkspaceShell['sidebar']] === 'boolean',
    ) ||
    !Array.isArray(ui.tabs) ||
    !ui.tabs.length ||
    ui.tabs.length > 1024 ||
    ui.tabs.length !== documents.length
  )
    throw invalid()
  const transferred = new Map(
    documents.map((document) => [document.tabId, document]),
  )
  const ids = new Set(ui.tabs.map((tab) => tab?.tabId))
  if (
    transferred.size !== documents.length ||
    ids.size !== ui.tabs.length ||
    !ids.has(ui.activeTab)
  )
    throw invalid()
  const split = ui.split
  if (
    split !== null &&
    (!split ||
      !ids.has(split.left) ||
      !ids.has(split.right) ||
      (split.active !== 'left' && split.active !== 'right') ||
      split[split.active] !== ui.activeTab ||
      !validMode(split.leftMode) ||
      !validMode(split.rightMode))
  )
    throw invalid()
  for (const tab of ui.tabs) {
    const document = transferred.get(tab.tabId)
    if (
      !validId(tab.tabId) ||
      !document ||
      tab.revision !== document.revision ||
      tab.contentVersion !== document.contentVersion ||
      !Array.isArray(tab.views) ||
      tab.views.length > 6
    )
      throw invalid()
    const keys = new Set<string>()
    for (const view of tab.views) {
      if (
        !view ||
        !bases(tab.tabId, split).includes(view.id) ||
        typeof view.source !== 'boolean' ||
        (view.margin !== null &&
          (typeof view.margin !== 'number' || !Number.isFinite(view.margin))) ||
        (view.top === null) !== (view.margin === null) ||
        typeof view.scrollLeft !== 'number' ||
        !Number.isFinite(view.scrollLeft)
      )
        throw invalid()
      const key = `${view.id}:${view.source}`
      if (keys.has(key)) throw invalid()
      keys.add(key)
    }
  }
  return ui
}

/** Hydrate all main-owned buffers, then seed bookmarks before React mounts any editor. */
export function restoreWorkspaceUi(
  runtime: DocumentRuntime,
  value: unknown,
  documents: readonly DocumentState[],
  accept: WorkspaceSessionHost['accept'],
): WorkspaceShell {
  try {
    const ui = parseUi(value, documents)
    for (const document of documents) {
      if (runtime.session(document.tabId)) {
        if (!runtime.focus(document)) throw invalid()
      } else runtime.activate(document)
    }
    // Validate every selection before changing any bookmark or accepting the UI.
    for (const tab of ui.tabs) {
      const session = runtime.session(tab.tabId)
      if (!session) throw invalid()
      const snapshot = session.snapshot()
      for (const view of tab.views) {
        for (const selection of [view.selection, view.top])
          if (selection !== null) sourceSelection(snapshot, selection)
        if (
          view.top &&
          (view.top.ranges.length !== 1 ||
            view.top.ranges[0]?.anchor !== view.top.ranges[0]?.head)
        )
          throw invalid()
      }
    }
    for (const tab of ui.tabs) {
      const session = runtime.session(tab.tabId)
      if (!session) throw invalid()
      for (const view of tab.views) {
        const key = viewKey(runtime, tab.tabId, view)
        if (view.selection) {
          session.select(view.selection, tab.contentVersion, key)
          session.select(
            view.selection,
            tab.contentVersion,
            `${key}\0selection`,
          )
        }
        if (view.top && view.margin !== null) {
          session.select(view.top, tab.contentVersion, `${key}\0top`)
          session.select(view.top, tab.contentVersion, `${key}:workspace-top`)
          session.keptMargins.set(key, view.margin)
        }
        session.keptMargins.set(`${key}:workspace-left`, view.scrollLeft)
      }
    }
    const active = runtime.get(ui.activeTab)
    if (!active) throw invalid()
    runtime.focus(active)
    accept(active, true)
    return {
      split: ui.split,
      selectedMode: ui.selectedMode,
      settings: ui.settings,
      sidebar: ui.sidebar,
    }
  } catch {
    throw invalid()
  }
}

/** Keep mapped source bookmarks even for a small tab that leaves the mounted view. */
function* mountedViews(host: WorkspaceSessionHost) {
  for (const target of host.runtime.listViews()) {
    const session = host.runtime.resolveDocument(target)
    const page = host.views.surface(target)?.closest('.editor-page')
    if (!session || !page) continue
    for (const element of page.querySelectorAll('.cm-editor')) {
      const view = sourceView(element)
      if (!view) continue
      const key =
        target.viewId +
        (view.dom.closest('.source-pane') &&
        page.querySelector('[data-editor-view]')
          ? ':source'
          : '')
      yield { session, key, view }
    }
  }
}
function rememberMountedViews(host: WorkspaceSessionHost) {
  for (const { session, key, view } of mountedViews(host))
    if (view.inView && !view.composing) rememberView(session, key, view)
}
function rememberView(
  session: NonNullable<ReturnType<DocumentRuntime['session']>>,
  key: string,
  view: EditorView,
) {
  const snapshot = session.snapshot()
  const raw = (position: number, association: -1 | 1) => {
    const at = sourcePosition(view, position)
    return snapshot.isEditBoundary(at) ? at : at + association
  }
  const selection: SourceSelection = {
    ranges: view.state.selection.ranges.map((range) => {
      const association = range.assoc < 0 ? -1 : 1
      return {
        anchor: raw(range.anchor, association),
        head: raw(range.head, association),
        association,
      }
    }),
    mainIndex: view.state.selection.mainIndex,
  }
  // Same top-line/margin contract as SourceEditor.keepPlace and bridge.place.
  view.lineBlockAtHeight(0)
  const scroller = view.scrollDOM.closest('.rich-pane') ?? view.scrollDOM
  const height = scroller.getBoundingClientRect().top - view.documentTop
  const line = view.lineBlockAtHeight(height)
  const at = raw(line.from, 1)
  session.select(selection, snapshot.version, key)
  session.select(
    { ranges: [{ anchor: at, head: at, association: 1 }], mainIndex: 0 },
    snapshot.version,
    `${key}:workspace-top`,
  )
  session.keptMargins.set(key, line.top - height)
  session.keptMargins.set(`${key}:workspace-left`, scroller.scrollLeft)
}
function viewsRestored(host: WorkspaceSessionHost, ui: WorkspaceUi) {
  for (const { session, key, view } of mountedViews(host)) {
    if (!view.inView) continue
    const saved = ui.tabs
      .find((tab) => tab.tabId === session.snapshot().document.tabId)
      ?.views.find(
        (item) =>
          viewKey(host.runtime, session.snapshot().document.tabId, item) ===
          key,
      )
    if (!saved?.top || saved.margin === null) continue
    const at = session.snapshot().rawToEditor(saved.top.ranges[0]?.head ?? 0)
    if (at === null) throw invalid()
    const line = view.lineBlockAt(at)
    const scroller = view.scrollDOM.closest('.rich-pane') ?? view.scrollDOM
    const height = scroller.getBoundingClientRect().top - view.documentTop
    if (Math.abs(line.top - height - saved.margin) > 1) return false
  }
  return true
}
const frame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

/** No editor implementation enters the initial renderer closure. */
export function createWorkspaceSession(
  bridge: ObsidianSessionBridge,
  current: () => WorkspaceSessionHost,
  apply: (shell: WorkspaceShell) => void,
) {
  let suspended = false
  let disposed = false
  let previousInert = false
  let previousFocus: HTMLElement | null = null
  let generation = 0
  const placed = new WeakSet<EditorView>()
  const restoreLeft = () => {
    for (const { session, key, view } of mountedViews(current())) {
      if (placed.has(view) || !view.inView) continue
      const left = session.keptMargins.get(`${key}:workspace-left`)
      if (left !== undefined) {
        const scroller = view.scrollDOM.closest('.rich-pane') ?? view.scrollDOM
        scroller.scrollLeft = left
      }
      placed.add(view)
    }
  }
  let placementFrame = 0
  const schedulePlace = () => {
    if (placementFrame || disposed) return
    placementFrame = requestAnimationFrame(() => {
      placementFrame = 0
      if (!disposed) restoreLeft()
    })
  }
  const removeViews = current().runtime.subscribeViews(schedulePlace)
  const removeEditors = current().views.subscribe(schedulePlace)
  const suspend = () => {
    if (suspended) throw new Error('A workspace switch is already running.')
    previousInert = document.body.inert
    previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    suspended = true
    document.body.inert = true
    window.dispatchEvent(new Event('hibi:obsidian-workspace-suspend'))
    flushSync(() => current().suspend(true))
    return ++generation
  }
  const resume = () => {
    if (!suspended) return
    suspended = false
    generation++
    document.body.inert = previousInert
    flushSync(() => current().suspend(false))
    window.dispatchEvent(new Event('hibi:obsidian-workspace-resume'))
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
  }
  const remember = () => {
    if (!suspended && !disposed) {
      restoreLeft()
      rememberMountedViews(current())
    }
  }
  const settle = async () => {
    if ((await current().settle()) === false)
      throw new Error('Could not synchronize document focus.')
  }
  const events = ['scroll', 'pointerdown', 'keydown', 'focusout'] as const
  for (const event of events) document.addEventListener(event, remember, true)
  const removeCapture = bridge.onCapture(async () => {
    if (suspended) throw new Error('A workspace switch is already running.')
    let captureGeneration = generation
    try {
      for (const element of document.querySelectorAll('.cm-editor'))
        if (sourceView(element)?.composing)
          throw new Error(
            'Finish composing text before switching plugin access.',
          )
      restoreLeft()
      rememberMountedViews(current())
      const active = current().runtime.captureActiveView()
      const focused = active && current().views.getSelection(active)
      const activeEditor = focused && focused.ok ? focused.value.editor : null
      captureGeneration = suspend()
      await settle()
      while (current().autosaving && suspended && !disposed) await frame()
      if (disposed || !suspended || generation !== captureGeneration)
        throw invalid()
      rememberMountedViews(current())
      return captureWorkspaceUi(
        current().runtime,
        current().shell,
        activeEditor,
      )
    } catch (error) {
      if (generation === captureGeneration) resume()
      throw error
    }
  })
  const removeResume = bridge.onResume((message) => {
    resume()
    if (message) current().error(message)
  })
  return {
    async bootstrap(initial: DocumentState) {
      if (!bridge.pending) {
        current().accept(initial)
        return
      }
      try {
        suspend()
        const restored = await bridge.restore()
        if (!restored || disposed) throw invalid()
        const { loadTransferredDocument } = await import('./document-transfer')
        const documents = await Promise.all(
          restored.documents.map((document) =>
            'documentTransfer' in document
              ? loadTransferredDocument(
                  window.hibiTransport,
                  document as unknown as import('../../shared/document-transfer').DocumentTransfer,
                )
              : document,
          ),
        )
        flushSync(() => {
          apply(
            restoreWorkspaceUi(
              current().runtime,
              restored.ui,
              documents,
              current().accept,
            ),
          )
        })
        // Each adapter mounts only after its demanded editor and addon capabilities load.
        const expected = current().shell.split ? 2 : 1
        while (
          !disposed &&
          (current().runtime.listViews().length < expected ||
            document.querySelector('.editor-page .loading-screen'))
        )
          await frame()
        if (disposed) throw invalid()
        const ui = restored.ui as WorkspaceUi
        restoreLeft()
        while (!disposed && !viewsRestored(current(), ui)) {
          restoreLeft()
          await frame()
        }
        if (disposed) throw invalid()
        workspaceRestored = true
        resume()
        await frame()
        const activeId =
          ui.split?.active ?? current().runtime.primaryViewId(ui.activeTab)
        const active = current()
          .runtime.listViews()
          .find((view) => view.viewId === activeId)
        if (active) current().runtime.focusView(active.viewId)
        const surface = active && current().views.surface(active)
        const page = surface?.closest('.editor-page')
        const wanted =
          ui.activeEditor &&
          page?.querySelector(
            ui.activeEditor === 'source'
              ? '.source-pane .cm-editor'
              : '.rich-pane .cm-editor',
          )
        if (wanted)
          sourceView(wanted)?.contentDOM.focus({ preventScroll: true })
        await settle()
        await bridge.ready()
      } catch (error) {
        bridge.abort(error instanceof Error ? error.message : String(error))
        resume()
        throw error
      }
    },
    dispose() {
      disposed = true
      removeCapture()
      removeResume()
      removeViews()
      removeEditors()
      cancelAnimationFrame(placementFrame)
      for (const event of events)
        document.removeEventListener(event, remember, true)
      resume()
    },
  }
}
