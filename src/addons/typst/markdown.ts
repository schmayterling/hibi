import type { NodeConfig } from '@tiptap/core'
import { fenceSource } from '../_shared/fenced-block.ts'
import { typstBlock } from './syntax.ts'

export const typstMarkdown = {
  priority: 101,
  markdownTokenName: 'code',
  parseMarkdown: (token, helpers) => {
    const block = typstBlock(token.raw ?? '')
    return block
      ? helpers.createNode('typstBlock', { source: token.text, raw: token.raw })
      : []
  },
  renderMarkdown: (node) => {
    const source = String(node.attrs?.source ?? ''),
      raw = String(node.attrs?.raw ?? '')
    return raw && typstBlock(raw)?.source === source
      ? raw.replace(/\r?\n$/, '')
      : fenceSource('typst', source)
  },
} satisfies Partial<NodeConfig>
