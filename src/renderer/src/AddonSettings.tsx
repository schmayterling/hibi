import { FileText, Search } from 'lucide-react'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { Addon, AddonManifest, AddonState } from '../../addons/api'
import { addonDefaultEnabled } from '../../shared/addon-defaults'
import { addonPackageUrl } from '../../shared/addon-package'
import { sentenceCase } from '../../shared/ui-case'
import {
  Button,
  ControlRow,
  Panel,
  PanelMessage,
  SettingRow,
  Toggle,
} from '../../ui/Controls'
import { useDialogs } from '../../ui/DialogProvider'
import { SettingsFilter } from '../../ui/SettingsFilter'
import { useToasts } from '../../ui/Sonner'
import { addonRegistry } from './addon-registry'

const AddonReadme = lazy(() => import('./AddonReadme'))

export function useAddonReadme() {
  const dialogs = useDialogs()
  return (manifest: AddonManifest) =>
    dialogs.open({
      title: manifest.name,
      size: 'wide',
      content: () => (
        <Suspense
          fallback={
            <Panel>
              <PanelMessage
                icon={<FileText size={28} />}
                title="Loading readme…"
                loading
              />
            </Panel>
          }
        >
          <AddonReadme id={manifest.id} />
        </Suspense>
      ),
    })
}

export function AddonMetadata({ manifest }: { manifest: AddonManifest }) {
  return (
    <span className="addon-metadata">
      <span>{sentenceCase(addonRegistry.origin(manifest.id))}</span>
      <span>{sentenceCase(manifest.kind ?? 'Extension')}</span>
      <span>v{manifest.version}</span>
      {manifest.authors?.map((author) => (
        <span
          key={author.discordId ?? author.github ?? author.displayName}
          data-tooltip={
            author.discordId
              ? `Discord: ${author.discordId}`
              : author.github
                ? `GitHub: ${author.github}`
                : undefined
          }
          data-discord-id={author.discordId}
        >
          {author.displayName}
          {author.role ? ` · ${author.role}` : ''}
        </span>
      ))}
    </span>
  )
}

function matches(manifest: AddonManifest, query: string) {
  return [
    manifest.name,
    manifest.description,
    manifest.kind,
    manifest.version,
    addonRegistry.origin(manifest.id),
    ...(manifest.authors?.map((author) => author.displayName) ?? []),
  ]
    .join(' ')
    .toLowerCase()
    .includes(query.trim().toLowerCase())
}

export function AddonSettings({
  addons,
  states,
  setEnabled,
  install,
  remove,
}: {
  addons: readonly Addon[]
  states: readonly AddonState[]
  setEnabled: (id: string, enabled: boolean) => Promise<void>
  install: (url?: string) => Promise<void>
  remove: (id: string) => Promise<void>
}) {
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const restoreFocus = useRef<string | null>(null)
  useEffect(() => {
    if (!busy && restoreFocus.current) {
      const control = document.getElementById(restoreFocus.current)
      if (
        document.activeElement === document.body ||
        document.activeElement === control
      )
        control?.focus({ preventScroll: true })
      restoreFocus.current = null
    }
  })
  const dialogs = useDialogs()
  const openReadme = useAddonReadme()
  const toasts = useToasts()
  const enabled = (id: string) =>
    states.some((state) => state.id === id && state.enabled)
  const defaultEnabled = (manifest: AddonManifest) =>
    addonDefaultEnabled(
      manifest.id,
      manifest.defaultEnabled,
      import.meta.env.DEV,
    )
  const changed = addons.some(
    ({ manifest }) => enabled(manifest.id) !== defaultEnabled(manifest),
  )
  const ordered = addons.toSorted(
    (a, b) =>
      a.manifest.name.localeCompare(b.manifest.name, undefined, {
        sensitivity: 'base',
      }) || a.manifest.id.localeCompare(b.manifest.id),
  )
  const matching = ordered.filter(({ manifest }) => matches(manifest, query))
  async function run(action: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    try {
      await action()
    } catch (error) {
      toasts.show({
        message: error instanceof Error ? error.message : String(error),
        variant: 'error',
      })
    } finally {
      setBusy(false)
    }
  }
  async function fromUrl() {
    const value = await dialogs.prompt({
      title: 'Install from URL',
      label: 'Addon URL',
      placeholder: 'https://example.com/addon.zip',
      description:
        'Paste an HTTPS link to a public Git repository or addon ZIP file. Only install addons you trust.',
      confirmLabel: 'Download',
      validate: (value) => {
        try {
          addonPackageUrl(value)
          return null
        } catch (error) {
          return error instanceof Error ? error.message : 'Enter an HTTPS URL.'
        }
      },
    })
    if (value !== null) await run(() => install(value))
  }
  return (
    <>
      <h1>Addon Manager</h1>
      <ControlRow className="addon-catalog-actions">
        <Button
          disabled={busy}
          onClick={() => void run(() => window.hibi.openAddonGarden())}
        >
          Hibi garden
        </Button>
        <Button disabled={busy} onClick={() => void fromUrl()}>
          Install from URL
        </Button>
        <Button
          disabled={busy}
          onClick={() => void run(() => window.hibi.openAddonsFolder())}
        >
          Open addons folder
        </Button>
      </ControlRow>
      <SettingsFilter
        id="addon-filter"
        label="Filter addons"
        placeholder="Filter addons…"
        value={query}
        onChange={setQuery}
        disabled={busy}
        resetDisabled={!changed}
        onReset={() =>
          void run(async () => {
            for (const { manifest } of addons)
              if (enabled(manifest.id) !== defaultEnabled(manifest))
                await setEnabled(manifest.id, defaultEnabled(manifest))
          })
        }
      />
      <div className="settings-group addon-list" hidden={!matching.length}>
        {ordered.map(({ manifest }) => (
          <SettingRow
            key={manifest.id}
            id={`addon-${manifest.id}`}
            label={manifest.name}
            details={{
              label: `${manifest.name} readme`,
              onOpen: () => {
                openReadme(manifest)
              },
            }}
            hidden={!matches(manifest, query)}
            description={
              <>
                {manifest.description}
                <AddonMetadata manifest={manifest} />
              </>
            }
          >
            <div className="addon-actions">
              {addonRegistry.isInstalled(manifest.id) && (
                <Button
                  disabled={busy}
                  onClick={() => void run(() => remove(manifest.id))}
                >
                  Remove
                </Button>
              )}
              {manifest.id === 'markdown' ? (
                <Toggle
                  id={`addon-${manifest.id}`}
                  aria-label={manifest.name}
                  checked
                  disabled
                />
              ) : (
                <Toggle
                  id={`addon-${manifest.id}`}
                  aria-label={manifest.name}
                  aria-describedby={`addon-${manifest.id}-description`}
                  disabled={busy}
                  checked={enabled(manifest.id)}
                  onChange={(event) => {
                    restoreFocus.current = event.target.id
                    const next = event.target.checked
                    void run(() => setEnabled(manifest.id, next))
                  }}
                />
              )}
            </div>
          </SettingRow>
        ))}
      </div>
      {!matching.length && (
        <Panel>
          <PanelMessage
            icon={<Search size={32} strokeWidth={1.5} />}
            title="No matching addons"
          />
        </Panel>
      )}
    </>
  )
}
