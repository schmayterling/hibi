import { mergeAttributes, Node } from '@tiptap/core'
import {
  type NodeViewProps,
  NodeViewWrapper,
  ReactNodeViewRenderer,
} from '@tiptap/react'
import { Pencil } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { errorMessage } from '../../shared/errors'
import { fencedBlock, fenceSource } from '../_shared/fenced-block'
import type { AddonContext } from '../api'
import { Button, DocumentNotice, IconButton, TextArea } from '../ui'
import { renderDiagram } from './render'

const tokenize = fencedBlock('mermaid', 'mermaidBlock')
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
export function mermaidNode(context: AddonContext) {
  function View({ node, editor, getPos, updateAttributes }: NodeViewProps) {
    const source = String(node.attrs.source ?? '')
    const scheme = useSyncExternalStore(
      context.colorschemes.subscribe,
      context.colorschemes.getActive,
    )
    const [image, setImage] = useState('')
    const [error, setError] = useState('')
    useEffect(() => {
      let active = true
      setImage('')
      setError('')
      void renderDiagram(source, scheme)
        .then((html) => {
          if (active)
            setImage(
              new DOMParser()
                .parseFromString(html, 'text/html')
                .querySelector('img')?.src ?? '',
            )
        })
        .catch((reason) => {
          if (active) setError(errorMessage(reason))
        })
      return () => {
        active = false
      }
    }, [source, scheme])
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
        {error ? (
          <DocumentNotice title="Diagram unavailable" message={error} />
        ) : image ? (
          <img className="mermaid-diagram" src={image} alt="Mermaid diagram" />
        ) : (
          <DocumentNotice title="Rendering diagram…" busy />
        )}
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
    markdownTokenName: 'mermaidBlock',
    markdownTokenizer: {
      name: 'mermaidBlock',
      level: 'block',
      start: (source) =>
        source.search(/^ {0,3}(?:`{3,}|~{3,})mermaid[ \t]*\r?$/im),
      tokenize,
    },
    parseMarkdown: (token, helpers) =>
      helpers.createNode('mermaidBlock', {
        source: token.source,
        raw: token.raw,
      }),
    renderMarkdown: (node) => {
      const source = String(node.attrs?.source ?? ''),
        raw = String(node.attrs?.raw ?? '')
      return raw && tokenize(raw)?.source === source
        ? raw.replace(/\r?\n$/, '')
        : fenceSource('mermaid', source)
    },
    addNodeView: () => ReactNodeViewRenderer(View),
  })
}
