import { useState } from 'react'
import { Button, TextArea, TextInput } from '../ui'
import type { QuickNoteSettings } from './settings'
import './quick-note.css'

export function CaptureDialog({
  settings,
  save,
  close,
}: {
  settings: QuickNoteSettings
  save: (title: string, markdown: string) => Promise<void>
  close: () => void
}) {
  const [title, setTitle] = useState(settings.defaultTitle)
  const [markdown, setMarkdown] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  async function submit() {
    if (saving) return
    setSaving(true)
    setError('')
    try {
      await save(title, markdown)
      close()
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Could not save this note.',
      )
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="quick-note-form">
      {settings.promptForTitle && (
        <label htmlFor="quick-note-title">
          Title
          <TextInput
            id="quick-note-title"
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            disabled={saving}
          />
        </label>
      )}
      <label htmlFor="quick-note-body">
        Note
        <TextArea
          id="quick-note-body"
          autoFocus={!settings.promptForTitle}
          value={markdown}
          onChange={(event) => setMarkdown(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault()
              void submit()
            }
          }}
          disabled={saving}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <div className="quick-note-actions">
        <Button onClick={close} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={() => void submit()}
          disabled={saving}
        >
          {saving ? 'Saving…' : 'Save note'}
        </Button>
      </div>
    </div>
  )
}
