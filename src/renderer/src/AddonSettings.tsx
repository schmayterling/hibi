import { FileText, Search } from 'lucide-react'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { Addon, AddonManifest, AddonState } from '../../addons/api'
import { addonDefaultEnabled } from '../../shared/addon-defaults'
import type { AddonDirectoryEntry } from '../../shared/addon-directory'
import { addonPackageUrl } from '../../shared/addon-package'
import type { AddonTrustSettings } from '../../shared/addon-trust'
import { errorMessage } from '../../shared/errors'
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
import { AddonGarden, useAddonDirectory } from './AddonGarden'
import { addonRegistry } from './addon-registry'

const AddonReadme = lazy(() => import('./AddonReadme'))

export function useAddonReadme() {
  const dialogs = useDialogs()
  return (manifest: AddonManifest) =>
    dialogs.open({
      title: manifest.name,
      preserveTitleCase: true,
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
      {addonRegistry.trust(manifest.id) === 'unsigned' && (
        <span data-tooltip="Hibi cannot confirm who made this addon.">
          Unsigned
        </span>
      )}
      {!!manifest.network?.origins.length && (
        <span>
          {`Connects to: ${manifest.network.origins.map((origin) => new URL(origin).host).join(', ')}`}
        </span>
      )}
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

function matches(
  manifest: Pick<
    AddonManifest,
    'id' | 'name' | 'description' | 'kind' | 'version' | 'authors'
  >,
  query: string,
  origin = addonRegistry.origin(manifest.id),
) {
  return [
    manifest.id,
    manifest.name,
    manifest.description,
    manifest.kind,
    manifest.version,
    origin,
    ...(manifest.authors?.map((author) => author.displayName) ?? []),
  ]
    .join(' ')
    .toLowerCase()
    .includes(query.trim().toLowerCase())
}

const categories = ['Features', 'Formats', 'Themes', 'Importers'] as const
type Category = (typeof categories)[number]

function addonCategory(
  manifest: Pick<AddonManifest, 'kind' | 'fileExtensions' | 'importer'>,
): Category {
  if (manifest.kind === 'theme') return 'Themes'
  if (manifest.fileExtensions?.length) return 'Formats'
  if (manifest.importer) return 'Importers'
  return 'Features'
}

/** A `hibi://addons/…` link: reveal an addon, or offer a Hibi garden install. */
export type AddonRequest = { id: string; install: boolean; key: number }
export type AddonInstallTarget = string | { directoryId: string }

export function AddonSettings({
  addons,
  states,
  setEnabled,
  install,
  remove,
  request,
  onRequestDone,
}: {
  addons: readonly Addon[]
  states: readonly AddonState[]
  setEnabled: (id: string, enabled: boolean) => Promise<void>
  install: (target?: AddonInstallTarget) => Promise<void>
  remove: (id: string) => Promise<void>
  request?: AddonRequest | null | undefined
  onRequestDone?: ((key: number) => void) | undefined
}) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<Category | null>(null)
  const [tab, setTab] = useState<'installed' | 'garden'>('installed')
  const [busy, setBusy] = useState(false)
  const { directory, retry } = useAddonDirectory(tab === 'garden')
  const handled = useRef<number | null>(null)
  const restoreFocus = useRef<string | null>(null)
  const categoryRow = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const panel = categoryRow.current?.closest('[role="tabpanel"]')
    const reveal = () => setCategory(null)
    panel?.addEventListener('hibi:reveal-setting', reveal)
    return () => panel?.removeEventListener('hibi:reveal-setting', reveal)
  }, [])
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
  // Revoked addons stay disabled, so Reset all leaves them alone.
  const defaultEnabled = (manifest: AddonManifest) =>
    !addonRegistry.revoked(manifest.id) &&
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
  const garden = tab === 'garden'
  const present = categories.filter((option) =>
    garden
      ? directory.entries.some((entry) => addonCategory(entry) === option)
      : addons.some(({ manifest }) => addonCategory(manifest) === option),
  )
  // Removing the last addon in a category falls back to the full list.
  const active = category && present.includes(category) ? category : null
  const shown = (manifest: AddonManifest) =>
    (!active || addonCategory(manifest) === active) && matches(manifest, query)
  const shownEntry = (entry: AddonDirectoryEntry) =>
    (!active || addonCategory(entry) === active) &&
    matches(entry, query, 'third-party')
  const matching = garden
    ? directory.entries.filter(shownEntry)
    : ordered.filter(({ manifest }) => shown(manifest))
  const relation = (entry: AddonDirectoryEntry) => {
    const current = addons.find(({ manifest }) => manifest.id === entry.id)
    if (!current) return 'new' as const
    if (!addonRegistry.isInstalled(entry.id)) return 'builtin' as const
    return current.manifest.version === entry.version
      ? ('installed' as const)
      : ('update' as const)
  }
  // Links from the website or other apps queue in main; each finishes before the next starts.
  useEffect(() => {
    if (!request || handled.current === request.key || busy) return
    const finish = () => onRequestDone?.(request.key)
    if (!request.install) {
      handled.current = request.key
      setTab('installed')
      if (!addons.some(({ manifest }) => manifest.id === request.id))
        toasts.show({
          message: `No addon with the ID "${request.id}" is installed.`,
          variant: 'error',
        })
      finish()
      return
    }
    setTab('garden')
    if (directory.status === 'idle' || directory.status === 'loading') return
    handled.current = request.key
    const entry = directory.entries.find((item) => item.id === request.id)
    // A failed load already shows its reason and a retry in the garden panel.
    if (!entry && directory.entries.length)
      toasts.show({
        message: `Hibi garden doesn't list an addon with the ID "${request.id}".`,
        variant: 'error',
      })
    if (entry && ['new', 'update'].includes(relation(entry)))
      void run(() => install({ directoryId: entry.id })).finally(finish)
    else finish()
  })
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
      <div className="addon-tabs" role="tablist" aria-label="Addon sources">
        {(
          [
            ['installed', 'Installed'],
            ['garden', 'Hibi garden'],
          ] as const
        ).map(([value, label]) => (
          <Button
            key={value}
            id={`addon-tab-${value}`}
            role="tab"
            variant="ghost"
            aria-selected={tab === value}
            aria-controls="addon-tab-panel"
            tabIndex={tab === value ? 0 : -1}
            onClick={() => setTab(value)}
            onKeyDown={(event) => {
              if (
                !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
              )
                return
              event.preventDefault()
              const next = value === 'installed' ? 'garden' : 'installed'
              const target =
                event.key === 'Home'
                  ? 'installed'
                  : event.key === 'End'
                    ? 'garden'
                    : next
              setTab(target)
              document.getElementById(`addon-tab-${target}`)?.focus()
            }}
          >
            {label}
          </Button>
        ))}
      </div>
      <ControlRow className="addon-catalog-actions">
        {garden && (
          <Button
            disabled={busy}
            onClick={() => void run(() => window.hibi.openAddonGarden())}
          >
            View on website
          </Button>
        )}
        {garden && (
          <Button
            disabled={busy || directory.status === 'loading'}
            onClick={retry}
          >
            Refresh
          </Button>
        )}
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
      <ControlRow
        ref={categoryRow}
        className="addon-categories"
        role="group"
        aria-label="Addon categories"
      >
        {[null, ...present].map((option) => (
          <Button
            key={option ?? 'all'}
            aria-pressed={active === option}
            onClick={() => setCategory(option)}
          >
            {option ?? 'All'}
          </Button>
        ))}
      </ControlRow>
      <div
        id="addon-tab-panel"
        role="tabpanel"
        aria-labelledby={`addon-tab-${tab}`}
      >
        {garden ? (
          <AddonGarden
            directory={directory}
            retry={retry}
            shown={shownEntry}
            status={relation}
            busy={busy}
            uninstall={(entry) => void run(() => remove(entry.id))}
            install={(entry) =>
              void run(() => install({ directoryId: entry.id }))
            }
          />
        ) : (
          <div className="settings-group addon-list" hidden={!matching.length}>
            {ordered.map(({ manifest }) => {
              const blockedBy =
                states.find((state) => state.id === manifest.id)?.blockedBy ??
                []
              const providers = blockedBy.map(
                (id) =>
                  addons.find((addon) => addon.manifest.id === id)?.manifest,
              )
              const retry = blockedBy.every(enabled)
              const revoked = addonRegistry.revoked(manifest.id)
              return (
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
                  hidden={!shown(manifest)}
                  description={
                    <>
                      {manifest.description}
                      <AddonMetadata manifest={manifest} />
                      {blockedBy.map((id) => {
                        const dependency = addons.find(
                          (addon) => addon.manifest.id === id,
                        )?.manifest
                        return (
                          <span className="addon-metadata" key={id}>
                            {enabled(id)
                              ? `Could not start ${dependency?.name ?? id}`
                              : `Requires ${dependency?.name ?? id}`}
                          </span>
                        )
                      })}
                      {revoked && (
                        <span className="addon-revoked">
                          {`Hibi disabled this addon because it was revoked: ${revoked.reason}`}
                        </span>
                      )}
                    </>
                  }
                >
                  <div className="addon-actions">
                    {!revoked &&
                      blockedBy.length > 0 &&
                      providers.every(Boolean) && (
                        <Button
                          disabled={busy}
                          onClick={() =>
                            void run(() => setEnabled(manifest.id, true))
                          }
                        >
                          {blockedBy.length === 1
                            ? retry
                              ? `Retry ${providers[0]?.name}`
                              : `Enable ${providers[0]?.name} too`
                            : retry
                              ? 'Retry required addons'
                              : 'Enable required addons'}
                        </Button>
                      )}
                    {addonRegistry.isInstalled(manifest.id) && (
                      <Button
                        disabled={busy}
                        onClick={() => void run(() => remove(manifest.id))}
                      >
                        Uninstall
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
                        disabled={busy || !!revoked}
                        checked={!revoked && enabled(manifest.id)}
                        onChange={(event) => {
                          restoreFocus.current = event.target.id
                          const next = event.target.checked
                          void run(() => setEnabled(manifest.id, next))
                        }}
                      />
                    )}
                  </div>
                </SettingRow>
              )
            })}
          </div>
        )}
        {!matching.length && (!garden || directory.entries.length > 0) && (
          <Panel>
            <PanelMessage
              icon={<Search size={32} strokeWidth={1.5} />}
              title="No matching addons"
            />
          </Panel>
        )}
      </div>
      <AddonSecuritySettings />
    </>
  )
}

