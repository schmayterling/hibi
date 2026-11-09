import { useEffect, useState, useSyncExternalStore } from 'react'
import { errorMessage } from '../../shared/errors'
import { Button, DocumentNotice, SettingRow, Toggle } from '../ui'
import { chosenThemes } from './chosen'
import { type ObsidianThemesState, obsidianThemes } from './client'
import { StyleOptions } from './StyleOptions'

/** Obsidian themes inside Hibi's Appearance settings: snippets, theme options and the open folder's suggestion. */
export function Appearance() {
  const [state, setState] = useState<ObsidianThemesState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const chosen = useSyncExternalStore(chosenThemes.subscribe, chosenThemes.get)
  useEffect(() => {
    let active = true
    const load = () =>
      void obsidianThemes.state().then(
        (next) => active && setState(next),
        (error: unknown) => active && setError(errorMessage(error)),
      )
    load()
    window.addEventListener('hibi:obsidian-themes-saved', load)
    return () => {
      active = false
      window.removeEventListener('hibi:obsidian-themes-saved', load)
    }
  }, [])
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await action()
      setError('')
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  if (!state)
    return error ? (
      <DocumentNotice title="Could not read Obsidian themes" message={error} />
    ) : null
  const vault = state.vault
  const suggestedTheme = vault?.themes.find(
    (item) => item.name === vault.suggested.theme,
  )
  const offer =
    vault &&
    ((suggestedTheme && !chosen.includes(suggestedTheme.copy ?? '')) ||
      vault.suggested.snippets.some(
        (name) =>
          !state.selection.snippets.includes(
            vault.snippets.find((item) => item.name === name)?.copy ?? '',
          ),
      ))
  const sections = [
    ...state.themes
      .filter((theme) => chosen.includes(theme.id))
      .flatMap((theme) => theme.settings ?? []),
    ...state.snippets
      .filter((snippet) => state.selection.snippets.includes(snippet.hash))
      .flatMap((snippet) => snippet.settings),
  ]
  return (
    <>
      <h2>Obsidian themes</h2>
      {state.disabled && (
        <DocumentNotice
          variant="warning"
          title="Obsidian themes are off"
          message="Hibi was started with --disable-obsidian-themes, so no Obsidian theme or snippet applies until it restarts normally."
        />
      )}
      {offer && (
        <DocumentNotice
          title="This folder has an Obsidian look"
          message={`In Obsidian, this folder uses ${[
            suggestedTheme ? `the theme “${suggestedTheme.manifest.name}”` : '',
            vault.suggested.snippets.length
              ? `${vault.suggested.snippets.length === 1 ? 'one snippet' : `${vault.suggested.snippets.length} snippets`}`
              : '',
          ]
            .filter(Boolean)
            .join(
              ' and ',
            )}. Use it in Hibi too? Hibi keeps its own copy and doesn’t change the folder.`}
        >
          <Button
            disabled={busy}
            onClick={() =>
              run(async () => {
                const result = await obsidianThemes.adoptVault({
                  theme: suggestedTheme?.name ?? null,
                  snippets: vault.suggested.snippets,
                })
                if (result.theme) obsidianThemes.apply(result.theme)
              })
            }
          >
            Use it
          </Button>
        </DocumentNotice>
      )}
      <div className="settings-group">
        <SettingRow
          id="obsidian-themes-manage"
          label="Obsidian themes"
          description="Choose an Obsidian theme in the colorscheme lists above. Install more in Addon Manager."
        >
          <Button
            disabled={busy}
            onClick={() => run(() => obsidianThemes.addFolder())}
          >
            Add theme folder…
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              run(async () => {
                await obsidianThemes.setSnippets([])
                obsidianThemes.apply(null)
              })
            }
          >
            Turn off Obsidian themes
          </Button>
        </SettingRow>
        {state.snippets.map((snippet) => (
          <SettingRow
            key={snippet.hash}
            id={`obsidian-snippet-${snippet.hash.slice(0, 12)}`}
            label={`Snippet: ${snippet.name}`}
          >
            <Toggle
              id={`obsidian-snippet-${snippet.hash.slice(0, 12)}`}
              disabled={busy}
              checked={state.selection.snippets.includes(snippet.hash)}
              onChange={(event) => {
                const snippets = event.target.checked
                  ? [...state.selection.snippets, snippet.hash]
                  : state.selection.snippets.filter(
                      (hash) => hash !== snippet.hash,
                    )
                // The toggle moves at once; the saved state follows.
                setState({
                  ...state,
                  selection: { ...state.selection, snippets },
                })
                void run(() => obsidianThemes.setSnippets(snippets))
              }}
            />
            <Button
              disabled={busy}
              onClick={() =>
                run(() => obsidianThemes.removeSnippet(snippet.hash))
              }
            >
              Remove
            </Button>
          </SettingRow>
        ))}
        {vault?.snippets
          .filter((snippet) => !snippet.copy)
          .map((snippet) => (
            <SettingRow
              key={`vault-${snippet.name}`}
              id={`obsidian-vault-snippet-${snippet.hash.slice(0, 12)}`}
              label={`Snippet: ${snippet.name}`}
              description="In this folder’s Obsidian settings"
            >
              <Toggle
                id={`obsidian-vault-snippet-${snippet.hash.slice(0, 12)}`}
                disabled={busy}
                checked={false}
                onChange={() =>
                  run(() =>
                    obsidianThemes.adoptVault({ snippets: [snippet.name] }),
                  )
                }
              />
            </SettingRow>
          ))}
      </div>
      {error && (
        <DocumentNotice
          title="Could not change Obsidian themes"
          message={error}
        />
      )}
      <StyleOptions
        sections={sections}
        values={state.selection.styleValues}
        disabled={busy}
        onChange={(values) => run(() => obsidianThemes.setStyleValues(values))}
      />
    </>
  )
}
