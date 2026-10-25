import { useState, useSyncExternalStore } from 'react'
import { languageNames } from '../dictionary/settings'
import { Button, Select, SettingRow, Toggle } from '../ui'
import { getControls, onControlsChange } from './runtime'
import {
  type AutocompletePreferences,
  onPreferencesChange,
  preferencesSaved,
  readPreferences,
  writePreferences,
} from './settings'

export function Settings() {
  const value = useSyncExternalStore(onPreferencesChange, readPreferences)
  const controls = useSyncExternalStore(onControlsChange, getControls)
  const [all, setAll] = useState(false)
  const [clearing, setClearing] = useState(false)
  const change = (next: Partial<AutocompletePreferences>) =>
    writePreferences({ ...value, ...next })
  const exclude = (
    key: 'excludedDocuments' | 'excludedWorkspaces',
    id: string,
    checked: boolean,
  ) =>
    change({
      [key]: checked
        ? [...new Set([...value[key], id])]
        : value[key].filter((entry) => entry !== id),
    })
  return (
    <>
      {!controls?.available && (
        <p role="status" className="setting-description">
          Enable Dictionary and thesaurus to use autocomplete. Installed offline
          packs supply the starting vocabulary.
        </p>
      )}
      {!preferencesSaved() && (
        <p role="alert" className="setting-description">
          Could not save autocomplete settings. Changes apply until Hibi
          restarts.
        </p>
      )}
      <div className="settings-group">
        <SettingRow
          id="autocomplete-suggest"
          label="Suggest words as you type"
          description="Offers completions from offline dictionaries and learned words. Nothing is sent online."
        >
          <Toggle
            id="autocomplete-suggest"
            checked={value.suggest}
            onChange={(event) => change({ suggest: event.target.checked })}
          />
        </SettingRow>
        <SettingRow
          id="autocomplete-tab-accepts"
          label="Accept suggestions with Tab"
          description="Tab accepts a suggestion when enabled. Enter accepts a highlighted word completion and starts a new paragraph for next-word suggestions. Without suggestions, Tab works as usual."
        >
          <Toggle
            id="autocomplete-tab-accepts"
            checked={value.suggest && value.tabAccepts}
            disabled={!value.suggest}
            onChange={(event) => change({ tabAccepts: event.target.checked })}
          />
        </SettingRow>
        {(['en', 'fr', 'de', 'tl'] as const).map((lang) => (
          <SettingRow
            key={lang}
            id={`autocomplete-language-${lang}`}
            label={languageNames[lang]}
            description="Include this language in suggestions. Install its offline pack in Dictionary and thesaurus settings."
          >
            <Toggle
              id={`autocomplete-language-${lang}`}
              checked={value.languages.includes(lang)}
              disabled={
                value.languages.length === 1 && value.languages.includes(lang)
              }
              onChange={(event) =>
                change({
                  languages: event.target.checked
                    ? [...value.languages, lang]
                    : value.languages.filter((entry) => entry !== lang),
                })
              }
            />
          </SettingRow>
        ))}
        <SettingRow
          id="autocomplete-learning"
          label="Learn from my writing"
          description="Remembers word counts and short word patterns from normal typing. Workspaces keep separate histories. Turning this off pauses learning and personal ranking."
        >
          <Toggle
            id="autocomplete-learning"
            checked={value.learning}
            onChange={(event) => change({ learning: event.target.checked })}
          />
        </SettingRow>
        <SettingRow
          id="autocomplete-exclude-workspace"
          label="Exclude this workspace"
          description="Stops learning and personal suggestions here. Existing learned words remain until you clear them."
        >
          <Toggle
            id="autocomplete-exclude-workspace"
            disabled={!controls?.workspaceId}
            checked={
              !!controls?.workspaceId &&
              value.excludedWorkspaces.includes(controls.workspaceId)
            }
            onChange={(event) =>
              controls?.workspaceId &&
              exclude(
                'excludedWorkspaces',
                controls.workspaceId,
                event.target.checked,
              )
            }
          />
        </SettingRow>
        <SettingRow
          id="autocomplete-exclude-document"
          label="Exclude this document"
          description="Stops learning and personal suggestions in the current document."
        >
          <Toggle
            id="autocomplete-exclude-document"
            disabled={!controls?.documentId}
            checked={
              !!controls?.documentId &&
              value.excludedDocuments.includes(controls.documentId)
            }
            onChange={(event) =>
              controls?.documentId &&
              exclude(
                'excludedDocuments',
                controls.documentId,
                event.target.checked,
              )
            }
          />
        </SettingRow>
        <SettingRow
          id="autocomplete-clear-scope"
          label="Clear learned words"
          description="Removes learned words and phrase counts from this device after confirmation. Dictionary packs and custom words are kept."
        >
          <Select
            id="autocomplete-clear-scope"
            value={all ? 'all' : 'workspace'}
            onChange={(event) => setAll(event.target.value === 'all')}
          >
            <option value="workspace">
              {controls?.workspaceId
                ? 'This workspace'
                : 'Documents outside workspaces'}
            </option>
            <option value="all">Everything</option>
          </Select>
        </SettingRow>
      </div>
      <div className="workspace-setting-actions">
        <Button
          disabled={!controls || clearing}
          onClick={async () => {
            setClearing(true)
            try {
              await controls?.clear(all)
            } finally {
              setClearing(false)
            }
          }}
        >
          Clear learned words
        </Button>
      </div>
    </>
  )
}
