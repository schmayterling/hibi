import { mergeAttributes, Node } from '@tiptap/core'
import {
  type NodeViewProps,
  NodeViewWrapper,
  ReactNodeViewRenderer,
} from '@tiptap/react'
import { Pencil } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { errorMessage } from '../../shared/errors'
import type { AddonContext } from '../api'
import { Button, DocumentNotice, IconButton, TextArea } from '../ui'
import { mermaidMarkdown } from './markdown'
import { mountDiagram } from './render'

function Form({
  source,
  close,
}: {
  source: string
  close: (source: string | null) => void
}) {
  const [value, setValue] = useState(source)
  return (
    <form
      className="dialog-form"
      onSubmit={(event) => {
        event.preventDefault()
        close(value)
      }}
    >
      <label htmlFor="mermaid-source">Mermaid source</label>
      <TextArea
        id="mermaid-source"
        monospace
        rows={12}
        spellCheck={false}
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <div className="dialog-actions">
        <Button onClick={() => close(null)}>Cancel</Button>
        <Button type="submit">Apply</Button>
      </div>
    </form>
  )
}
/** One diagram that fits its container's width. CSS hides the loading notice once it draws. */
export function Diagram({
  source,
  emptyText,
}: {
  source: string
  emptyText: string
}) {
  const host = useRef<HTMLElement>(null)
  const [error, setError] = useState({ source: '', message: '' })
  // Visible diagrams of loaded types draw before the first paint.
  useLayoutEffect(() => {
    if (host.current)
      return mountDiagram(host.current, source, (reason) =>
        setError({ source, message: errorMessage(reason) }),
      )
  }, [source])
  if (!source.trim())
    return <DocumentNotice title="Empty diagram" message={emptyText} />
  return (
    <>
      <figure
        ref={host}
        className="mermaid-diagram"
        aria-label="Mermaid diagram"
      />
      {error.source === source ? (
        <DocumentNotice title="Diagram unavailable" message={error.message} />
      ) : (
        <DocumentNotice title="Rendering diagram…" busy />
      )}
    </>
  )
}
export function mermaidNode(context: AddonContext) {
  function View({ node, editor, getPos, updateAttributes }: NodeViewProps) {
    const source = String(node.attrs.source ?? '')
    return (
      <NodeViewWrapper className="mermaid-block" contentEditable={false}>
        <IconButton
          aria-label="Edit Mermaid diagram"
          onClick={async () => {
            const value = await context.dialogs.open<string>({
              title: 'Edit Mermaid diagram',
              size: 'wide',
              content: ({ close }) => <Form source={source} close={close} />,
            }).result
            const position = getPos()
            if (
              value !== null &&
              !editor.isDestroyed &&
              position !== undefined &&
              editor.state.doc.nodeAt(position)?.attrs.source === source
            )
              updateAttributes({ source: value })
          }}
        >
          <Pencil size={16} />
        </IconButton>
        <Diagram
          source={source}
          emptyText="Edit this block to add Mermaid source."
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
