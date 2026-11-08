import { markdownLiteral } from './markdown-literal.ts'

export const encodeObsidianPath = (path: string) =>
  path
    .split('/')
    .map((part) =>
      encodeURIComponent(part).replace(
        /[!'()*]/g,
        (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase(),
      ),
    )
    .join('/')

export function shortestObsidianPath(
  target: string,
  paths: ReadonlySet<string>,
) {
  const parts = target.split('/')
  for (let count = 1; count <= parts.length; count++) {
    const suffix = parts.slice(-count).join('/')
    if (
      [...paths].filter(
        (path) => path === suffix || path.endsWith('/' + suffix),
      ).length === 1
    )
      return suffix
  }
  return '/' + target
}

function relativePath(from: string, target: string) {
  const parent = from.split('/').slice(0, -1),
    parts = target.split('/')
  let common = 0
  while (common < parent.length && parent[common] === parts[common]) common++
  return [...parent.slice(common).map(() => '..'), ...parts.slice(common)].join(
    '/',
  )
}

/** Normalized vault-relative file paths; callers validate their filesystem scope. */
export function obsidianLinkText(
  settings: { useMarkdownLinks: boolean; newLinkFormat: string },
  from: string,
  target: string,
  paths: ReadonlySet<string>,
  label = '',
  embed = false,
  suffix = '',
) {
  let name =
    settings.newLinkFormat === 'relative'
      ? relativePath(from, target)
      : settings.newLinkFormat === 'absolute'
        ? target
        : shortestObsidianPath(target, paths)
  // These filenames cannot be represented in wiki syntax; Markdown keeps their identity.
  if (settings.useMarkdownLinks || /[[\]|#]/.test(name)) {
    if (settings.newLinkFormat === 'absolute') name = '/' + name
    return (
      (embed ? '!' : '') +
      '[' +
      markdownLiteral(label || target.split('/').at(-1) || '') +
      '](' +
      encodeObsidianPath(name) +
      suffix +
      ')'
    )
  }
  if (name.toLowerCase().endsWith('.md')) name = name.slice(0, -3)
  const alias = label
    ? '|' +
      label.replace(/[|\]\r\n]/g, (char) => '&#' + char.charCodeAt(0) + ';')
    : ''
  return (embed ? '!' : '') + '[[' + name + suffix + alias + ']]'
}
