import { type Editor, type EditorEvents, Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { AcceptedSourceEdit } from '../../shared/document-session'
import type { SourceSnapshot } from '../../shared/source-buffer'
import { documentRuntime } from './document-runtime'
import { richSourceSnapshots as sources } from './rich-sync'

export { richSourceSnapshot } from './rich-sync'

export const richSourceEcho = new PluginKey('documentSourceEcho')
type SourceStamp = Pick<SourceSnapshot, 'document' | 'version'>
const stamp = (source: SourceStamp): SourceStamp =>
  Object.freeze({
    document: Object.freeze({
      tabId: source.document.tabId,
      revision: source.document.revision,
    }),
    version: source.version,
  })
const dispatches = new WeakMap<Editor, object>()

/** Tiptap applies its filters/appended transactions once; source commits before its events. */
export const richSourceSession = Extension.create<{
  prepare: (
    event: EditorEvents['beforeTransaction'],
  ) => AcceptedSourceEdit | null
  reject: (error: unknown) => void
  reconciled: (source: SourceSnapshot) => void
  initialSource: SourceStamp | null
}>({
  name: 'documentSource',
  priority: 1_000_000,
  addOptions() {
    return {
      prepare: () => null,
      reject: () => {},
      reconciled: () => {},
      initialSource: null,
    }
  },
  onBeforeCreate() {
    if (this.options.initialSource)
      sources.set(this.editor, stamp(this.options.initialSource))
  },
  onDestroy() {
    sources.delete(this.editor)
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        filterTransaction: (transaction) =>
          !transaction.docChanged ||
          !!transaction.getMeta(richSourceEcho) ||
          this.editor.isEditable,
      }),
    ]
  },
  dispatchTransaction({ transaction, next }) {
    const editor = this.editor,
      original = editor.emit,
      emit = original.bind(editor)
    const scope = {},
      parent = dispatches.get(editor)
    dispatches.set(editor, scope)
    const accepted: { current: AcceptedSourceEdit | null } = { current: null }
    const echo = transaction.getMeta(richSourceEcho) as
      | SourceSnapshot
      | undefined
    const candidate: { event: EditorEvents['beforeTransaction'] | null } = {
      event: null,
    }
    // Intercept the public pre-transaction event before any addon can observe
    // or save the accepted candidate. The standard dispatcher still owns all
    // filter/append/capture behavior and native view/event delivery.
    editor.emit = (event, ...args) => {
      if (event === 'beforeTransaction' && dispatches.get(editor) === scope) {
        const update = args[0] as EditorEvents['beforeTransaction']
        candidate.event = update
        if (echo) {
          if (
            !documentRuntime
              .session(echo.document.tabId)
              ?.ownsCurrentSnapshot(echo) ||
            !update.nextState.doc.eq(transaction.doc)
          )
            throw new Error(
              'An editor addon prevented source synchronization. Retry after checking its settings.',
            )
        } else if (!update.nextState.doc.eq(editor.state.doc)) {
          if (accepted.current)
            throw new Error(
              'Rich transaction attempted more than one source commit.',
            )
          accepted.current = this.options.prepare(update)
        }
      }
      return emit(event, ...args)
    }
    try {
      next(transaction)
      const source = accepted.current?.prepared.after ?? echo
      if (source && candidate.event?.nextState.doc.eq(editor.state.doc)) {
        sources.set(editor, stamp(source))
        this.options.reconciled(source)
      }
    } catch (error) {
      this.options.reject(error)
      if (!editor.isDestroyed) editor.view.updateState(editor.state)
    } finally {
      editor.emit = original
      if (parent) dispatches.set(editor, parent)
      else dispatches.delete(editor)
      accepted.current?.finish()
    }
  },
})
