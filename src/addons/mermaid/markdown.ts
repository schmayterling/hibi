import type { NodeConfig } from '@tiptap/core'
import { fencedBlock, fenceSource } from '../_shared/fenced-block.ts'

const tokenize = fencedBlock('mermaid', 'mermaidBlock')

/** Diagrams are read from Marked's own mermaid code blocks, so quotes, lists
 * and paragraphs end exactly where Marked ends them. */
export const mermaidMarkdown = {
  // Ahead of the code block, which keeps every other fence.
  priority: 101,
  markdownTokenName: 'code',
  parseMarkdown: (token, helpers) =>
    token.lang?.toLowerCase() === 'mermaid'
      ? helpers.createNode('mermaidBlock', {
          source: token.text,
          raw: token.raw,
        })
      : [],
  renderMarkdown: (node) => {
    const source = String(node.attrs?.source ?? ''),
      raw = String(node.attrs?.raw ?? '')
    return raw && tokenize(raw)?.source === source
      ? raw.replace(/\r?\n$/, '')
      : fenceSource('mermaid', source)
  },
} satisfies Partial<NodeConfig>
