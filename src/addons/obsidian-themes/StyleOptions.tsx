import { useEffect, useState } from 'react'
import { Select, SettingRow, Slider, TextInput, Toggle } from '../ui'
import {
  type StyleSection,
  type StyleSetting,
  type StyleValues,
  settingKey,
} from './style-settings'

/** Controls for the options a theme describes in its `@settings` comments. */
export function StyleOptions({
  sections,
  values,
  disabled,
  onChange,
}: {
  sections: readonly StyleSection[]
  values: StyleValues
  disabled: boolean
  onChange: (values: StyleValues) => void
}) {
  // Controls change at once; the saved values replace them when they arrive.
  const [shown, setShown] = useState(values)
  useEffect(() => setShown(values), [values])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const set = (key: string, value: string | number | boolean | undefined) => {
    const next = { ...shown }
    if (value === undefined) delete next[key]
    else next[key] = value
    setShown(next)
    onChange(next)
  }
  const row = (section: StyleSection, item: StyleSetting) => {
    const key = settingKey(section.id, item.id)
    const control = `obsidian-style-${section.id}-${item.id}`
    const text = (
      value: string | number | undefined,
      commit: (draft: string) => void,
      type = 'text',
    ) => (
      <TextInput
        id={control}
        type={type}
        disabled={disabled}
        value={drafts[key] ?? (value === undefined ? '' : String(value))}
        onChange={(event) =>
          setDrafts({ ...drafts, [key]: event.target.value })
        }
        onBlur={() => {
          const draft = drafts[key]
          if (draft === undefined) return
          const { [key]: _, ...rest } = drafts
          setDrafts(rest)
          commit(draft)
        }}
      />
    )
    const props = {
      id: control,
      label: item.title,
      ...(item.description ? { description: item.description } : {}),
    }
    switch (item.type) {
      case 'heading':
        return <h4 key={key}>{item.title}</h4>
      case 'info-text':
        return (
          <p key={key}>
            {item.title}
            {item.description ? ` ${item.description}` : ''}
          </p>
        )
      case 'class-toggle':
        return (
          <SettingRow key={key} {...props}>
            <Toggle
              id={control}
              disabled={disabled}
              checked={
                typeof shown[key] === 'boolean'
                  ? (shown[key] as boolean)
                  : item.default
              }
              onChange={(event) => set(key, event.target.checked)}
            />
          </SettingRow>
        )
      case 'class-select':
      case 'variable-select':
        return (
          <SettingRow key={key} {...props}>
            <Select
              id={control}
              disabled={disabled}
              value={String(shown[key] ?? item.default)}
              onChange={(event) => set(key, event.target.value)}
            >
              {item.type === 'class-select' && item.allowEmpty && (
                <option value="">None</option>
              )}
              {item.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </SettingRow>
        )
      case 'variable-text':
        return (
          <SettingRow key={key} {...props}>
            {text((shown[key] as string | undefined) ?? item.default, (draft) =>
              set(key, draft === item.default ? undefined : draft),
            )}
          </SettingRow>
        )
      case 'variable-number':
        return (
          <SettingRow key={key} {...props}>
            {text(
              (shown[key] as number | undefined) ?? item.default,
              (draft) => {
                const value = Number(draft)
                set(key, draft && Number.isFinite(value) ? value : undefined)
              },
              'number',
            )}
          </SettingRow>
        )
      case 'variable-number-slider':
        return (
          <SettingRow key={key} {...props}>
            <Slider
              id={control}
              disabled={disabled}
              min={item.min}
              max={item.max}
              step={item.step}
              value={(shown[key] as number | undefined) ?? item.default}
              onChange={(event) => set(key, Number(event.target.value))}
            />
          </SettingRow>
        )
      case 'variable-color':
        return (
          <SettingRow key={key} {...props}>
            <TextInput
              id={control}
              type="color"
              disabled={disabled}
              value={String(shown[key] ?? item.default) || '#000000'}
              onChange={(event) => set(key, event.target.value)}
            />
          </SettingRow>
        )
      case 'variable-themed-color':
        return (
          <SettingRow key={key} {...props}>
            {(['light', 'dark'] as const).map((mode) => (
              <TextInput
                key={mode}
                id={mode === 'light' ? control : `${control}-dark`}
                type="color"
                aria-label={`${item.title} (${mode})`}
                disabled={disabled}
                value={
                  String(shown[`${key}@@${mode}`] ?? item[`default-${mode}`]) ||
                  '#000000'
                }
                onChange={(event) => set(`${key}@@${mode}`, event.target.value)}
              />
            ))}
          </SettingRow>
        )
    }
  }
  return (
    <>
      {sections.map((section) => (
        <div className="settings-group" key={section.id}>
          <h3>{section.name}</h3>
          {section.settings.map((item) => row(section, item))}
        </div>
      ))}
    </>
  )
}
