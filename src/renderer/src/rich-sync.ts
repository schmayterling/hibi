import type { Editor } from '@tiptap/core'
import type { SourceSnapshot } from '../../shared/source-buffer'
import { documentRuntime } from './document-runtime'

export const richSourceSnapshots = new WeakMap<
  Editor,
  Pick<SourceSnapshot, 'document' | 'version'>
>()
export const richSourceSnapshot = (editor: Editor) =>
  richSourceSnapshots.get(editor)
const refreshers = new WeakMap<Editor, () => void>()

export function richSourceCurrent(editor: Editor) {
  const known = richSourceSnapshot(editor)
  const source =
    known && documentRuntime.session(known.document.tabId)?.snapshot()
  return Boolean(
    !editor.isDestroyed &&
      known &&
      source &&
      known.version === source.version &&
      known.document.tabId === source.document.tabId &&
      known.document.revision === source.document.revision,
  )
}

export function registerRichSync(editor: Editor, refresh: () => void) {
  refreshers.set(editor, refresh)
  return () => {
    if (refreshers.get(editor) === refresh) refreshers.delete(editor)
  }
}

/** Flush before reading rich state or constructing a transaction, never during dispatch. */
export function flushRich(editor: Editor) {
  if (editor.isDestroyed) return false
  refreshers.get(editor)?.()
  return richSourceCurrent(editor)
}
