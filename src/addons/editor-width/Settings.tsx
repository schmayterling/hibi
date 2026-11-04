import { useEffect, useState } from 'react'
import { DocumentNotice, SettingRow, TextInput, Toggle } from '../ui'
import {
  getPreferences,
  onPreferencesChange,
  setPreferences,
  validUnit,
} from './preferences'

export function Settings() {
  const [preferences, update] = useState(getPreferences)
  useEffect(() => onPreferencesChange(() => update(getPreferences())), [])
  const [draft, setDraft] = useState(() => {
    const preferences = getPreferences()
    return {
      minimum: String(preferences.minimum),
      maximum: String(preferences.maximum),
      unit: preferences.unit,
    }
  })
  const [error, setError] = useState('')
  const save = () => {
    const minimum = Number(draft.minimum)
    const maximum = Number(draft.maximum)
    const unit = draft.unit.trim().toLowerCase()
    if (
      !draft.minimum.trim() ||
      !draft.maximum.trim() ||
      !Number.isFinite(minimum) ||
      !Number.isFinite(maximum) ||
      minimum < 0 ||
      maximum <= minimum
    ) {
      setError('Enter a nonnegative minimum and a maximum greater than it.')
      return
    }
    if (!validUnit(unit)) {
      setError('Enter a supported CSS length unit, such as px, rem, ch, or vw.')
      return
    }
    setPreferences({ minimum, maximum, unit })
    setDraft({ minimum: String(minimum), maximum: String(maximum), unit })
    setError('')
  }
  return (
    <>
      <div className="settings-group">
        {(
          [
            [
              'minimum',
              'Minimum width',
              'The smallest value offered by the slider.',
            ],
            [
              'maximum',
              'Maximum width',
              'The largest value offered by the slider.',
            ],
            [
              'unit',
              'Width unit',
              'Use any supported CSS length unit, such as px, rem, ch, vw, or %. The same unit applies to both limits and the chosen width.',
            ],
          ] as const
        ).map(([field, label, description]) => (
          <SettingRow
            key={field}
            id={`editor-width-${field}`}
            label={label}
            description={description}
          >
            <div className="setting-controls">
              <TextInput
                id={`editor-width-${field}`}
                type={field === 'unit' ? 'text' : 'number'}
                min={field === 'unit' ? undefined : 0}
                step="any"
                spellCheck={false}
                value={draft[field]}
                aria-invalid={!!error}
                aria-describedby={
                  error
                    ? 'editor-width-settings-error'
                    : `editor-width-${field}-description`
                }
                onChange={(event) => {
                  setDraft({ ...draft, [field]: event.currentTarget.value })
                  setError('')
                }}
                onBlur={save}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    save()
                  }
                }}
              />
            </div>
          </SettingRow>
        ))}
      </div>
      <div className="settings-group">
        {(
          [
            [
              'showSlider',
              'Show width slider',
              'Show the editor width slider in the status bar.',
            ],
            [
              'showToggle',
              'Show width toggle',
              'Show the width cap switch in the status bar. You can also assign Toggle editor width a shortcut in Settings → Hotkeys.',
            ],
          ] as const
        ).map(([field, label, description]) => (
          <SettingRow
            key={field}
            id={`editor-width-${field}`}
            label={label}
            description={description}
          >
            <Toggle
              id={`editor-width-${field}`}
              checked={preferences[field]}
              onChange={(event) =>
                setPreferences({ [field]: event.currentTarget.checked })
              }
            />
          </SettingRow>
        ))}
      </div>
      {error && (
        <div id="editor-width-settings-error">
          <DocumentNotice
            variant="warning"
            title="Invalid width limits"
            message={error}
          />
        </div>
      )}
    </>
  )
}
