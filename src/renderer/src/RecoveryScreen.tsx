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
import {
  Component,
  type ErrorInfo,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import type { DocumentState } from '../../shared/desktop'
import { Button, IconButton } from '../../ui/Controls'
import { Modal } from '../../ui/Modal'
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
    try {
      const saved = await window.hibi.saveDocument(true)
      if (saved) {
        setDraft(saved)
        setStatus('copy saved.')
      }
    } catch {
      setStatus('could not save a copy. try again before reloading.')
    } finally {
      setBusy(false)
    }
  }
  async function copyDetails() {
    try {
      await navigator.clipboard.writeText(details)
      setCopied(true)
      setStatus('error details copied.')
    } catch {
      setStatus('could not copy details. you can select the text below.')
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
            Let’s get you back to writing.
          </h1>
          <p>
            {onBack
              ? 'This is a preview of Hibi’s recovery screen. your editor is still open underneath.'
              : 'The editor ran into an unexpected error. reload Hibi to try again.'}
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
              The latest draft received by Hibi is available in this window.
              save a copy before reloading if you need one.
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

export class RecoveryBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('render failed:', error, info.componentStack)
  }
  render() {
    return this.state.error ? (
      <RecoveryScreen error={this.state.error} />
    ) : (
      this.props.children
    )
  }
}
