import { Marked, type MarkedExtension } from 'marked'
import type { MarkdownFlavor } from '../api'

export function typstBlock(source: string) {
  const start = /^( {0,3})(`{3,}|~{3,})typst[ \t]*\r?\n/i.exec(source)
  if (!start) return
  const fence = start[2]!
  const close = new RegExp(
    `^ {0,3}${fence[0]}{${fence.length},}[ \\t]*(?:\\r?\\n|$)`,
    'm',
  ).exec(source.slice(start[0].length))
  if (!close) return
  const raw = source.slice(0, start[0].length + close.index + close[0].length)
  let code = source
    .slice(start[0].length, start[0].length + close.index)
    .replace(/\r?\n$/, '')
  if (start[1])
    code = code
      .split('\n')
      .map((line) =>
        line.startsWith(start[1]!) ? line.slice(start[1]!.length) : line,
      )
      .join('\n')
  return { type: 'typstBlock', raw, source: code }
}
export const typstTokens: MarkedExtension = {
  extensions: [{ name: 'typstBlock', level: 'block', tokenizer: typstBlock }],
}
export const detector = new Marked(typstTokens)
export const typstFlavor: MarkdownFlavor = {
  id: 'blocks',
  name: 'Typst blocks',
  kind: 'syntax',
  description: 'Preview Typst code blocks on your computer.',
  readOnlyWhenDisabled: false,
  detect(source) {
    if (!/(?:`{3}|~{3})typst/i.test(source)) return false
    let found = false
    detector.walkTokens(detector.lexer(source), (token) => {
      found ||= token.type === 'typstBlock'
    })
    return found
  },
}

export function svgSource(svg: string) {
  const bytes = new TextEncoder().encode(svg)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 32768)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768))
  return `data:image/svg+xml;base64,${btoa(binary)}`
}
