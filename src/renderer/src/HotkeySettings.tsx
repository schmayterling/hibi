import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import {
  type AppCommand,
  actions,
  defaultHotkeys,
  type Hotkeys,
  shortcutError,
} from '../../shared/hotkeys'
import { SettingsFilter } from '../../ui/SettingsFilter'
import { AddonHotkeySettings } from './AddonHotkeySettings'
import { HotkeyRow } from './HotkeyRow'

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
            `${category} ${label}`
              .toLowerCase()
              .includes(query.toLowerCase().trim()),
          )
          .map(({ id, label, category }) => (
            <HotkeyRow
              key={id}
              recorderId={`hotkey-${id}`}
              label={label}
              detail={category}
              shortcut={hotkeys[id]}
              platform={platform}
              recorder={recorder}
              recording={recording === id}
              candidate={candidate}
              invalid={invalid}
              keyHints
              recorderDisabled={
                saving ||
                addonRecording ||
                startingCore ||
                (!!recording && recording !== id)
              }
              actionsDisabled={saving || addonRecording}
              editDisabled={saving || addonRecording || !!recording}
              canReset={hotkeys[id] !== defaults[id]}
              onStart={async () => {
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
              onCandidate={setCandidate}
              onSave={() => void save({ ...hotkeys, [id]: candidate })}
              onCancel={cancel}
              onReset={() => void save({ ...hotkeys, [id]: defaults[id] })}
              onClear={() => void save({ ...hotkeys, [id]: '' })}
            />
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
