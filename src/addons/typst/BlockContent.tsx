import { FileDown, Pencil } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { AddonContext } from '../api'
import { Button, IconButton, TextArea } from '../ui'
import { TypstPreview } from './Preview'
import { systemCompilerEnabled } from './preferences'

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

/** Ask for changed Typst block source; resolves to null when canceled. */
export function editTypstSource(context: AddonContext, source: string) {
  return context.dialogs.open<string>({
    title: 'Edit Typst block',
    size: 'wide',
    content: ({ close }) => <TypstForm source={source} close={close} />,
  }).result
}

/** A Typst block's heading actions and preview, in either formatted view. */
export function TypstBlockContent({
  source,
  context,
  onEdit,
}: {
  source: string
  context: AddonContext
  onEdit: () => void
}) {
  const documentId = useSyncExternalStore(
    context.editor.onDocumentChange,
    () => context.editor.getDocument()?.id,
  )
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
    <>
      <div className="typst-block-heading">
        <span>Typst</span>
        <div>
          <IconButton aria-label="Edit Typst block" onClick={onEdit}>
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
    </>
  )
}
