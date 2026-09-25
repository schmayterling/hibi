import type {
  EditorViewPosition,
  EditorViewSelection,
  EditorViewsApi,
} from '../../addons/api'
import type {
  DocumentTarget,
  OperationResult,
  ViewId,
  ViewTarget,
} from '../../shared/foundation-contracts'
import type { DocumentRuntime } from './document-runtime'
import { documentRuntime } from './document-runtime.ts'

type EditorKind = EditorViewSelection['editor']
type AdapterSelection = {
  contentVersion: number
  anchor: number
  head: number
  length: number
}
export type EditorViewAdapter = {
  read: () => AdapterSelection | null
  setSelection: (anchor: number, head: number) => boolean
  reveal: (position: number) => boolean
}
type Entry = { document: DocumentTarget; adapter: EditorViewAdapter }
type Failure = Extract<OperationResult<never>, { ok: false }>
const failure = (code: Failure['code'], message: string): Failure => ({
  ok: false,
  code,
  message,
})
const stale = () => failure('stale', 'This editor view changed. Read it again.')
const unavailable = () =>
  failure('unsupported', 'This editor pane is not available.')
const validPosition = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

function validView(value: unknown): value is ViewTarget {
  if (!value || typeof value !== 'object') return false
  const view = value as Partial<ViewTarget>
  return (
    typeof view.documentId === 'string' &&
    view.documentId.length > 0 &&
    view.documentId.length <= 128 &&
    validPosition(view.documentGeneration) &&
    view.documentGeneration > 0 &&
    typeof view.viewId === 'string' &&
    view.viewId.length > 0 &&
    view.viewId.length <= 128 &&
    validPosition(view.viewGeneration) &&
    view.viewGeneration > 0
  )
}

/** Mounted editor controls; document and view generations remain runtime owned. */
export class EditorViewRegistry {
  readonly #runtime: DocumentRuntime
  readonly #adapters = new Map<ViewId, Partial<Record<EditorKind, Entry>>>()
  readonly #active = new Map<ViewId, EditorKind>()
  readonly #listeners = new Set<() => void>()

