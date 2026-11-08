import { useSyncExternalStore } from 'react'
import { Button, SettingRow, Toggle } from '../ui'
import { hostSnapshot, pluginAction, subscribeHost } from './host'

export default function Panel() {
  const { host, installed, discovered, error, busy } = useSyncExternalStore(
    subscribeHost,
    hostSnapshot,
  )
  return (
    <div className="hibi-obsidian settings-group">
      <p>
        Install only plugins you trust. Plugins run code inside Hibi and can
        read or change your notes and interface. Desktop-only plugins are not
        supported.
      </p>
      <p>
        Hibi keeps plugin copies and settings in its app data for this vault.
        Your .obsidian folder stays unchanged.
      </p>
      {!host ? (
        <p>Open a vault folder to manage its plugins.</p>
      ) : (
        <>
          <div className="setting-controls">
            <Button
              disabled={busy}
              onClick={() => void pluginAction('install')}
            >
              Install from folder
            </Button>
            <Button
              disabled={busy}
              onClick={() => void pluginAction('refresh')}
            >
              Refresh
            </Button>
          </div>
          {installed.length === 0 && (
            <p>No plugins installed for this vault.</p>
          )}
          {installed.map((plugin) => (
            <SettingRow
              key={plugin.manifest.id}
              id={`obsidian-${plugin.manifest.id}`}
              label={plugin.manifest.name}
              description={
                host.errors.get(plugin.manifest.id) ||
                plugin.manifest.description
              }
            >
              <Toggle
                aria-label={`Enable ${plugin.manifest.name}`}
                checked={plugin.enabled}
                disabled={busy}
                onChange={(event) =>
                  void pluginAction('enable', {
                    id: plugin.manifest.id,
                    enabled: event.target.checked,
                  })
                }
              />
              <Button
                disabled={busy || plugin.enabled}
                onClick={() =>
                  void pluginAction('remove', { id: plugin.manifest.id })
                }
              >
                Remove
              </Button>
            </SettingRow>
          ))}
          {discovered.length > 0 && <h3>Found in this vault</h3>}
          {discovered.map((plugin) => (
            <SettingRow
              key={plugin.id}
              id={`obsidian-discovered-${plugin.id}`}
              label={plugin.name}
              description={
                plugin.error ||
                'Install a separate copy in Hibi. The vault copy will stay unchanged.'
              }
            >
              <Button
                disabled={busy || !!plugin.error}
                onClick={() =>
                  void pluginAction('installVault', { id: plugin.id })
                }
              >
                Install copy
              </Button>
            </SettingRow>
          ))}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
