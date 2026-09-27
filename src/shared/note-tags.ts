import type { Token } from 'marked'
import { defaultNoteSyntax, type NoteSyntax, noteLexer } from './note-syntax.ts'

export function tagMatches(text: string) {
  const matches: { from: number; to: number; tag: string }[] = []
  for (const match of text.matchAll(
    /(^|[\s([{])#([\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*)/gu,
  )) {
    const name = match[2] ?? ''
    if (!/[\p{L}_]/u.test(name)) continue
    const from = match.index + (match[1]?.length ?? 0)
    matches.push({
      from,
      to: from + name.length + 1,
      tag: name.normalize('NFC').toLowerCase(),
    })
  }
  return matches
}

export function noteTags(
  source: string,
  syntax: NoteSyntax = defaultNoteSyntax,
): string[] {
  if (!syntax.hashtags) return []
  const found = new Set<string>()
  function visit(tokens: Token[]) {
    for (const token of tokens) {
      if (
        [
          'code',
          'codespan',
          'html',
          'link',
          'image',
          'escape',
          'hibiLiteral',
          'obsidianWikiLink',
          'obsidianEmbed',
        ].includes(token.type)
      )
        continue
      if ('tokens' in token && token.tokens) visit(token.tokens)
      else if (token.type === 'text')
        for (const match of tagMatches(token.text)) found.add(match.tag)
      if (token.type === 'list')
        for (const item of token.items) visit(item.tokens)
      if (token.type === 'table')
        for (const cell of [...token.header, ...token.rows.flat()])
          visit(cell.tokens)
    }
  }
  visit(noteLexer(source, syntax).tokens)
  return [...found].sort()
}