  constructor(runtime: DocumentRuntime) {
    this.#runtime = runtime
  }
  register(
    tabId: string,
    viewId: ViewId,
    editor: EditorKind,
    adapter: EditorViewAdapter,
  ) {
    const document = this.#runtime.captureDocument(tabId)
    if (!document) return () => {}
    const entry = { document, adapter }
    const adapters: Partial<Record<EditorKind, Entry>> =
      this.#adapters.get(viewId) ?? {}
    adapters[editor] = entry
    this.#adapters.set(viewId, adapters)
    this.changed(viewId, editor)
    return () => {
      if (adapters[editor] !== entry) return
      delete adapters[editor]
      if (!adapters.source && !adapters.rich) this.#adapters.delete(viewId)
      this.changed(viewId, editor)
    }
  }
  setActive(viewId: ViewId, editor: EditorKind) {
    if (this.#active.get(viewId) === editor) return
    this.#active.set(viewId, editor)
    this.#notify()
  }
  clearActive(viewId: ViewId) {
    if (this.#active.delete(viewId)) this.#notify()
  }
  changed(viewId: ViewId, editor: EditorKind) {
    if (
      this.#listeners.size &&
      this.#active.get(viewId) === editor &&
      this.#runtime.captureView(viewId)
    )
      this.#notify()
  }
  subscribe(listener: () => void) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
  #notify() {
    for (const listener of [...this.#listeners]) listener()
  }
  #current(value: unknown):
    | { target: ViewTarget; editor: EditorKind; entry: Entry; selection: AdapterSelection }
    | Failure {
    if (!validView(value)) return failure('conflict', 'Invalid editor view target.')
    const target = this.#runtime.captureView(value.viewId)
    if (
      !target ||
      target.viewGeneration !== value.viewGeneration ||
      target.documentId !== value.documentId ||
      target.documentGeneration !== value.documentGeneration
    )
      return stale()
    const editor = this.#active.get(target.viewId)
    if (!editor) return unavailable()
    const entry = this.#adapters.get(target.viewId)?.[editor]
    if (
      !entry ||
      entry.document.documentId !== target.documentId ||
      entry.document.documentGeneration !== target.documentGeneration
    )
      return unavailable()
    let selection: AdapterSelection | null
    try {
      selection = entry.adapter.read()
    } catch {
      return unavailable()
    }
    if (!selection) return unavailable()
    const session = this.#runtime.resolveDocument(target)
    if (!session || session.snapshot().version !== selection.contentVersion)
      return stale()
    return { target, editor, entry, selection }
  }
  getSelection(view: ViewTarget): OperationResult<EditorViewSelection> {
    const current = this.#current(view)
    if ('ok' in current) return current
    const { target, editor, selection } = current
    return {
      ok: true,
      value: Object.freeze({
        view: target,
        editor,
        contentVersion: selection.contentVersion,
        anchor: selection.anchor,
        head: selection.head,
      }),
    }
  }
  setSelection(value: EditorViewSelection): OperationResult<void> {
    if (
      !value ||
      !validPosition(value.contentVersion) ||
      !validPosition(value.anchor) ||
      !validPosition(value.head)
    )
      return failure('conflict', 'Invalid editor selection.')
    const current = this.#current(value.view)
    if ('ok' in current) return current
    if (
      value.editor !== current.editor ||
      value.contentVersion !== current.selection.contentVersion
    )
      return stale()
    if (
      value.anchor > current.selection.length ||
      value.head > current.selection.length
    )
      return failure('conflict', 'Selection is outside this editor.')
    try {
      return current.entry.adapter.setSelection(value.anchor, value.head)
        ? { ok: true, value: undefined }
        : unavailable()
    } catch {
      return unavailable()
    }
  }
  reveal(value: EditorViewPosition): OperationResult<void> {
    if (!value || !validPosition(value.contentVersion) || !validPosition(value.position))
      return failure('conflict', 'Invalid editor position.')
    const current = this.#current(value.view)
    if ('ok' in current) return current
    if (
      value.editor !== current.editor ||
      value.contentVersion !== current.selection.contentVersion
    )
      return stale()
    if (value.position > current.selection.length)
      return failure('conflict', 'Position is outside this editor.')
    try {
      return current.entry.adapter.reveal(value.position)
        ? { ok: true, value: undefined }
        : unavailable()
    } catch {
      return unavailable()
    }
  }
}

export const editorViewRegistry = new EditorViewRegistry(documentRuntime)

/** One addon activation owns its subscriptions and cannot use them after stop. */
export function createEditorViewScope(
  runtime: DocumentRuntime,
  registry: EditorViewRegistry,
): EditorViewsApi & { dispose: () => void } {
  let disposed = false
  const cleanups = new Set<() => void>()
  const getActive = () => (disposed ? null : runtime.captureActiveView())
  const getSelection: EditorViewsApi['getSelection'] = (view) =>
    disposed
      ? failure('disposed', 'This addon has stopped.')
      : registry.getSelection(view)
  const sameView = (left: ViewTarget | null, right: ViewTarget | null) =>
    left?.viewId === right?.viewId &&
    left?.viewGeneration === right?.viewGeneration
  const sameSelection = (
    left: EditorViewSelection | null,
    right: EditorViewSelection | null,
  ) =>
    sameView(left?.view ?? null, right?.view ?? null) &&
    left?.editor === right?.editor &&
    left?.contentVersion === right?.contentVersion &&
    left?.anchor === right?.anchor &&
    left?.head === right?.head
  const observe = (subscribe: (listener: () => void) => () => void, listener: () => void) => {
    if (disposed) return () => {}
    const remove = subscribe(listener)
    cleanups.add(remove)
    return () => {
      remove()
      cleanups.delete(remove)
    }
  }
  return {
    dispose() {
      if (disposed) return
      disposed = true
      for (const remove of cleanups) remove()
      cleanups.clear()
    },
    list: () => (disposed ? [] : runtime.listViews()),
    getActive,
    getSelection,
    setSelection: (selection) =>
      disposed
        ? failure('disposed', 'This addon has stopped.')
        : registry.setSelection(selection),
    reveal: (position) =>
      disposed
        ? failure('disposed', 'This addon has stopped.')
        : registry.reveal(position),
    onDidChangeActive(listener) {
      if (typeof listener !== 'function')
        throw new Error('An active-view listener is required.')
      let previous = getActive()
      return observe(runtime.subscribeViews, () => {
        if (disposed) return
        const current = getActive()
        if (sameView(previous, current)) return
        previous = current
        try {
          listener(current)
        } catch (error) {
          console.error('Editor view listener failed:', error)
        }
      })
    },
    onDidChangeSelection(listener) {
      if (typeof listener !== 'function')
        throw new Error('A selection listener is required.')
      const current = () => {
        const active = getActive()
        if (!active) return null
        const result = getSelection(active)
        return result.ok ? result.value : null
      }
      let previous = current()
      const emit = () => {
        if (disposed) return
        const selection = current()
        if (sameSelection(previous, selection)) return
        previous = selection
        try {
          listener(selection)
        } catch (error) {
          console.error('Editor selection listener failed:', error)
        }
      }
      const stopView = observe(runtime.subscribeViews, emit)
      const stopSelection = observe((callback) => registry.subscribe(callback), emit)
      return () => {
        stopView()
        stopSelection()
      }
    },
  }
}
