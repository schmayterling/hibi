import { useContext, useEffect, useState } from 'react'
import { SettingsPageVisible } from '../../ui/settings-index'
import { Button, ControlRow, SettingRow } from '../ui'
import { type PackId, type PackState, packIds, packs } from './packs'
import './pack-settings.css'
import { languageNames } from './settings'

const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`
const running = (state: PackState) =>
  state.phase === 'downloading' || state.phase === 'converting'

export function PackSettings() {
  // Discovery keeps these rows searchable without native pack reads.
  const visible = useContext(SettingsPageVisible)
  const [states, setStates] = useState<PackState[]>([])
  const [refresh, setRefresh] = useState(0)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh reloads pack state after an action.
  useEffect(() => {
    if (!visible) return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    async function read() {
      try {
        const next = (await window.hibi.queryAddon(
          'dictionary',
          'packs',
        )) as PackState[]
        if (!active) return
        setStates(next)
        if (next.some(running)) timer = setTimeout(read, 300)
      } catch {
        if (active)
          setError(
            'Could not load dictionary packs. Reopen settings to try again.',
          )
      }
    }
    void read()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [refresh, visible])
  const busy = pending || states.some(running)
  async function act(
    method: 'installPack' | 'uninstallPack' | 'cancelPack',
    id: PackId,
  ) {
    setPending(true)
    setError('')
    try {
      await window.hibi.invokeAddon('dictionary', method, id)
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Could not change this dictionary pack.',
      )
    } finally {
      setPending(false)
      setRefresh((value) => value + 1)
    }
  }
  return (
    <section className="ui-panel" aria-label="Offline language packs">
      <p className="ui-description">
        Install a language pack to look up words without an internet connection.
        Downloads come directly from each dictionary’s publisher.
      </p>
      <p className="ui-description">
        Use Update to download the latest source data. Updating keeps your
        installed pack until its replacement is ready.
      </p>
      {!states.length && !error && (
        <p role="status">Loading dictionary packs…</p>
      )}
      <div className="settings-group">
        {packIds.map((id) => {
          const pack = packs[id]
          const state = states.find((item) => item.id === id)
          const installed = state?.manifest
          const active = !!state && running(state)
          return (
            <SettingRow
              key={id}
              id={`dictionary-pack-${id}`}
              label={languageNames[id]}
              description={
                <>
                  {pack.sources
                    .map((source) => `${source.name} · ${source.license}`)
                    .join('; ')}
                  <br />
                  {`Download: about ${size(pack.sources.reduce((sum, source) => sum + source.bytes, 0))} from ${[...new Set(pack.sources.map((source) => new URL(source.url).hostname))].join(', ')}`}
                  {installed && (
                    <>
                      <br />
                      {`Installed: ${size(installed.data.bytes + installed.index.bytes)} · ${new Date(installed.installedAt).toLocaleDateString()}`}
                    </>
                  )}
                </>
              }
            >
              <div className="dictionary-pack-controls">
                <ControlRow>
                  <Button
                    id={`dictionary-pack-${id}`}
                    aria-label={`${installed ? 'Update' : 'Install'} ${languageNames[id]} pack`}
                    disabled={busy || !state}
                    onClick={() => void act('installPack', id)}
                  >
                    {installed ? 'Update' : 'Install pack'}
                  </Button>
                  {(installed || state?.phase === 'error') && (
                    <Button
                      aria-label={`Uninstall ${languageNames[id]} pack`}
                      disabled={busy}
                      onClick={() => void act('uninstallPack', id)}
                    >
                      Uninstall
                    </Button>
                  )}
                  {active && (
                    <Button
                      aria-label={`Cancel ${languageNames[id]} pack installation`}
                      disabled={pending}
                      onClick={() => void act('cancelPack', id)}
                    >
                      Cancel
                    </Button>
                  )}
                </ControlRow>
                {active && (
                  <>
                    <progress
                      aria-label={`Install ${pack.label}`}
                      max={
                        state.phase === 'downloading'
                          ? (state.total ?? undefined)
                          : undefined
                      }
                      value={
                        state.phase === 'downloading' && state.total
                          ? state.bytes
                          : undefined
                      }
                    />
                    <span role="status">
                      {state.phase === 'converting'
                        ? `Preparing pack: ${state.entries.toLocaleString()} entries…`
                        : `Downloading: ${size(state.bytes)}`}
                    </span>
                  </>
                )}
                {state?.error && <span role="alert">{state.error}</span>}
              </div>
            </SettingRow>
          )
        })}
      </div>
      {error && <p role="alert">{error}</p>}
      <p className="ui-description">
        Source credits and license notices are available in Settings → Credits.
        Synonym coverage varies by language and source.
      </p>
    </section>
  )
}
