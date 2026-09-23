import { CircleAlert, Puzzle, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { errorMessage } from '../../shared/errors'
import type { AddonContext } from '../api'
import { Button, ControlRow, Panel, PanelMessage, Toggle } from '../ui'
import type { InstalledObsidianPlugin } from './package'
import type { ObsidianPluginRuntime } from './runtime'
import './style.css'

export function ObsidianPluginPanel({
  context,
  runtime,
}: {
  context: AddonContext
  runtime: ObsidianPluginRuntime
}) {
  const [plugins, setPlugins] = useState<InstalledObsidianPlugin[]>([])
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const refresh = useCallback(async () => {
    try {
      setPlugins(await runtime.list())
      setError('')
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setLoading(false)
    }
  }, [runtime])
  useEffect(() => {
    void refresh()
  }, [refresh])
  async function install() {
    if (busy) return
    setBusy(true)
    try {
      await context.native.invoke('install')
      await refresh()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  async function toggle(plugin: InstalledObsidianPlugin, enabled: boolean) {
    if (busy) return
    setBusy(true)
    try {
      if (!enabled) runtime.unload(plugin.manifest.id)
      const changed = await context.native.invoke<InstalledObsidianPlugin>(
        'enable',
        { id: plugin.manifest.id, enabled },
      )
      if (enabled) await runtime.load(changed)
      await refresh()
    } catch (failure) {
      setError(errorMessage(failure))
      await refresh()
    } finally {
      setBusy(false)
    }
  }
  async function remove(plugin: InstalledObsidianPlugin) {
    if (
      busy ||
      !(await context.dialogs.confirm({
        title: `Remove ${plugin.manifest.name}?`,
        description:
          'The installed plugin and its saved settings will be moved to Trash.',
        confirmLabel: 'Remove plugin',
      }))
    )
      return
    setBusy(true)
    try {
      runtime.unload(plugin.manifest.id)
      await context.native.invoke('remove', { id: plugin.manifest.id })
      await refresh()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Panel className="obsidian-plugin-panel">
      <ControlRow>
        <Button disabled={busy} onClick={() => void install()}>
          Install plugin folder…
        </Button>
        <Button
          disabled={busy}
          title="Refresh plugins"
          onClick={() => void refresh()}
        >
          <RefreshCw size={14} aria-hidden="true" />
          Refresh
        </Button>
      </ControlRow>
      {error && <p role="alert">{error}</p>}
      {loading ? (
        <PanelMessage
          icon={<Puzzle size={24} />}
          title="Reading plugins…"
          loading
        />
      ) : !plugins.length ? (
        <PanelMessage icon={<Puzzle size={24} />} title="No plugins installed">
          Choose a folder containing an Obsidian plugin's manifest.json and
          main.js.
        </PanelMessage>
      ) : (
        <section aria-label="Obsidian plugins" className="obsidian-plugin-list">
          {plugins.map((plugin) => (
            <div className="obsidian-plugin-row" key={plugin.manifest.id}>
              <div>
                <strong>{plugin.manifest.name}</strong>
                <span> {plugin.manifest.version}</span>
                <span className="obsidian-plugin-status">
                  {plugin.enabled
                    ? runtime.isRunning(plugin.manifest.id)
                      ? 'Running'
                      : 'Not running'
                    : 'Disabled'}
                </span>
                <p>{plugin.manifest.description}</p>
                {runtime.error(plugin.manifest.id) && (
                  <p role="alert">
                    <CircleAlert size={14} aria-hidden="true" />{' '}
                    {runtime.error(plugin.manifest.id)}
                  </p>
                )}
              </div>
              <ControlRow>
                <Toggle
                  aria-label={`Enable ${plugin.manifest.name}`}
                  checked={plugin.enabled}
                  disabled={busy}
                  onChange={(event) =>
                    void toggle(plugin, event.target.checked)
                  }
                />
                {plugin.enabled && runtime.hasSettings(plugin.manifest.id) && (
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      runtime.showSettings(
                        plugin.manifest.id,
                        plugin.manifest.name,
                      )
                    }
                  >
                    Plugin settings
                  </Button>
                )}
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void remove(plugin)}
                >
                  Remove
                </Button>
              </ControlRow>
            </div>
          ))}
        </section>
      )}
    </Panel>
  )
}
