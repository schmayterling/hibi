import type { ViewId } from '../../shared/foundation-contracts'
import { documentRuntime } from './document-runtime'
import { editorViewRegistry } from './editor-view-api'

let focusIntent = 0
let pending: MutationObserver | undefined
for (const event of ['pointerdown', 'focusin', 'keydown'])
  document.addEventListener(
    event,
    (event) => {
      const target = event.target
      // A loading editor becoming read-only can move focus without user input.
      if (
        event.type === 'focusin' &&
        (target === document.body ||
          (target instanceof HTMLElement &&
            target.matches(
              '.tiptap[contenteditable="false"], .cm-content[contenteditable="false"]',
            )))
      )
        return
      focusIntent++
      pending?.disconnect()
      pending = undefined
    },
    true,
  )

/** Prefer the active page's editing pane, including after asynchronous mounting. */
export function focusEditor(options?: FocusOptions) {
  pending?.disconnect()
  const focus = () => {
    const root = document.querySelector<HTMLElement>(
      '.editor-page[data-active="true"]',
    )
    const viewId = root?.dataset.side
    const view = viewId
      ? documentRuntime.captureView(viewId as ViewId)
      : documentRuntime.captureActiveView()
    const selection = view && editorViewRegistry.getSelection(view)
    const find = (kind: 'rich' | 'source') => {
      const target = root?.querySelector<HTMLElement>(
        `.${kind}-pane :is(.tiptap,.cm-content)[contenteditable="true"]:not([inert] *)`,
      )
      return target?.checkVisibility({ visibilityProperty: true })
        ? target
        : undefined
    }
    const target =
      (selection?.ok && find(selection.value.editor)) ||
      find('source') ||
      find('rich')
    if (!target) return false
    pending?.disconnect()
    pending = undefined
    target.focus(options)
    return true
  }
  if (!focus()) {
    pending = new MutationObserver(focus)
    pending.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['contenteditable', 'inert', 'hidden', 'class', 'style'],
    })
  }
}

/** Restore editing focus after a transition unless another interaction takes it. */
export function captureEditorFocus(element: HTMLElement) {
  if (document.activeElement !== element) return null
  const intent = focusIntent
  const page = element.closest('.editor-page')
  return () => {
    if (
      focusIntent === intent &&
      document.activeElement === document.body &&
      page?.matches('.editor-page[data-active="true"]')
    )
      focusEditor({ preventScroll: true })
  }
}
