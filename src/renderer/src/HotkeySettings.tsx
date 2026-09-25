import { Check, RotateCcw, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  type AppCommand,
  actions,
  defaultHotkeys,
  type Hotkeys,
  shortcutError,
  shortcutFromEvent,
} from '../../shared/hotkeys'
import { IconButton } from '../../ui/Controls'
import { SettingsFilter } from '../../ui/SettingsFilter'
import { ShortcutKeys } from '../../ui/ShortcutKeys'
import { AddonHotkeySettings } from './AddonHotkeySettings'

export function HotkeySettings({
  active,
  hotkeys,
  onChange,
  platform,
}: {
  active: boolean
  hotkeys: Hotkeys
  onChange: (hotkeys: Hotkeys) => void
  platform: string
}) {
  const [query, setQuery] = useState('')
  const [recording, setRecording] = useState<AppCommand | null>(null)
  const [candidate, setCandidate] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [addonRecording, setAddonRecording] = useState(false)
  const [startingCore, setStartingCore] = useState(false)
  const recorder = useRef<HTMLButtonElement>(null)
  const activeRef = useRef(active)
  const defaults = defaultHotkeys(platform)

  useEffect(() => {
    activeRef.current = active
    return () => {
      activeRef.current = false
    }
  }, [active])

  const cancel = useCallback(() => {
    setRecording(null)
    setError('')
  }, [])
  useEffect(() => {
    if (!active) cancel()
  }, [active, cancel])

  useEffect(() => {
    if (!recording) return
    recorder.current?.focus()
    window.addEventListener('blur', cancel)
    return () => {
      window.removeEventListener('blur', cancel)
      void window.hibi.setHotkeyRecording(false)
    }
  }, [recording, cancel])

  async function save(next: Hotkeys) {
    setSaving(true)
    setError('')
    try {
      onChange(await window.hibi.saveHotkeys(next))
      setRecording(null)
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Could not save shortcuts.',
      )
    } finally {
      setSaving(false)
    }
  }

  const conflict = actions.find(
    ({ id }) => id !== recording && candidate && hotkeys[id] === candidate,
  )
  const invalid =
    shortcutError(candidate, platform, recording ?? undefined) ??
    (conflict ? `Already used by ${conflict.label}.` : '')

  return (
    <>
      <h1>Hotkeys</h1>
      <p className="settings-description">
        Select a shortcut and press the keys you want to use. Changes apply on
        this device.
      </p>
      <SettingsFilter
        id="hotkey-filter"
        label="Filter hotkeys"
        placeholder="Filter commands…"
        value={query}
        onChange={setQuery}
        disabled={!!recording || addonRecording || startingCore || saving}
        resetDisabled={actions.every(({ id }) => hotkeys[id] === defaults[id])}
        onReset={() => void save(defaults)}
      />
      <div className="settings-group hotkey-list">
        {actions
          .filter(({ label, category }) =>
            `${category} ${label}`.includes(query.toLowerCase().trim()),
          )
          .map(({ id, label, category }) => (
            <div
              className="hotkey-row"
              key={id}
              data-recording={recording === id}
            >
              <div className="hotkey-name">
                <span>{label}</span>
                <small>{category}</small>
              </div>
              <div className="hotkey-binding">
                <button
                  type="button"
                  className="hotkey-recorder"
                  id={`hotkey-${id}`}
                  ref={recording === id ? recorder : undefined}
                  aria-label={`Rebind ${label}`}
                  aria-pressed={recording === id}
                  disabled={
                    saving ||
                    addonRecording ||
                    startingCore ||
                    (!!recording && recording !== id)
                  }
                  onClick={async () => {
                    if (recording || addonRecording || startingCore) return
                    setStartingCore(true)
                    setError('')
                    try {
                      await window.hibi.setHotkeyRecording(true)
                      if (!activeRef.current) {
                        await window.hibi.setHotkeyRecording(false)
                        return
                      }
                      setCandidate('')
                      setRecording(id)
                    } catch {
                      setError('Could not record a shortcut. Try again.')
                    } finally {
                      setStartingCore(false)
                    }
                  }}
                  onKeyDown={(event) => {
                    if (recording !== id) return
                    event.preventDefault()
                    event.stopPropagation()
                    if (event.key === 'Escape') {
                      cancel()
                      return
                    }
                    if (event.key === 'Tab') {
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
                      if (candidate && !invalid)
                        void save({ ...hotkeys, [id]: candidate })
                      return
                    }
                    if (event.repeat || event.nativeEvent.isComposing) return
                    const shortcut = shortcutFromEvent(event)
                    if (shortcut) setCandidate(shortcut)
                  }}
                >
                  {recording === id ? (
                    candidate ? (
                      <ShortcutKeys shortcut={candidate} platform={platform} />
                    ) : (
                      <span>Press shortcut…</span>
                    )
                  ) : hotkeys[id] ? (
                    <ShortcutKeys shortcut={hotkeys[id]} platform={platform} />
                  ) : (
                    <span>Unassigned</span>
                  )}
                </button>
                {recording === id ? (
                  <>
                    <IconButton
                      type="button"
                      aria-label={`Save shortcut for ${label}`}
                      title="Save shortcut (Enter)"
                      disabled={
                        saving || addonRecording || !candidate || !!invalid
                      }
                      onClick={() => void save({ ...hotkeys, [id]: candidate })}
                    >
                      <Check size={15} />
                    </IconButton>
                    <IconButton
                      type="button"
                      aria-label="Cancel rebinding"
                      title="Cancel (Escape)"
                      disabled={saving || addonRecording}
                      onClick={cancel}
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
                      disabled={
                        saving ||
                        addonRecording ||
                        !!recording ||
                        hotkeys[id] === defaults[id]
                      }
                      onClick={() =>
                        void save({ ...hotkeys, [id]: defaults[id] })
                      }
                    >
                      <RotateCcw size={14} />
                    </IconButton>
                    <IconButton
                      type="button"
                      aria-label={`Clear shortcut for ${label}`}
                      title="Clear shortcut"
                      disabled={
                        saving || addonRecording || !!recording || !hotkeys[id]
                      }
                      onClick={() => void save({ ...hotkeys, [id]: '' })}
                    >
                      <X size={14} />
                    </IconButton>
                  </>
                )}
              </div>
              {recording === id && (
                <p className="hotkey-feedback" role="status">
                  {invalid || 'Enter to save · Escape to cancel'}
                </p>
              )}
            </div>
          ))}
      </div>
      <AddonHotkeySettings
        active={active}
        platform={platform}
        query={query}
        disabled={saving || !!recording || startingCore}
        onRecordingChange={setAddonRecording}
      />
      {error && (
        <p className="hotkey-feedback" role="alert">
          {error}
        </p>
      )}
      <p className="settings-description hotkey-note">
        Standard editing and window shortcuts cannot be changed.
      </p>
    </>
  )
}
