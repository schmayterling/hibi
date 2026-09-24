import { Marked } from 'marked'
import { readFrontmatter } from './frontmatter.ts'

const parser = new Marked({ gfm: true })
const wiki = /!?\[\[([^\]\r\n]+)\]\]/g

export function wikiHref(target: string) {
  if (target.startsWith('#') && !target.startsWith('#^'))
    return `#${encodeURIComponent(target.slice(1).trim().toLowerCase().replace(/\s+/g, '-'))}`
  return `obsidian-wiki:${encodeURIComponent(target)}`
}

export function localTarget(
  from: string,
  href: string,
  paths: ReadonlySet<string>,
) {
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
  const target = parts.join('/')
  if (paths.has(target)) return target
  const markdown = `${target}.md`
  return paths.has(markdown) ? markdown : null
}

export function wikiTarget(
  from: string,
  target: string,
  paths: ReadonlySet<string>,
) {
  const file = target.split('#')[0]?.trim() ?? ''
  if (!file) return from
  if (
    file.includes('\\') ||
    file.includes('\0') ||
    file.split('/').includes('..')
  )
    return null
  const name = file.replace(/^\//, '')
  const candidates = name.endsWith('.md') ? [name] : [name, `${name}.md`]
  const parent = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : ''
  for (const candidate of candidates) {
    if (paths.has(candidate)) return candidate
    const beside = parent ? `${parent}/${candidate}` : candidate
    if (paths.has(beside)) return beside
  }
  if (name.includes('/')) return null
  const matches = [...paths].filter((path) =>
    candidates.some((candidate) => path.split('/').at(-1) === candidate),
  )
  return matches.length === 1 ? (matches[0] ?? null) : null
}

export function noteReferences(source: string) {
  const links: string[] = []
  const wikilinks: string[] = []
  const body = readFrontmatter(source)?.content ?? source
  parser.walkTokens(parser.lexer(body), (token) => {
    if (token.type === 'link') links.push(token.href)
    if (token.type === 'text')
      for (const match of token.raw.matchAll(wiki))
        wikilinks.push((match[1] ?? '').split('|')[0] ?? '')
    return []
  })
  return { links, wikilinks }
}

export function noteTargets(
  source: string,
  from: string,
  paths: ReadonlySet<string>,
  references = noteReferences(source),
) {
  const targets = new Set<string>()
  for (const href of references.links) {
    const target = localTarget(from, href, paths)
    if (target) targets.add(target)
  }
  for (const href of references.wikilinks) {
    const target = wikiTarget(from, href, paths)
    if (target) targets.add(target)
  }
  targets.delete(from)
  return [...targets]
}
