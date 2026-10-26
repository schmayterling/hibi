/** Focus the requested pane in the active document, never an inert editor. */
export function focusEditor(pane: 'rich' | 'source', options?: FocusOptions) {
  const root = document.querySelector('.editor-page[data-active="true"]')
  const find = (kind: typeof pane) =>
    root?.querySelector<HTMLElement>(
      `.${kind}-pane :is(.tiptap,.cm-content):not([inert] *)`,
    )
  const target = find(pane) ?? find(pane === 'rich' ? 'source' : 'rich')
  target?.focus(options)
}
