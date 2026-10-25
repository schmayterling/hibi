import { posix } from 'node:path'
import { Marked } from 'marked'
import {
  type ImportEntry,
  type ImportFile,
  importTextData,
} from '../../shared/imports.ts'

const decoder = new TextDecoder('utf-8', { fatal: true })
export const importText = (file: ImportEntry) =>
  decoder.decode(importTextData(file))
export const textFile = (path: string, text: string): ImportFile => ({
  path,
  data: new TextEncoder().encode(text),
})
const markdown = new Marked()

/** Keep code fences and inline code literal when translating note links. */
export function outsideCode(
  source: string,
  transform: (source: string) => string,
) {
  const normalized = source.replace(/\r\n?/g, '\n')
  const inline = (text: string) => {
    let cursor = 0,
      result = ''
    for (const match of text.matchAll(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g)) {
      result += transform(text.slice(cursor, match.index)) + match[0]
      cursor = match.index + match[0].length
    }
    return result + transform(text.slice(cursor))
  }
  let cursor = 0,
    result = ''
  for (const token of markdown.lexer(normalized)) {
    const offset = normalized.indexOf(token.raw, cursor)
    if (offset < 0) continue
    // Link definitions are kept in lexer metadata rather than its token list.
    result +=
      inline(normalized.slice(cursor, offset)) +
      (token.type === 'code' ? token.raw : inline(token.raw))
    cursor = offset + token.raw.length
  }
  return result + inline(normalized.slice(cursor))
}
export function createWikiLinkResolver(paths: readonly string[]) {
  type Match = { path: string; order: number; count: number }
  const exact = new Map<string, Match>(),
    names = new Map<string, Match>()
  const add = (index: Map<string, Match>, key: string, match: Match) => {
    const previous = index.get(key)
    if (previous) previous.count++
    else index.set(key, { ...match })
  }
  paths.forEach((path, order) => {
    const match = { path, order, count: 1 }
    add(exact, path, match)
    const keys = new Set([posix.basename(path), posix.basename(path, '.md')])
    if (/\.textbundle\/text\.md$/i.test(path))
      keys.add(posix.basename(posix.dirname(path), '.textbundle'))
    for (const key of keys) add(names, key, match)
  })
  return (file: string, directory: string) => {
    let first: Match | undefined,
      count = 0
    for (const key of new Set([
      file,
      `${file}.md`,
      posix.join(directory, file),
      posix.join(directory, `${file}.md`),
    ])) {
      const match = exact.get(key)
      if (!match) continue
      count += match.count
      if (!first || match.order < first.order) first = match
    }
    return count
      ? { path: first?.path, count }
      : (names.get(file) ?? { path: undefined, count: 0 })
  }
}
export function wikiLinks(
  source: string,
  path: string,
  resolve: ReturnType<typeof createWikiLinkResolver>,
) {
  let embeddedNotes = false,
    unresolved = false
  const directory = posix.dirname(path)
  const converted = outsideCode(source, (text) =>
    text.replace(
      /(!?)\[\[([^\]\n]+)\]\]/g,
      (raw, embed: string, body: string) => {
        const [target = '', alias] = body.split('|')
        const [file = '', heading] = target.split('#')
        const match = resolve(file, directory)
        if (file && match.count !== 1) {
          unresolved = true
          return raw
        }
        const resolved = match.path ?? path
        if (embed && /\.(md|markdown)$/i.test(resolved)) embeddedNotes = true
        const url =
          posix
            .relative(directory, resolved)
            .split('/')
            .map(encodeURIComponent)
            .join('/') + (heading ? `#${encodeURIComponent(heading)}` : '')
        const label = (
          alias ??
          (heading || posix.basename(file, '.md'))
        ).replace(/[[\]\\]/g, '\\$&')
        return `${embed && /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(resolved) ? '!' : ''}[${label}](${url})`
      },
    ),
  )
  return { source: converted, embeddedNotes, unresolved }
}
