import { ChevronRight } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { errorMessage } from '../../shared/errors'
import { Button, DocumentNotice, Select, SettingRow, Toggle } from '../ui'
import type { DroppedRule } from './sanitize'
import type { InstalledTheme, Selection, Vault } from './store'

type State = {
  disabled: boolean
  vault: Vault | null
  installed: InstalledTheme[]
  selection: (Selection & { preselected: boolean }) | null
}
const id = 'obsidian-themes'

export function Settings() {
  const [state, setState] = useState<State | null>(null)
  const [theme, setTheme] = useState<string | null>(null)
  const [snippets, setSnippets] = useState<string[]>([])
  const [dropped, setDropped] = useState<DroppedRule[] | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const load = useCallback((next: State | null) => {
    if (!next) return
    setState(next)
    setTheme(next.selection?.theme ?? null)
    setSnippets(next.selection?.snippets ?? [])
  }, [])
  const run = async (action: () => Promise<void>) => {
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
  useEffect(() => {
    let active = true
    void window.hibi.queryAddon(id, 'state').then(
      (value) => active && load(value as State),
      (error: unknown) => active && setError(errorMessage(error)),
    )
    const ended = () => setPreviewing(false)
    window.addEventListener('hibi:obsidian-themes-preview', ended)
    return () => {
      active = false
      window.removeEventListener('hibi:obsidian-themes-preview', ended)
      // Leaving the page ends a preview.
      window.dispatchEvent(new CustomEvent('hibi:obsidian-themes-preview'))
    }
  }, [load])
  if (error && !state)
    return <DocumentNotice title="Could not read themes" message={error} />
  if (!state) return null
  const vault = state.vault
  const chosen = state.installed.find((item) => item.id === theme)
  const vaultTheme = vault?.themes.find(
    (item) => `vault:${item.name}` === theme,
  )
  const manifest = chosen?.manifest ?? vaultTheme?.manifest
  const save = () =>
    run(async () => {
      load(
        (await window.hibi.invokeAddon(id, 'select', {
          theme,
          snippets,
        })) as State,
      )
      setPreviewing(false)
      window.dispatchEvent(new Event('hibi:obsidian-themes-saved'))
    })
  return (
    <>
      {state.disabled && (
        <DocumentNotice
          variant="warning"
          title="Themes are off"
          message="Hibi was started with --disable-obsidian-themes, so no theme or snippet is applied until it restarts normally."
        />
      )}
      {!vault && (
        <DocumentNotice
          title="No vault open"
          message="Open an Obsidian vault to use its theme and snippets."
        />
      )}
      {state.selection?.preselected &&
        (vault?.appearance.cssTheme || snippets.length > 0) && (
          <DocumentNotice
            title="From this vault"
            message="These are the theme and snippets this vault uses in Obsidian. Apply them to use them in Hibi. Hibi keeps its own copy and never changes the vault."
          />
        )}
      <div className="settings-group">
        <SettingRow
          id="obsidian-theme"
          label="Theme"
          description={
            manifest
              ? [
                  manifest.version && `Version ${manifest.version}`,
                  manifest.author && `by ${manifest.author}`,
                  manifest.license ? 'License included' : 'No license file',
                ]
                  .filter(Boolean)
                  .join(' · ')
              : 'Light or dark follows Hibi’s appearance.'
          }
        >
          <Select
            id="obsidian-theme"
            value={theme ?? ''}
            disabled={busy}
            onChange={(event) => setTheme(event.target.value || null)}
          >
            <option value="">None</option>
            {vault?.themes.map((item) => {
              const copy = state.installed.find(
                (installed) => installed.hash === item.hash,
              )
              return (
                <option
                  key={item.name}
                  value={copy?.id ?? `vault:${item.name}`}
                >
                  {item.manifest.name}
                </option>
              )
            })}
            {state.installed
              .filter(
                (item) =>
                  !vault?.themes.some((found) => found.hash === item.hash),
              )
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.manifest.name}
                </option>
              ))}
          </Select>
          <Button
            disabled={busy}
            onClick={() =>
              run(async () => {
                const next = (await window.hibi.invokeAddon(
                  id,
                  'addFolder',
                )) as State | null
                if (next) load(next)
              })
            }
          >
            Add folder…
          </Button>
          {chosen?.source === 'folder' && (
            <Button
              disabled={busy}
              onClick={() =>
                run(async () =>
                  load(
                    (await window.hibi.invokeAddon(id, 'remove', {
                      id: chosen.id,
                    })) as State,
                  ),
                )
              }
            >
              Remove
            </Button>
          )}
        </SettingRow>
        {vault?.snippets.map((snippet) => (
          <SettingRow
            key={snippet.name}
            id={`obsidian-snippet-${snippet.name}`}
            label={`Snippet: ${snippet.name}`}
          >
            <Toggle
              id={`obsidian-snippet-${snippet.name}`}
              checked={snippets.includes(snippet.name)}
              disabled={busy}
              onChange={(event) =>
                setSnippets(
                  event.target.checked
                    ? [...snippets, snippet.name]
                    : snippets.filter((name) => name !== snippet.name),
                )
              }
            />
          </SettingRow>
        ))}
        <SettingRow
          id="obsidian-theme-actions"
          label="Apply"
          description="Preview shows the theme until you apply it or leave this page."
        >
          <Button
            disabled={busy || !vault}
            onClick={() =>
              run(async () => {
                const result = (await window.hibi.queryAddon(id, 'preview', {
                  theme,
                  snippets,
                })) as { css: string; dropped: DroppedRule[] }
                setDropped(result.dropped)
                setPreviewing(true)
                window.dispatchEvent(
                  new CustomEvent('hibi:obsidian-themes-preview', {
                    detail: result,
                  }),
                )
              })
            }
          >
            Preview
          </Button>
          {previewing && (
            <Button
              disabled={busy}
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent('hibi:obsidian-themes-preview'),
                )
              }
            >
              End preview
            </Button>
          )}
          <Button disabled={busy || !vault} onClick={save}>
            Apply
          </Button>
          <Button
            disabled={busy || !vault}
            onClick={() => {
              setTheme(null)
              setSnippets([])
              void run(async () => {
                load(
                  (await window.hibi.invokeAddon(id, 'select', {
                    theme: null,
                    snippets: [],
                  })) as State,
                )
                window.dispatchEvent(new Event('hibi:obsidian-themes-saved'))
              })
            }}
          >
            Turn off all
          </Button>
        </SettingRow>
      </div>
      {error && <DocumentNotice title="Could not apply" message={error} />}
      {dropped && (
        <details className="ui-disclosure">
          <summary>
            <ChevronRight size={14} aria-hidden />
            {dropped.length === 1
              ? '1 rule left out'
              : `${dropped.length} rules left out`}
          </summary>
          <ul>
            {dropped.map((entry, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: entries can repeat.
              <li key={index}>
                {entry.rule} — {entry.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  )
}
