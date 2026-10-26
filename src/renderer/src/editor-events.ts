import type { EditorInputEvent, EditorKeyEvent } from '../../addons/api'

function editableTarget(target: EventTarget | null) {
  if (
    !(target instanceof HTMLElement) ||
    target.closest('[inert]') ||
    document.querySelector('dialog[open]')
  )
    return null
  return target.closest<HTMLElement>(
    '.tiptap[contenteditable="true"], .cm-content[contenteditable="true"]',
  )
}

/** CodeMirror's formatted presentation is the normal view. */
const viewOf = (editor: HTMLElement) =>
  editor.classList.contains('cm-content') && !editor.closest('.hibi-formatted')
    ? 'source'
    : 'normal'

export function onEditorInput(listener: (event: EditorInputEvent) => void) {
  let composition: { target: EventTarget | null; text: string } | null = null
  const report = (target: EventTarget | null, text: string) => {
    const editor = editableTarget(target)
    if (!editor || !text) return
    listener(
      Object.freeze({
        characters: Array.from(text).length,
        view: viewOf(editor),
      }),
    )
  }
  const input = (event: InputEvent) => {
    if (event.isComposing || event.inputType === 'insertCompositionText') return
    if (
      composition?.target === event.target &&
      composition.text === event.data
    ) {
      composition = null
      return
    }
    composition = null
    if (event.inputType === 'insertText') report(event.target, event.data ?? '')
    else if (['insertParagraph', 'insertLineBreak'].includes(event.inputType))
      report(event.target, '\n')
  }
  const commit = (event: CompositionEvent) => {
    composition = { target: event.target, text: event.data }
    report(event.target, event.data)
    queueMicrotask(() => {
      composition = null
    })
  }
  document.addEventListener('beforeinput', input, true)
  document.addEventListener('compositionend', commit, true)
  return () => {
    document.removeEventListener('beforeinput', input, true)
    document.removeEventListener('compositionend', commit, true)
  }
}

const listeners = new Set<(event: EditorKeyEvent) => void>()
export function onEditorKeyEvent(listener: (event: EditorKeyEvent) => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export function emitEditorKeyEvent(event: KeyboardEvent) {
  if (!listeners.size) return
  const target = event.target
  if (
    !(target instanceof HTMLElement) ||
    event.isComposing ||
    target.closest('[inert]')
  )
    return
  const editor = editableTarget(target)
  if (!editor) return
  const data: EditorKeyEvent = Object.freeze({
    phase: event.type === 'keyup' ? 'up' : 'down',
    key: event.key,
    code: event.code,
    repeat: event.repeat,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    view: viewOf(editor),
  })
  for (const listener of listeners) listener(data)
}
