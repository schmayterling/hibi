import { Marked, type Token } from 'marked'
import { parseDocument } from 'yaml'
import { readFrontmatter } from '../../shared/frontmatter.ts'
import { tagMatches } from '../tags/syntax.ts'

const parser = new Marked({ gfm: true })

function positions(source: string) {
  const lines = [0]
  for (let offset = 0; offset < source.length; offset++)
    if (source[offset] === '\n') lines.push(offset + 1)
  const point = (offset: number) => {
    let low = 0,
      high = lines.length
    while (low + 1 < high) {
      const middle = (low + high) >> 1
      if ((lines[middle] ?? 0) <= offset) low = middle
      else high = middle
    }
    return { line: low, col: offset - (lines[low] ?? 0), offset }
  }
  return (from: number, to: number) => ({ start: point(from), end: point(to) })
}

export function obsidianMetadata(source: string) {
  const front = readFrontmatter(source)
  const body = front?.content ?? source
  const offset = front?.prefix.length ?? 0
  const position = positions(source)
  const tokens = parser.lexer(body)
  const headings: {
    heading: string
    level: number
    position: ReturnType<typeof position>
  }[] = []
  const links: {
    link: string
    original: string
    displayText: string
    position: ReturnType<typeof position>
  }[] = []
  const embeds: {
    link: string
    original: string
    displayText: string
    position: ReturnType<typeof position>
  }[] = []
  const tags: { tag: string; position: ReturnType<typeof position> }[] = []
  function visit(children: Token[], raw: string, base: number) {
    let cursor = 0
    for (const token of children) {
      const found = raw.indexOf(token.raw, cursor)
      if (found < 0) continue
      const start = base + found
      cursor = found + token.raw.length
      if (token.type === 'heading')
        headings.push({
          heading: token.text,
          level: token.depth,
          position: position(offset + start, offset + start + token.raw.length),
        })
      if (token.type === 'link' || token.type === 'image') {
        const item = {
          link: token.href,
          original: token.raw,
          displayText: token.text,
          position: position(offset + start, offset + start + token.raw.length),
        }
        if (token.type === 'image') embeds.push(item)
        else links.push(item)
        continue
      }
      if (['code', 'codespan', 'html', 'escape'].includes(token.type)) continue
      if (token.type === 'list') {
        let itemCursor = 0
        for (const item of token.items) {
          const itemFrom = token.raw.indexOf(item.raw, itemCursor)
          if (itemFrom < 0) continue
          visit(item.tokens, item.raw, start + itemFrom)
          itemCursor = itemFrom + item.raw.length
        }
      } else if ('tokens' in token && token.tokens)
        visit(token.tokens, token.raw, start)
      else if (token.type === 'text')
        for (const match of tagMatches(token.raw))
          tags.push({
            tag: `#${match.tag}`,
            position: position(
              offset + start + match.from,
              offset + start + match.to,
            ),
          })
    }
  }
  visit(tokens, body, 0)
  let frontmatter: Record<string, unknown> | undefined
  if (front) {
    try {
      const parsed = parseDocument(front.yaml).toJS()
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        frontmatter = parsed as Record<string, unknown>
    } catch {
      // Hibi keeps malformed YAML in source; plugins see no parsed properties.
    }
  }
  return {
    ...(frontmatter ? { frontmatter } : {}),
    ...(front ? { frontmatterPosition: position(0, offset) } : {}),
    headings,
    links,
    embeds,
    tags,
  }
}
