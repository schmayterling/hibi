/** Restore editor focus after the current layout and any pending editor load. */
export function focusEditor(options?: FocusOptions) {
  const active = document.activeElement
  void import('./editor-focus-restore').then(({ focusEditor }) => {
    if (
      document.activeElement === active ||
      document.activeElement === document.body
    )
      focusEditor(options)
  })
}
