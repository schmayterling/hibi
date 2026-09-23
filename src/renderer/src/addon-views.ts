import type {
  AddonView,
  AddonViewProps,
  ViewInstance,
  ViewRegistration,
} from '../../addons/api'
import type { DocumentState } from '../../shared/desktop'
import { editorDocument } from './document-formats'

type Environment = {
  openSidebar: (id: string, side: 'left' | 'right') => void
  closeSidebar: (side: 'left' | 'right') => void
  openTab: () => void
  focusDocument: (tabId: string) => Promise<boolean>
}
export type RegisteredView = AddonView & {
  owner: string
  environment: Environment
}
export type ViewEntry = {
  id: string
  side: 'left' | 'right'
  definition: RegisteredView
  input: unknown
  binding: AddonViewProps['binding']
  document: Readonly<DocumentState> | null
  handle: ViewInstance
}
const definitions = new Map<string, RegisteredView>()
const instances = new Map<string, ViewEntry>()
const listeners = new Set<() => void>()
let activePanel: string | null = null
let activeTab: string | null = null
let activeStart: string | null = null
let activeSidebar: string | null = null
let activeRightSidebar: string | null = null
let focusTarget: string | null = null
let snapshot: {
  definitions: RegisteredView[]
  instances: ViewEntry[]
  activePanel: string | null
  activeTab: string | null
  activeStart: string | null
  activeSidebar: string | null
  activeRightSidebar: string | null
  focusTarget: string | null
} = {
  definitions: [],
  instances: [],
  activePanel,
  activeTab,
  activeStart,
  activeSidebar,
  activeRightSidebar,
  focusTarget,
}
const publish = () => {
  snapshot = {
    definitions: [...definitions.values()],
    instances: [...instances.values()],
    activePanel,
    activeTab,
    activeStart,
    activeSidebar,
    activeRightSidebar,
    focusTarget,
  }
  for (const listener of listeners) listener()
}
const capture = () => {
  const document = editorDocument.get()
  return document
    ? Object.freeze({
        ...document,
        tabs: document.tabs.map((tab) => Object.freeze({ ...tab })),
      })
    : null
}
function open(
  definition: RegisteredView,
  options: Parameters<ViewRegistration['open']>[0] = {},
  reveal = true,
): ViewInstance {
  if (definitions.get(definition.id) !== definition)
    throw new Error('This view is no longer available.')
  const panel = definition.location === 'panel'
  const tab = definition.location === 'tab'
  const start = definition.location === 'start'
  const side =
    panel || tab || start ? 'left' : (options.side ?? definition.side ?? 'left')
  if (!['left', 'right'].includes(side))
    throw new Error('Invalid sidebar side.')
  const localId = options.id ?? 'default'
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(localId))
    throw new Error('Invalid view instance ID.')
  const id = `${definition.id}:${side === 'right' ? 'right:' : ''}${localId}`
  const select = () => {
    if (tab || start) return
    if (side === 'right') activeRightSidebar = id
    else activeSidebar = id
  }
  const existing = instances.get(id)
  if (existing) {
    if ('input' in options)
      instances.set(id, { ...existing, input: options.input })
    if (reveal) existing.handle.show()
    else {
      select()
      publish()
    }
    if (options.focus !== false) existing.handle.focus()
    return existing.handle
  }
  if (
    [...instances.values()].filter(
      (entry) => entry.definition.owner === definition.owner,
    ).length >= 8 ||
    instances.size >= 32
  )
    throw new Error('Close a addon view before opening another.')
  const returnFocus =
    window.document.activeElement instanceof HTMLElement
      ? window.document.activeElement
      : null
  const handle: ViewInstance = {
    id,
    show() {
      if (!instances.has(id)) return
      if (panel) activePanel = id
      else if (tab) activeTab = id
      else if (start) activeStart = id
      else select()
      publish()
      if (tab) definition.environment.openTab()
      else if (!panel) definition.environment.openSidebar(definition.id, side)
    },
    hide() {
      if (!instances.has(id)) return
      const element = window.document.querySelector(
        `[data-addon-view="${CSS.escape(id)}"]`,
      )
      const focusedInView = element?.contains(window.document.activeElement)
      const focusedInTab = window.document
        .getElementById(`addon-tab-${id}`)
        ?.parentElement?.contains(window.document.activeElement)
      if (focusedInView && !tab) {
        const target =
          returnFocus?.isConnected && !returnFocus.closest('[hidden], [inert]')
            ? returnFocus
            : window.document.querySelector<HTMLElement>(
                '.editor-panes .rich-pane:not([inert]) [contenteditable="true"], .editor-panes .source-pane:not([inert]) [contenteditable="true"]',
              )
        target?.focus({ preventScroll: true })
      }
      if (panel && activePanel === id) activePanel = null
      else if (tab && activeTab === id) activeTab = null
      else if (start && activeStart === id) {
        activeStart =
          [...instances.values()].findLast(
            (entry) => entry.id !== id && entry.definition.location === 'start',
          )?.id ?? null
      } else if (
        !panel &&
        !tab &&
        !start &&
        (side === 'right' ? activeRightSidebar : activeSidebar) === id
      ) {
        if (side === 'right') activeRightSidebar = null
        else activeSidebar = null
        definition.environment.closeSidebar(side)
      }
      if (focusTarget === id) focusTarget = null
      publish()
      if (tab && (focusedInView || focusedInTab))
        requestAnimationFrame(() =>
          window.document
            .querySelector<HTMLElement>(
              '.editor-panes .rich-pane:not([inert]) [contenteditable="true"], .editor-panes .source-pane:not([inert]) [contenteditable="true"]',
            )
            ?.focus({ preventScroll: true }),
        )
    },
    close() {
      if (!instances.has(id)) return
      handle.hide()
      instances.delete(id)
      publish()
    },
    focus() {
      if (!instances.has(id)) return
      focusTarget = id
      publish()
    },
  }
  instances.set(id, {
    id,
    side,
    definition,
    input: options.input,
    binding: options.binding ?? 'follow',
    document: options.binding === 'pinned' ? capture() : null,
    handle,
  })
  if (reveal) handle.show()
  else {
    select()
    publish()
  }
  if (options.focus !== false) handle.focus()
  return handle
}
export const addonViews = {
  snapshot: () => snapshot,
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  register(
    owner: string,
    view: AddonView,
    environment: Environment,
  ): ViewRegistration {
    const id = `${owner}.${view.id}`
    if (
      !/^[a-z][a-z0-9-]*$/.test(view.id) ||
      definitions.has(id) ||
      (view.location &&
        !['sidebar', 'panel', 'tab', 'start'].includes(view.location)) ||
      (view.side && !['left', 'right'].includes(view.side)) ||
      (view.lifetime && !['visible', 'session'].includes(view.lifetime))
    )
      throw new Error(`This addon supplied a duplicate or invalid view: ${id}.`)
    const definition = { ...view, id, owner, environment }
    definitions.set(id, definition)
    publish()
    if (view.location === 'start') open(definition, { focus: false })
    return {
      open: (options) => open(definition, options),
      dispose() {
        if (definitions.get(id) !== definition) return
        for (const entry of [...instances.values()]) {
          if (entry.definition !== definition) continue
          // Removing an addon leaves the shared sidebar open for its workspace fallback.
          if (
            entry.definition.location === 'panel' ||
            entry.definition.location === 'tab' ||
            entry.definition.location === 'start'
          )
            entry.handle.close()
          else {
            if (activeSidebar === entry.id) activeSidebar = null
            if (activeRightSidebar === entry.id) activeRightSidebar = null
            if (focusTarget === entry.id) focusTarget = null
            instances.delete(entry.id)
          }
        }
        definitions.delete(id)
        publish()
      },
    }
  },
  selectSidebar(id: string, input?: unknown, side: 'left' | 'right' = 'left') {
    const selected = side === 'right' ? activeRightSidebar : activeSidebar
    const definition = definitions.get(id)
    if (
      !definition ||
      (definition.location && definition.location !== 'sidebar')
    ) {
      if (selected) {
        if (side === 'right') activeRightSidebar = null
        else activeSidebar = null
        publish()
      }
      return
    }
    const current = selected && instances.get(selected)
    if (current && current.definition === definition) return
    open(definition, { input, focus: false, side }, false)
  },
  focusHandled(id: string) {
    if (focusTarget === id) {
      focusTarget = null
      publish()
    }
  },
  selectDocument() {
    if (activeTab === null) return
    activeTab = null
    publish()
  },
}
