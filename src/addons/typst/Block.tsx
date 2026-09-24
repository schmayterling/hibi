import { mergeAttributes, Node } from '@tiptap/core'
import {
  type NodeViewProps,
  NodeViewWrapper,
  ReactNodeViewRenderer,
} from '@tiptap/react'
import { FileDown, Pencil } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { AddonContext } from '../api'
import { Button, IconButton, TextArea } from '../ui'
import { TypstPreview } from './Preview'
import { systemCompilerEnabled } from './preferences'
import { typstBlock } from './syntax'

function TypstForm({
  source,
  close,
}: {
  source: string
  close: (source: string | null) => void
}) {
  const [value, setValue] = useState(source)
  const input = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    input.current?.focus()
  }, [])
  return (
    <form
      className="dialog-form"
      onSubmit={(event) => {
        event.preventDefault()
        close(value)
      }}
    >
      <label htmlFor="typst-source">Typst source</label>
      <TextArea
        monospace
        id="typst-source"
        ref={input}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        rows={12}
        spellCheck={false}
      />
      <div className="dialog-actions">
        <Button onClick={() => close(null)}>Cancel</Button>
        <Button type="submit">Apply</Button>
      </div>
    </form>
  )
}

export function typstNode(context: AddonContext) {
  function View({ node, editor, getPos, updateAttributes }: NodeViewProps) {
    const source = String(node.attrs.source ?? '')
    const documentId = useSyncExternalStore(
      context.editor.onDocumentChange,
      () => context.editor.getDocument()?.id,
    )
    async function edit() {
      const value = await context.dialogs.open<string>({
        title: 'Edit Typst block',
        size: 'wide',
        content: ({ close }) => <TypstForm source={source} close={close} />,
      }).result
      if (value === null || editor.isDestroyed) return
      const position = getPos()
      if (
        position !== undefined &&
        editor.state.doc.nodeAt(position)?.attrs.source === source
      )
        updateAttributes({ source: value })
    }
    async function pdf() {
      try {
        const path = await context.native.invoke<string | null>('pdf', {
          source,
          documentId,
          block: true,
          compiler: systemCompilerEnabled() ? 'system' : 'bundled',
        })
        if (path) context.notify(`Exported PDF to ${path}`)
      } catch (error) {
        context.toasts.show({
          message:
            error instanceof Error ? error.message : 'Could not export Typst.',
          variant: 'error',
        })
      }
    }
    return (
      <NodeViewWrapper className="typst-block" contentEditable={false}>
        <div className="typst-block-heading">
          <span>Typst</span>
          <div>
            <IconButton
              aria-label="Edit Typst block"
              onClick={() => void edit()}
            >
              <Pencil size={16} />
            </IconButton>
            <IconButton
              aria-label="Export Typst block PDF"
              onClick={() => void pdf()}
            >
              <FileDown size={16} />
            </IconButton>
          </div>
        </div>
        <TypstPreview
          value={source}
          documentId={documentId}
          context={context}
          block
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
