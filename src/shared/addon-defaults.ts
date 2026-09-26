/** Saved preferences take precedence; live development enables built-in inspection tools. */
export function addonDefaultEnabled(
  id: string,
  defaultEnabled: boolean | undefined,
  development: boolean,
) {
  return (
    id === 'markdown' ||
    (id === 'diagnostics' || id === 'ui-preview'
      ? development
      : (defaultEnabled ?? false))
  )
}
