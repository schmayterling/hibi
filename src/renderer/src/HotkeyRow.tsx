import { Check, RotateCcw, X } from 'lucide-react'
import type { ReactNode, RefObject } from 'react'
import { shortcutFromEvent } from '../../shared/hotkeys'
import { IconButton } from '../../ui/Controls'
import { ShortcutKeys } from '../../ui/ShortcutKeys'

/** One shortcut row: the recorder button, its save, cancel, reset and clear actions, and feedback. */
export function HotkeyRow({
  recorderId,
  label,
  detail,
  shortcut,
  platform,
  recorder,
  recording,
  pending = false,
  candidate,
  invalid,
  keyHints = false,
  recorderDisabled,
  actionsDisabled,
  editDisabled,
  canReset,
  onStart,
  onCandidate,
  onSave,
  onCancel,
  onReset,
  onClear,
  children,
}: {
  recorderId?: string
  label: string
  detail: string
  shortcut: string
  platform: string
  recorder: RefObject<HTMLButtonElement | null>
  recording: boolean
  pending?: boolean
  candidate: string
  invalid: string
  keyHints?: boolean
  recorderDisabled: boolean
  actionsDisabled: boolean
  editDisabled: boolean
  canReset: boolean
  onStart: () => void
  onCandidate: (shortcut: string) => void
  onSave: () => void
  onCancel: () => void
  onReset: () => void
  onClear: () => void
  children?: ReactNode
}) {
  return (
    <div className="hotkey-row" data-recording={recording}>
      <div className="hotkey-name">
        <span>{label}</span>
        <small>{detail}</small>
      </div>
      <div className="hotkey-binding">
        <button
          type="button"
          className="hotkey-recorder"
          id={recorderId}
          ref={recording ? recorder : undefined}
          aria-label={`Rebind ${label}`}
          aria-pressed={recording}
          disabled={recorderDisabled}
          onClick={onStart}
          onKeyDown={(event) => {
            if (!recording) return
            event.preventDefault()
            event.stopPropagation()
            if (event.key === 'Escape' || event.key === 'Tab') {
              onCancel()
              return
            }
            if (
              event.key === 'Enter' &&
              !event.metaKey &&
              !event.ctrlKey &&
              !event.altKey &&
              !event.shiftKey
            ) {
              if (candidate && !invalid) onSave()
              return
            }
            if (event.repeat || event.nativeEvent.isComposing) return
            const next = shortcutFromEvent(event)
            if (next) onCandidate(next)
          }}
        >
          {pending ? (
            <span>Preparing shortcut…</span>
          ) : recording ? (
            candidate ? (
              <ShortcutKeys shortcut={candidate} platform={platform} />
            ) : (
              <span>Press shortcut…</span>
            )
          ) : shortcut ? (
            <ShortcutKeys shortcut={shortcut} platform={platform} />
          ) : (
            <span>Unassigned</span>
          )}
        </button>
        {recording ? (
          <>
            <IconButton
              type="button"
              aria-label={`Save shortcut for ${label}`}
              title={keyHints ? 'Save shortcut (Enter)' : 'Save shortcut'}
              disabled={actionsDisabled || !candidate || !!invalid}
              onClick={onSave}
            >
              <Check size={15} />
            </IconButton>
            <IconButton
              type="button"
              aria-label="Cancel rebinding"
              title={keyHints ? 'Cancel (Escape)' : 'Cancel'}
              disabled={actionsDisabled}
              onClick={onCancel}
            >
              <X size={15} />
            </IconButton>
          </>
        ) : (
          <>
            <IconButton
              type="button"
              aria-label={`Reset shortcut for ${label}`}
              title="Reset shortcut"
              disabled={editDisabled || !canReset}
              onClick={onReset}
            >
              <RotateCcw size={14} />
            </IconButton>
            <IconButton
              type="button"
              aria-label={`Clear shortcut for ${label}`}
              title="Clear shortcut"
              disabled={editDisabled || !shortcut}
              onClick={onClear}
            >
              <X size={14} />
            </IconButton>
          </>
        )}
      </div>
      {recording && (
        <p className="hotkey-feedback" role="status">
          {invalid || 'Enter to save · Escape to cancel'}
        </p>
      )}
      {children}
    </div>
  )
}
