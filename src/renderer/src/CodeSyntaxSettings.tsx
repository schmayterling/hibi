import { Search } from 'lucide-react'
import { useState, useSyncExternalStore } from 'react'
import { Panel, PanelMessage, SettingRow, Toggle } from '../../ui/Controls'
import { SettingsFilter } from '../../ui/SettingsFilter'
import { addons } from './addons'
import { codeLanguages } from './code-languages'

export function CodeSyntaxSettings() {
  const languages = useSyncExternalStore(
    codeLanguages.subscribe,
    codeLanguages.snapshot,
  )
  const [query, setQuery] = useState('')
  const matching = languages.filter((language) =>
    [language.id, ...language.aliases, language.owner]
      .join(' ')
      .toLowerCase()
      .includes(query.toLowerCase().trim()),
  )
  return (
    <>
      <h1>Code Highlight</h1>
      <SettingsFilter
        id="code-syntax-filter"
        label="Filter languages"
        placeholder="Filter languages…"
        value={query}
        onChange={setQuery}
        resetDisabled={languages.every((language) => language.enabled)}
        onReset={codeLanguages.reset}
      />
      {[...new Set(languages.map((language) => language.owner))].map(
        (owner) => (
          <div
            key={owner}
            hidden={!matching.some((language) => language.owner === owner)}
          >
            <h2>
              {owner === 'built-in'
                ? 'Languages'
                : (addons.find((addon) => addon.manifest.id === owner)?.manifest
                    .name ?? owner.replaceAll('-', ' '))}
            </h2>
            <div className="settings-group">
              {languages
                .filter((language) => language.owner === owner)
                .map((language) => (
                  <SettingRow
                    key={language.id}
                    id={`code-syntax-${language.id}`}
                    label={language.id}
                    hidden={!matching.includes(language)}
                    description={
                      language.aliases.length
                        ? `Also applies to ${language.aliases.join(', ')}.`
                        : 'Use colors for this language in code blocks and source view.'
                    }
                  >
                    <Toggle
                      id={`code-syntax-${language.id}`}
                      checked={language.enabled}
                      onChange={(event) =>
                        codeLanguages.setEnabled(
                          language.id,
                          event.target.checked,
                        )
                      }
                    />
                  </SettingRow>
                ))}
            </div>
          </div>
        ),
      )}
      {!matching.length && (
        <Panel>
          <PanelMessage
            icon={<Search size={32} strokeWidth={1.5} />}
            title="No matching languages"
          />
        </Panel>
      )}
    </>
  )
}
