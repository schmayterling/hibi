import { Marked, type Token } from 'marked'
import { readFrontmatter } from './frontmatter.ts'

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

const parser = new Marked({ gfm: true })
export function noteTags(source: string): string[] {
  const found = new Set<string>()
  function visit(tokens: Token[]) {
    for (const token of tokens) {
      if (
        ['code', 'codespan', 'html', 'link', 'image', 'escape'].includes(
          token.type,
        )
      )
        continue
      if ('tokens' in token && token.tokens) visit(token.tokens)
      else if (token.type === 'text')
        for (const match of tagMatches(token.text)) found.add(match.tag)
      if (token.type === 'list')
        for (const item of token.items) visit(item.tokens)
    }
  }
  visit(parser.lexer(readFrontmatter(source)?.content ?? source))
  return [...found].sort()
}
