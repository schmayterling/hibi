import { mergeAttributes, Node } from '@tiptap/core'
import {
  type NodeViewProps,
  NodeViewWrapper,
  ReactNodeViewRenderer,
} from '@tiptap/react'
import type { AddonContext } from '../api'
import { editTypstSource, TypstBlockContent } from './BlockContent'
import { typstBlock } from './syntax'

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
    markdownTokenName: 'typstBlock',
    markdownTokenizer: {
      name: 'typstBlock',
      level: 'block',
      start: (source) =>
        source.search(/^ {0,3}(?:`{3,}|~{3,})typst[ \t]*\r?$/im),
      tokenize: typstBlock,
    },
    parseMarkdown: (token, helpers) =>
      helpers.createNode('typstBlock', {
        source: token.source,
        raw: token.raw,
      }),
    renderMarkdown: (node) => {
      const source = String(node.attrs?.source ?? '')
      const raw = String(node.attrs?.raw ?? '')
      if (raw && typstBlock(raw)?.source === source)
        return raw.replace(/\r?\n$/, '')
      const length = Math.max(
        3,
        ...Array.from(source.matchAll(/`+/g), (match) => match[0].length + 1),
      )
      const fence = '`'.repeat(length)
      return `${fence}typst\n${source}\n${fence}`
    },
    addNodeView: () => ReactNodeViewRenderer(View),
  })
}
