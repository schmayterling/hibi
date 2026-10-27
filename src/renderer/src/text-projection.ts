import type { Token } from 'marked'
import type { TextProjection } from '../../shared/document-projection.ts'
import { readFrontmatter } from '../../shared/frontmatter.ts'
import { lexMarkdown } from '../../shared/marked-blocks.ts'
import { sourceText } from './source-text.ts'

/** Conservative literal spans: code, images, HTML, escapes, and generated text are omitted. */
export function textProjection(
  source: string,
  markdown: boolean,
  offset = 0,
): Pick<TextProjection, 'text' | 'spans'> {
  if (!markdown)
    return {
      text: source,
      spans: [
        {
          from: 0,
          to: source.length,
          sourceFrom: offset,
          sourceTo: offset + source.length,
        },
      ],
    }
  const metadata = readFrontmatter(source)
  if (metadata)
    return textProjection(
      metadata.content,
      true,
      offset + metadata.prefix.length,
    )
  const spans: TextProjection['spans'][number][] = []
  const original = sourceText(source)
  source = original.text
  const pieces: string[] = []
  let length = 0
  const appendLine = (text: string, sourceFrom: number) => {
    if (!text) return
    if (pieces.length) {
      pieces.push('\n')
      length++
    }
    spans.push({
      from: length,
      to: length + text.length,
      sourceFrom,
      sourceTo: sourceFrom + text.length,
    })
    pieces.push(text)
    length += text.length
  }
  const append = (text: string, position: number) => {
    let from = position - offset
    for (const line of text.split('\n')) {
      appendLine(line, offset + original.toSource(from))
      from += line.length + 1
    }
  }
  const visit = (tokens: readonly Token[], raw: string, base: number) => {
    let cursor = 0
    for (const token of tokens) {
      const at = raw.indexOf(token.raw, cursor)
      if (at < 0) continue
      cursor = at + token.raw.length
      const start = base + at
      if (['code', 'codespan', 'image', 'html', 'def'].includes(token.type))
        continue
      if (token.type === 'list') visit(token.items, token.raw, start)
      else if (token.type === 'table') {
        // Cell tokens omit the table delimiters; each candidate still carries an exact source slice.
        visit(
          [...token.header, ...token.rows.flat()].flatMap(
            (cell) => cell.tokens,
          ),
          token.raw,
          start,
        )
      } else if (
        'tokens' in token &&
        token.tokens?.length &&
        'text' in token &&
        typeof token.text === 'string'
      ) {
        const prefix =
          token.type === 'heading'
            ? (/^(?: {0,3})#{1,6}[ \t]+/.exec(token.raw)?.[0].length ?? 0)
            : token.type === 'strong' || token.type === 'del'
              ? 2
              : token.type === 'em'
                ? 1
                : token.type === 'link' && token.raw.startsWith('[')
                  ? 1
                  : token.type === 'list_item'
                    ? (/^(?: {0,3})(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/.exec(
                        token.raw,
                      )?.[0].length ?? 0)
                    : 0
        if (token.raw.slice(prefix, prefix + token.text.length) === token.text)
          visit(token.tokens, token.text, start + prefix)
      } else if (
        token.type === 'text' &&
        token.raw === token.text &&
        !/[\\&]/.test(token.raw)
      )
        append(token.text, start)
    }
  }
  visit(lexMarkdown(source), source, offset)
  return { text: pieces.join(''), spans }
}
