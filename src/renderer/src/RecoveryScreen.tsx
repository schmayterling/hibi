import {
  ArrowLeft,
  Check,
  Copy,
  File,
  FileWarning,
  RotateCcw,
  Save,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DocumentState } from '../../shared/desktop'
import { Button, IconButton } from '../../ui/Controls'
import { Modal } from '../../ui/Modal'
import { documentRuntime } from './document-runtime'
import './recovery.css'

export function RecoveryScreen({
  error,
  onBack,
}: {
  error: Error
  onBack?: () => void
}) {
  const [draft, setDraft] = useState<DocumentState | null>(null)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (!onBack) heading.current?.focus()
  }, [onBack])
  const details = error.stack || `${error.name}: ${error.message}`
  useEffect(() => {
    let active = true
    void Promise.resolve()
      .then(() => window.hibi?.getDocument())
      .then((value) => {
        if (active && value) setDraft(value)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])
  async function saveCopy() {
    setBusy(true)
    setStatus('')
    const token = documentRuntime.beginSave(draft?.tabId)
    try {
      const saved = await window.hibi.saveDocument(true)
      if (saved) {
        const owned = token
          ? documentRuntime.acknowledgeSave(saved, token, draft?.id)
          : null
        setDraft(owned ?? (await window.hibi.getDocument().catch(() => draft)))
        setStatus('Copy saved.')
      }
    } catch {
      setStatus('Could not save a copy. Try again before reloading.')
    } finally {
      documentRuntime.endSave(token)
      setBusy(false)
    }
  }
  async function copyDetails() {
    try {
      await window.hibi.writeClipboardText(details)
      setCopied(true)
      setStatus('Error details copied.')
    } catch {
      setStatus('Could not copy details. Select and copy the text above.')
    }
  }
  return (
    <main
      className="recovery-screen"
      aria-label={onBack ? 'Recovery screen preview' : 'Editor recovery'}
    >
      <header className="recovery-chrome">
        <span>Hibi</span>
        {onBack && <span>Preview</span>}
      </header>
      <div className="recovery-body">
        <section className="recovery-content" aria-labelledby="recovery-title">
          <FileWarning
            className="recovery-icon"
            size={44}
            strokeWidth={1.25}
            aria-hidden
          />
          <h1 id="recovery-title" ref={heading} tabIndex={-1}>
            The editor stopped working
          </h1>
          <p>
            {onBack
              ? 'This is a preview. Your document is still open.'
              : 'Reload Hibi to reopen the editor.'}
          </p>
          {draft && (
            <div className="recovery-draft">
              <File size={16} aria-hidden />
              <span>{draft.name}</span>
              <span>
                {draft.dirty ? 'Unsaved draft available' : 'Document available'}
              </span>
            </div>
          )}
          {!onBack && draft?.dirty && (
            <p className="recovery-hint">
              Save a copy of your recovered draft before reloading.
            </p>
          )}
          <div className="recovery-actions">
            {onBack ? (
              <Button onClick={onBack}>
                <ArrowLeft />
                Back to settings
              </Button>
            ) : (
              <>
                <Button
                  className="dialog-primary"
                  disabled={busy}
                  onClick={() => location.reload()}
                >
                  <RotateCcw />
                  Reload Hibi
                </Button>
                <Button
                  disabled={busy || !draft}
                  onClick={() => void saveCopy()}
                >
                  <Save />
                  {busy ? 'Saving…' : 'Save a copy'}
                </Button>
              </>
            )}
          </div>
          <Button
            variant="ghost"
            className="recovery-details-trigger"
            aria-haspopup="dialog"
            onClick={() => {
              setCopied(false)
              setStatus('')
              setDetailsOpen(true)
            }}
          >
            Error details
          </Button>
          <p className="recovery-status" role="status">
            {status}
          </p>
        </section>
      </div>
      {detailsOpen &&
        createPortal(
          <Modal
            className="app-dialog recovery-details"
            data-size="wide"
            aria-label="Error details"
            onDismiss={() => setDetailsOpen(false)}
          >
            <header className="dialog-heading">
              <div className="dialog-title-row">
                <h2>Error details</h2>
                <IconButton
                  aria-label="Close error details"
                  onClick={() => setDetailsOpen(false)}
                >
                  <X />
                </IconButton>
              </div>
            </header>
            <div className="dialog-content">
              <pre>{details}</pre>
              <p role="status">{status}</p>
            </div>
            <footer className="dialog-footer">
              <Button onClick={() => void copyDetails()}>
                {copied ? <Check /> : <Copy />}
                {copied ? 'Copied' : 'Copy details'}
              </Button>
            </footer>
          </Modal>,
          document.body,
        )}
    </main>
  )
}
