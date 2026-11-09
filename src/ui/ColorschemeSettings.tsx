import { useSyncExternalStore } from 'react'
import { Select, SettingRow } from './Controls'
import type { ColorschemeStore } from './colorschemes'
import './colorschemes.css'

// Ungrouped colorschemes first, then each group in the order it appears.
function groups<T extends { group?: string }>(schemes: readonly T[]) {
  const found = new Map<string, T[]>([['', []]])
  for (const scheme of schemes) {
    const group = scheme.group ?? ''
    found.set(group, [...(found.get(group) ?? []), scheme])
  }
  return [...found]
}

export function ColorschemeSettings({
  store,
  showLicense = true,
}: {
  store: ColorschemeStore
  showLicense?: boolean
}) {
  const { preferences, schemes, active } = useSyncExternalStore(
    store.subscribe,
    store.snapshot,
  )
  return (
    <div className="colorscheme-settings">
      <div className="settings-group">
        <SettingRow
          id="theme-mode"
          label="Appearance"
          description="Match your computer’s appearance or choose light or dark."
        >
          <Select
            id="theme-mode"
            value={preferences.mode}
            onChange={(event) =>
              store.set({ mode: event.target.value as typeof preferences.mode })
            }
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </Select>
        </SettingRow>
        {(['light', 'dark'] as const).map((mode) => {
          const selected = schemes.find(
            (scheme) =>
              scheme.id === preferences[mode] && scheme.appearance === mode,
          )
          return (
            <SettingRow
              key={mode}
              id={`theme-${mode}`}
              label={`${mode} colorscheme`}
              description={
                selected
                  ? `${selected.author} · ${selected.license.name}`
                  : 'Hibi is using its default colors because this theme is unavailable.'
              }
            >
              <div className="colorscheme-choice">
                {selected && (
                  <span className="colorscheme-swatches" aria-hidden="true">
                    {['background', 'surface', 'ink', 'accent'].map((key) => (
                      <span
                        key={key}
                        style={{
                          background:
                            selected.colors[
                              key as keyof typeof selected.colors
                            ],
                        }}
                      />
                    ))}
                  </span>
                )}
                <Select
                  id={`theme-${mode}`}
                  value={selected?.id ?? `hibi-${mode}`}
                  onChange={(event) =>
                    store.set({ [mode]: event.target.value })
                  }
                >
                  {groups(
                    schemes.filter((scheme) => scheme.appearance === mode),
                  ).map(([group, list]) => {
                    const options = list.map((scheme) => (
                      <option key={scheme.id} value={scheme.id}>
                        {scheme.name}
                      </option>
                    ))
                    return group ? (
                      <optgroup key={group} label={group}>
                        {options}
                      </optgroup>
                    ) : (
                      options
                    )
                  })}
                </Select>
              </div>
            </SettingRow>
          )
        })}
      </div>
      {showLicense && (
        <details className="colorscheme-license">
          <summary>{active.name} · license and credits</summary>
          <p>
            {active.author} · {active.license.name}
          </p>
          <pre>{active.license.text}</pre>
          {active.license.source && (
            <p className="colorscheme-source">{active.license.source}</p>
          )}
        </details>
      )}
    </div>
  )
}
