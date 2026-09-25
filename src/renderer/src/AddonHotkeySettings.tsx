import { Check, RotateCcw, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AddonHotkeyBinding } from '../../shared/addon-hotkeys'
import { shortcutError, shortcutFromEvent } from '../../shared/hotkeys'
import { IconButton } from '../../ui/Controls'
import { ShortcutKeys } from '../../ui/ShortcutKeys'

export function AddonHotkeySettings({
  active,
  platform,
  query,
  disabled,
  onRecordingChange,
}: {
  active: boolean
  platform: string
  query: string
  disabled: boolean
  onRecordingChange: (recording: boolean) => void
}) {
  const [bindings, setBindings] = useState<AddonHotkeyBinding[]>([])
  const [recording, setRecording] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [candidate, setCandidate] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const recorder = useRef<HTMLButtonElement>(null)
  const activeRef = useRef(active)
  const starting = useRef(false)
  const generation = useRef(0)

  useEffect(() => {
    activeRef.current = active
    return () => {
      activeRef.current = false
      generation.current += 1
    }
  }, [active])

  const cancel = useCallback(() => {
    setRecording(null)
    setCandidate('')
    onRecordingChange(false)
  }, [onRecordingChange])
  useEffect(() => {
    if (!active) cancel()
  }, [active, cancel])
  useEffect(() => {
    let active = true
    void window.hibi.getAddonHotkeys().then(
      (next) => {
        if (active) setBindings(next)
      },
      (failure) => {
        if (active) setError(String(failure))
      },
    )
    const off = window.hibi.onAddonHotkeysChanged((next) => {
      if (active) setBindings(next)
    })
    return () => {
      active = false
      off()
    }
  }, [])
  useEffect(() => {
    if (!recording) return
    recorder.current?.focus()
    window.addEventListener('blur', cancel)
    return () => {
      window.removeEventListener('blur', cancel)
      void window.hibi.setHotkeyRecording(false)
    }
  }, [recording, cancel])
  useEffect(() => {
    if (recording && !bindings.some(({ id }) => id === recording)) cancel()
  }, [bindings, cancel, recording])

  async function save(id: string, shortcut: string) {
    setSaving(true)
    setError('')
    try {
      setBindings(await window.hibi.saveAddonHotkey(id, shortcut))
      cancel()
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Could not save shortcut.',
      )
    } finally {
      setSaving(false)
    }
  }

  async function reset(id: string) {
    setSaving(true)
    setError('')
    try {
      setBindings(await window.hibi.resetAddonHotkey(id))
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Could not reset shortcut.',
      )
    } finally {
      setSaving(false)
    }
  }

  const conflict = bindings.find(
    (binding) =>
      binding.id !== recording && binding.effectiveShortcut === candidate,
  )
  const invalid =
    shortcutError(candidate, platform) ??
    (conflict ? `Already used by ${conflict.label}.` : '')
  const visible = bindings.filter(({ id, label }) =>
    `${id} ${label}`.toLowerCase().includes(query.toLowerCase().trim()),
  )
  if (!visible.length)
    return error ? (
      <p className="hotkey-feedback" role="alert">
        {error}
      </p>
    ) : null

  return (
    <div className="settings-group hotkey-list">
      <h2>Addon commands</h2>
      {visible.map((binding) => (
        <div
          className="hotkey-row"
          key={binding.id}
          data-recording={recording === binding.id}
        >
          <div className="hotkey-name">
            <span>{binding.label}</span>
            <small>{binding.id}</small>
          </div>
          <div className="hotkey-binding">
            <button
              type="button"
              className="hotkey-recorder"
              ref={recording === binding.id ? recorder : undefined}
              aria-label={`Rebind ${binding.label}`}
              aria-pressed={recording === binding.id}
              disabled={
                saving ||
                disabled ||
                !!pending ||
                (!!recording && recording !== binding.id)
              }
              onClick={async () => {
                if (recording || starting.current || !activeRef.current) return
                starting.current = true
                const started = generation.current
                setPending(binding.id)
                setError('')
                onRecordingChange(true)
                try {
                  await window.hibi.setHotkeyRecording(true)
                  if (!activeRef.current || generation.current !== started) {
                    await window.hibi.setHotkeyRecording(false)
                    onRecordingChange(false)
                    return
                  }
                  setCandidate('')
                  setRecording(binding.id)
                } catch {
                  onRecordingChange(false)
                  setError('Could not record a shortcut. Try again.')
                } finally {
                  starting.current = false
                  setPending(null)
                }
              }}
              onKeyDown={(event) => {
                if (recording !== binding.id) return
                event.preventDefault()
                event.stopPropagation()
                if (event.key === 'Escape' || event.key === 'Tab') {
                  cancel()
                  return
                }
                if (
                  event.key === 'Enter' &&
                  !event.metaKey &&
                  !event.ctrlKey &&
                  !event.altKey &&
                  !event.shiftKey
                ) {
                  if (candidate && !invalid) void save(binding.id, candidate)
                  return
                }
                if (event.repeat || event.nativeEvent.isComposing) return
                const shortcut = shortcutFromEvent(event)
                if (shortcut) setCandidate(shortcut)
              }}
            >
              {pending === binding.id ? (
                <span>Preparing shortcut…</span>
              ) : recording === binding.id ? (
                candidate ? (
                  <ShortcutKeys shortcut={candidate} platform={platform} />
                ) : (
                  <span>Press shortcut…</span>
                )
              ) : binding.shortcut ? (
                <ShortcutKeys shortcut={binding.shortcut} platform={platform} />
              ) : (
                <span>Unassigned</span>
              )}
            </button>
            {recording === binding.id ? (
              <>
                <IconButton
                  type="button"
                  aria-label={`Save shortcut for ${binding.label}`}
                  title="Save shortcut"
                  disabled={saving || !candidate || !!invalid}
                  onClick={() => void save(binding.id, candidate)}
                >
                  <Check size={15} />
                </IconButton>
                <IconButton
                  type="button"
                  aria-label="Cancel rebinding"
                  title="Cancel"
                  disabled={saving}
                  onClick={cancel}
                >
                  <X size={15} />
                </IconButton>
              </>
            ) : (
              <>
                <IconButton
                  type="button"
                  aria-label={`Reset shortcut for ${binding.label}`}
                  title="Reset shortcut"
                  disabled={
                    saving ||
                    disabled ||
                    !!pending ||
                    !!recording ||
                    !binding.overridden
                  }
                  onClick={() => void reset(binding.id)}
                >
                  <RotateCcw size={14} />
                </IconButton>
                <IconButton
                  type="button"
                  aria-label={`Clear shortcut for ${binding.label}`}
                  title="Clear shortcut"
                  disabled={
                    saving ||
                    disabled ||
                    !!pending ||
                    !!recording ||
                    !binding.shortcut
                  }
                  onClick={() => void save(binding.id, '')}
                >
                  <X size={14} />
                </IconButton>
              </>
            )}
          </div>
          {recording === binding.id && (
            <p className="hotkey-feedback" role="status">
              {invalid || 'Enter to save · Escape to cancel'}
            </p>
          )}
          {!recording && binding.conflictWith && (
            <p className="hotkey-feedback" role="status">
              Already used by {binding.conflictWith.label}.
            </p>
          )}
        </div>
      ))}
      {error && (
        <p className="hotkey-feedback" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
