import { mergeAttributes, Node } from '@tiptap/core'
import {
  type NodeViewProps,
  NodeViewWrapper,
  ReactNodeViewRenderer,
} from '@tiptap/react'
import type { AddonContext } from '../api'
import { editTypstSource, TypstBlockContent } from './BlockContent'
import { typstMarkdown } from './markdown'

export function typstNode(context: AddonContext) {
  function View({ node, editor, getPos, updateAttributes }: NodeViewProps) {
    const source = String(node.attrs.source ?? '')
    async function edit() {
      const value = await editTypstSource(context, source)
      if (value === null || editor.isDestroyed) return
      const position = getPos()
      if (
        position !== undefined &&
        editor.state.doc.nodeAt(position)?.attrs.source === source
      )
        updateAttributes({ source: value })
    }
    return (
      <NodeViewWrapper className="typst-block" contentEditable={false}>
        <TypstBlockContent
          source={source}
          context={context}
          onEdit={() => void edit()}
        />
      </NodeViewWrapper>
    )
  }
  return Node.create({
    name: 'typstBlock',
    group: 'block',
    atom: true,
    draggable: true,
    addAttributes: () => ({ source: { default: '' }, raw: { default: '' } }),
    parseHTML: () => [
      {
        tag: 'pre[data-type="typst-block"]',
        getAttrs: (element) => ({ source: element.textContent ?? '' }),
      },
    ],
    renderHTML: ({ node, HTMLAttributes }) => [
      'pre',
      mergeAttributes(HTMLAttributes, { 'data-type': 'typst-block' }),
      ['code', { class: 'language-typst' }, node.attrs.source],
    ],
    ...typstMarkdown,
    addNodeView: () => ReactNodeViewRenderer(View),
  })
}
