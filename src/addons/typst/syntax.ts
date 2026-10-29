import { Marked, type MarkedExtension } from 'marked'
import { fencedBlock } from '../_shared/fenced-block.ts'
import type { MarkdownFlavor } from '../api'

export const typstBlock = fencedBlock('typst', 'typstBlock', true)
// Keep native code tokens: Marked uses their type to end lazy quote continuations.
export const typstTokens: MarkedExtension = {
  renderer: {
    code(token) {
      const block = typstBlock(token.raw)
      return block
        ? `<pre data-typst="${encodeURIComponent(token.text)}"></pre>`
        : false
    },
  },
}
export const detector = new Marked()
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
      found ||= token.type === 'code' && !!typstBlock(token.raw)
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
