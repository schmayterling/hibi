/** Public paths stay relative; native handlers revalidate against the real vault. */
export function vaultPath(
  value: unknown,
  configDir = '.obsidian',
  root = false,
): string {
  if (root && (value === '' || value === '/')) return ''
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 4096 ||
    /[\\:\p{Cc}]/u.test(value)
  )
    throw new Error('Choose a path inside this vault.')
  const parts = value.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..'))
    throw new Error('Choose a path inside this vault.')
  const protectedPath = (path: string) =>
    path.toLowerCase() === value.toLowerCase() ||
    value.toLowerCase().startsWith(`${path.toLowerCase()}/`)
  if (
    parts.some((part) => part.toLowerCase() === '.obsidian') ||
    (configDir && protectedPath(configDir))
  )
    throw new Error(
      'Plugin access to the vault configuration folder is unavailable.',
    )
  return value
}
