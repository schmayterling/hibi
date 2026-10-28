import { mergeAttributes, Node } from '@tiptap/core'
import {
  type NodeViewProps,
  NodeViewWrapper,
  ReactNodeViewRenderer,
} from '@tiptap/react'
import type { AddonContext } from '../api'
import { editMermaidSource, MermaidBlockContent } from './BlockContent'
import { mermaidMarkdown } from './markdown'

export function mermaidNode(context: AddonContext) {
  function View({ node, editor, getPos, updateAttributes }: NodeViewProps) {
    const source = String(node.attrs.source ?? '')
    return (
      <NodeViewWrapper className="mermaid-block" contentEditable={false}>
        <MermaidBlockContent
          source={source}
          onEdit={async () => {
            const value = await editMermaidSource(context, source)
            const position = getPos()
            if (
              value !== null &&
              !editor.isDestroyed &&
              position !== undefined &&
              editor.state.doc.nodeAt(position)?.attrs.source === source
            )
              updateAttributes({ source: value })
          }}
        />
      </NodeViewWrapper>
    )
  }
  return Node.create({
    name: 'mermaidBlock',
    group: 'block',
    atom: true,
    draggable: true,
    addAttributes: () => ({ source: { default: '' }, raw: { default: '' } }),
    parseHTML: () => [
      {
        tag: 'pre[data-type="mermaid-block"]',
        getAttrs: (element) => ({ source: element.textContent ?? '' }),
      },
    ],
    renderHTML: ({ node, HTMLAttributes }) => [
      'pre',
      mergeAttributes(HTMLAttributes, { 'data-type': 'mermaid-block' }),
      ['code', { class: 'language-mermaid' }, node.attrs.source],
    ],
    ...mermaidMarkdown,
    addNodeView: () => ReactNodeViewRenderer(View),
  })
}
