import { defaultNoteSyntax, type NoteSyntax, noteLexer } from './note-syntax.ts'

export function wikiHref(target: string) {
  if (target.startsWith('#') && !target.startsWith('#^'))
    return `#${encodeURIComponent(target.slice(1).trim().toLowerCase().replace(/\s+/g, '-'))}`
  return `obsidian-wiki:${encodeURIComponent(target)}`
}

export function localTargetPath(from: string, href: string): string | null {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href)) return null
  let path: string
  try {
    path = decodeURIComponent(href.split(/[?#]/)[0] ?? '')
  } catch {
    return null
  }
  if (!path || path.includes('\\') || path.includes('\0')) return null
  const parts = path.startsWith('/') ? [] : from.split('/').slice(0, -1)
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length) return null
      parts.pop()
    } else parts.push(part)
  }
  return parts.join('/')
}

export function resolveLocalTarget(target: string, paths: ReadonlySet<string>) {
  if (paths.has(target)) return target
  const markdown = `${target}.md`
  return paths.has(markdown) ? markdown : null
}

export function localTarget(
  from: string,
  href: string,
  paths: ReadonlySet<string>,
) {
  const target = localTargetPath(from, href)
  return target === null ? null : resolveLocalTarget(target, paths)
}

export function wikiTargetName(target: string): string | null {
  const file = target.split('#', 1)[0]?.trim() ?? ''
  if (
    file.includes('\\') ||
    file.includes('\0') ||
    file.split('/').includes('..')
  )
    return null
  return file
}

export function resolveWikiTarget(
  from: string,
  file: string,
  paths: ReadonlySet<string>,
  basenames?: ReadonlyMap<string, readonly string[]>,
) {
  if (!file) return from
  const name = file.replace(/^\//, '')
  const candidates = name.endsWith('.md') ? [name] : [name, `${name}.md`]
  const parent = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : ''
  for (const candidate of candidates) {
    if (paths.has(candidate)) return candidate
    const beside = parent ? `${parent}/${candidate}` : candidate
    if (paths.has(beside)) return beside
  }
  if (name.includes('/')) return null
  const matches = basenames
    ? candidates.flatMap((candidate) => basenames.get(candidate) ?? [])
    : [...paths].filter((path) =>
        candidates.some((candidate) => path.split('/').at(-1) === candidate),
      )
  return matches.length === 1 ? (matches[0] ?? null) : null
}

export function wikiTarget(
  from: string,
  target: string,
  paths: ReadonlySet<string>,
  basenames?: ReadonlyMap<string, readonly string[]>,
) {
  const name = wikiTargetName(target)
  return name === null ? null : resolveWikiTarget(from, name, paths, basenames)
}

export function noteBasenames(paths: ReadonlySet<string>) {
  const basenames = new Map<string, string[]>()
  for (const path of paths) {
    const name = path.split('/').at(-1) ?? path
    const matches = basenames.get(name)
    if (matches) matches.push(path)
    else basenames.set(name, [path])
  }
  return basenames
}

export function noteReferences(
  source: string,
  syntax: NoteSyntax = defaultNoteSyntax,
  lexed?: ReturnType<typeof noteLexer>,
) {
  const links: string[] = []
  const wikilinks: string[] = []
  const { parser, tokens } = lexed ?? noteLexer(source, syntax)
  parser.walkTokens(tokens, (token) => {
    if (token.type === 'link') links.push(token.href)
    if (token.type === 'obsidianWikiLink' || token.type === 'obsidianEmbed')
      wikilinks.push(String(token.target ?? ''))
    return []
  })
  return { links, wikilinks }
}

export function noteTargets(
  source: string,
  from: string,
  paths: ReadonlySet<string>,
  references = noteReferences(source),
  basenames?: ReadonlyMap<string, readonly string[]>,
) {
  const targets = new Set<string>()
  for (const href of references.links) {
    const target = localTarget(from, href, paths)
    if (target) targets.add(target)
  }
  for (const href of references.wikilinks) {
    const target = wikiTarget(from, href, paths, basenames)
    if (target) targets.add(target)
  }
  targets.delete(from)
  return [...targets]
}
