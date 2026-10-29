import type { MarkedExtension } from 'marked'
import { commonMarkFences } from '../../shared/marked-fences.ts'
import { fencedBlock } from '../_shared/fenced-block.ts'

export const typstBlock = fencedBlock('typst', 'typstBlock', true)
// Keep native code tokens: Marked uses their type to end lazy quote continuations.
export const typstTokens: MarkedExtension = {
  ...commonMarkFences,
  renderer: {
    code(token) {
      const block = typstBlock(token.raw)
      return block
        ? `<pre data-typst="${encodeURIComponent(token.text)}"></pre>`
        : false
    },
  },
}
export { detector, typstFlavor } from './flavor-info.ts'

export function svgSource(svg: string) {
  const bytes = new TextEncoder().encode(svg)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 32768)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768))
  return `data:image/svg+xml;base64,${btoa(binary)}`
}