function AddonSecuritySettings() {
  const dialogs = useDialogs()
  const [settings, setSettings] = useState<AddonTrustSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void window.hibi.getAddonTrustSettings().then(
      (next) => {
        if (active) setSettings(next)
      },
      (error) => {
        if (active) setError(errorMessage(error))
      },
    )
    return () => {
      active = false
    }
  }, [])
  async function save(changes: Partial<AddonTrustSettings>) {
    // Main validates complete settings; the toggles stay disabled until these load.
    if (!settings) return
    setSaving(true)
    setError('')
    try {
      setSettings(
        await window.hibi.setAddonTrustSettings({ ...settings, ...changes }),
      )
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }
  async function allowUnsigned(allowUnsigned: boolean) {
    if (
      allowUnsigned &&
      !(await dialogs.confirm({
        title: 'Allow unsigned addons',
        description:
          'Unsigned addons can run code with access to your documents, and Hibi cannot confirm who made them. Only install unsigned addons from people you trust.',
        confirmLabel: 'Allow unsigned addons',
        destructive: true,
      }))
    )
      return
    await save({ allowUnsigned })
  }
  return (
    <>
      <h2>Security</h2>
      <div className="settings-group">
        <SettingRow
          id="allow-unsigned-addons"
          label="Allow unsigned addons"
          description="Install addons that Hibi has not signed. Unsigned addons you already installed keep working."
        >
          <Toggle
            id="allow-unsigned-addons"
            aria-describedby="allow-unsigned-addons-description"
            checked={settings?.allowUnsigned ?? false}
            disabled={!settings || saving}
            onChange={(event) => void allowUnsigned(event.target.checked)}
          />
        </SettingRow>
        <SettingRow
          id="check-revoked-addons"
          label="Check for revoked addons"
          description="Once a day, Hibi downloads a small signed list of revoked addons and disables any you have installed. It sends no information about your addons. Turning this off stops the download, but addons already on the list stay disabled."
        >
          <Toggle
            id="check-revoked-addons"
            aria-describedby="check-revoked-addons-description"
            checked={settings?.checkRevocations ?? true}
            disabled={!settings || saving}
            onChange={(event) =>
              void save({ checkRevocations: event.target.checked })
            }
          />
        </SettingRow>
        {error && <p role="alert">{error}</p>}
      </div>
    </>
  )
}
