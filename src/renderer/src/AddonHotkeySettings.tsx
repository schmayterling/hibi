import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { AddonHotkeyBinding } from '../../shared/addon-hotkeys'
import { shortcutError } from '../../shared/hotkeys'
import { HotkeyRow } from './HotkeyRow'

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
  // Focus and stop recording in the same commit that shows or hides it, so no
  // key press or new recording can slip in between.
  useLayoutEffect(() => {
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
        <HotkeyRow
          key={binding.id}
          label={binding.label}
          detail={binding.id}
          shortcut={binding.shortcut}
          platform={platform}
          recorder={recorder}
          recording={recording === binding.id}
          pending={pending === binding.id}
          candidate={candidate}
          invalid={invalid}
          recorderDisabled={
            saving ||
            disabled ||
            !!pending ||
            (!!recording && recording !== binding.id)
          }
          actionsDisabled={saving}
          editDisabled={saving || disabled || !!pending || !!recording}
          canReset={binding.overridden}
          onStart={async () => {
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
          onCandidate={setCandidate}
          onSave={() => void save(binding.id, candidate)}
          onCancel={cancel}
          onReset={() => void reset(binding.id)}
          onClear={() => void save(binding.id, '')}
        >
          {!recording && binding.conflictWith && (
            <p className="hotkey-feedback" role="status">
              Already used by {binding.conflictWith.label}.
            </p>
          )}
        </HotkeyRow>
      ))}
      {error && (
        <p className="hotkey-feedback" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
