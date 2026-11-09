import { FileText } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import {
  AddonCatalogRow,
  AddonCatalogToolbar,
  AddonDirectoryStatus,
  NoMatchingAddons,
} from '../../renderer/src/AddonGarden'
import AddonReadme from '../../renderer/src/AddonReadme'
import { colorschemes } from '../../renderer/src/colorschemes'
import { settingsPages } from '../../renderer/src/settings-pages'
import { errorMessage } from '../../shared/errors'
import {
  Button,
  ControlRow,
  Panel,
  PanelMessage,
  Select,
  Toggle,
} from '../../ui/Controls'
import { useDialogs } from '../../ui/DialogProvider'
import { obsidianThemes, schemeIds } from '../obsidian-themes/client'
import type { InstalledTheme } from '../obsidian-themes/store'
import { pluginResourcePrefix } from './api/registry'
import {
  type CommunityDetails,
  type CommunityDirectory,
  type CommunityEntry,
  filterCommunityEntries,
} from './community-types'
import {
  cancelInstall,
  changed,
  installCommunity,
  type ManagerProps,
  useObsidianInventory,
} from './manager'

type Inventory = ReturnType<typeof useObsidianInventory>
const keyOf = (entry: CommunityEntry) => entry.kind + ':' + entry.id
function installedEntry(entry: CommunityEntry, inventory: Inventory) {
  return entry.kind === 'plugin'
    ? inventory.plugins.find((plugin) => plugin.manifest.id === entry.id)
    : inventory.themes.find(
        (theme) =>
          theme.repository === entry.repo || theme.manifest.name === entry.name,
      )
}
function newer(
  entry: CommunityEntry,
  inventory: Inventory,
  details?: CommunityDetails,
) {
  const current = installedEntry(entry, inventory)
  if (
    entry.kind === 'theme' &&
    details?.release &&
    inventory.themes.some(
      (theme) =>
        theme.repository === entry.repo &&
        (theme.ref === details.release || theme.commit === details.release),
    )
  )
    return false
  const release =
    current &&
    ('source' in current && typeof current.source === 'object'
      ? current.source.release
      : 'ref' in current
        ? (current.commit ?? current.ref)
        : null)
  return (
    !!current && !!details?.release && !!release && details.release !== release
  )
}

function InstallButton({
  entry,
  inventory,
  details,
  onInstalled,
  ...props
}: ManagerProps & {
  entry: CommunityEntry
  inventory: Inventory
  details?: CommunityDetails | undefined
  onInstalled?: (theme: InstalledTheme | null) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const task = useRef<{ id: string; controller: AbortController } | null>(null)
  const live = useRef(true)
  const [activated, setActivated] = useState(false)
  const enabled =
    activated ||
    (entry.kind === 'plugin' ? props.pluginsEnabled : props.themesEnabled)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
      if (task.current) {
        task.current.controller.abort()
        void cancelInstall(entry.kind, task.current.id).catch(() => {})
      }
    }
  }, [entry.kind])
  const label = details?.unsupported
    ? 'Desktop only'
    : !enabled
      ? entry.kind === 'plugin'
        ? 'Turn on Obsidian plugins'
        : 'Turn on Obsidian themes'
      : newer(entry, inventory, details)
        ? 'Update'
        : installedEntry(entry, inventory)
          ? 'Installed'
          : 'Install'
  const cancel = () => {
    if (!task.current) return
    task.current.controller.abort()
    void cancelInstall(entry.kind, task.current.id).catch(() => {})
  }
  async function act() {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      if (!enabled) {
        await props.enable(
          entry.kind === 'plugin' ? 'obsidian' : 'obsidian-themes',
        )
        if (live.current) setActivated(true)
      } else {
        const request = {
          id: crypto.randomUUID(),
          controller: new AbortController(),
        }
        task.current = request
        const result = await installCommunity(
          entry,
          request.id,
          request.controller.signal,
        )
        if (live.current && result) {
          await inventory.refresh()
          onInstalled?.(
            entry.kind === 'theme' ? (result as InstalledTheme) : null,
          )
        }
      }
    } catch (error) {
      if (live.current && !task.current?.controller.signal.aborted)
        setError(errorMessage(error))
    } finally {
      task.current = null
      if (live.current) setBusy(false)
    }
  }
  return (
    <>
      {busy && task.current ? (
        <Button aria-label={'Cancel install ' + entry.name} onClick={cancel}>
          Cancel
        </Button>
      ) : label === 'Installed' ? (
        <span className="addon-garden-included">Installed</span>
      ) : (
        <Button
          aria-label={
            label + (label.startsWith('Turn on') ? ' for ' : ' ') + entry.name
          }
          disabled={busy || !!details?.unsupported}
          onClick={() => void act()}
        >
          {busy ? 'Working…' : label}
        </Button>
      )}
      {error && (
        <span className="addon-revoked" role="alert">
          {error}
        </span>
      )}
    </>
  )
}

function ThemeActions({
  theme,
  busy,
  run,
}: {
  theme: InstalledTheme
  busy: boolean
  run: (work: () => Promise<void>) => void
}) {
  const preferences = useSyncExternalStore(
    colorschemes.subscribe,
    colorschemes.snapshot,
  ).preferences
  const ids = schemeIds(theme.id)
  const active = Object.values(preferences).some((value) =>
    Object.values(ids).includes(value as string),
  )
  return (
    <>
      {active && <span className="addon-garden-included">Active</span>}
      <Button
        aria-label={'Preview ' + theme.manifest.name}
        disabled={busy}
        onClick={() =>
          run(async () => {
            await obsidianThemes.preview(theme.id)
          })
        }
      >
        Preview
      </Button>
      <Button
        aria-label={'Apply ' + theme.manifest.name}
        disabled={busy || active}
        onClick={() =>
          run(async () => {
            await obsidianThemes.apply(theme.id)
          })
        }
      >
        Apply
      </Button>
    </>
  )
}

function CommunityDetailsView({
  entry,
  signal,
  onDetails,
  ...props
}: ManagerProps & {
  entry: CommunityEntry
  signal: AbortSignal
  onDetails: (details: CommunityDetails) => void
}) {
  const inventory = useObsidianInventory(props.pluginsEnabled)
  const [details, setDetails] = useState<CommunityDetails | null>(null)
  const [error, setError] = useState('')
  const [installedTheme, setInstalledTheme] = useState<InstalledTheme | null>(
    null,
  )
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const requestId = crypto.randomUUID()
    let active = true
    const cancel = () =>
      void window.hibi
        .obsidianCommunity('cancel', { requestId })
        .catch(() => {})
    signal.addEventListener('abort', cancel, { once: true })
    void window.hibi
      .obsidianCommunity('details', {
        kind: entry.kind,
        id: entry.id,
        requestId,
      })
      .then(
        (value) => {
          if (!active || signal.aborted) return
          const result = value as CommunityDetails
          setDetails(result)
          onDetails(result)
        },
        (error) => {
          if (active && !signal.aborted) setError(errorMessage(error))
        },
      )
    return () => {
      active = false
      signal.removeEventListener('abort', cancel)
      cancel()
    }
  }, [entry.kind, entry.id, onDetails, signal])
  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    try {
      await work()
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  const [activated, setActivated] = useState(false)
  const enabled =
    activated ||
    (entry.kind === 'plugin' ? props.pluginsEnabled : props.themesEnabled)
  return (
    <>
      <p className="addon-garden-note">
        {entry.description || 'An Obsidian community theme.'}
      </p>
      <span className="addon-metadata">
        <span>{entry.author}</span>
        <span>{entry.repo}</span>
        {entry.kind === 'plugin' && (
          <span>{entry.downloads.toLocaleString() + ' downloads'}</span>
        )}
      </span>
      {!enabled && (
        <p className="addon-garden-note">
          {entry.kind === 'plugin'
            ? 'Turn on Obsidian plugins to install. Plugins are installed once for all folders and start disabled.'
            : 'Turn on Obsidian themes to install. Themes are installed once and can be previewed before applying.'}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {!details && !error && (
        <Panel>
          <PanelMessage
            icon={<FileText size={28} />}
            title="Loading readme…"
            loading
          />
        </Panel>
      )}
      {details && (
        <>
          {details.version && (
            <p className="addon-garden-note">
              {'Version ' +
                details.version +
                ' · Requires Obsidian ' +
                details.minAppVersion +
                ' or later. Hibi provides a partial compatibility API.'}
            </p>
          )}
          {details.release && (
            <p className="addon-garden-note">
              {(newer(entry, inventory, details)
                ? entry.kind === 'theme'
                  ? 'New version available: '
                  : 'New release available: '
                : entry.kind === 'theme'
                  ? 'Latest version: '
                  : 'Latest release: ') + details.release}
            </p>
          )}
          {details.unsupported && <p role="status">{details.unsupported}</p>}
          {details.error && <p role="status">{details.error}</p>}
          <ControlRow className="addon-catalog-actions">
            <Button
              variant="ghost"
              onClick={() =>
                void window.hibi.openAddonDocumentationLink(
                  'https://github.com/' + entry.repo,
                )
              }
            >
              Source
            </Button>
            <InstallButton
              {...props}
              pluginsEnabled={
                (enabled && entry.kind === 'plugin') || props.pluginsEnabled
              }
              themesEnabled={
                (enabled && entry.kind === 'theme') || props.themesEnabled
              }
              enable={async (id) => {
                await props.enable(id)
                setActivated(true)
              }}
              entry={entry}
              inventory={inventory}
              details={details}
              onInstalled={setInstalledTheme}
            />
            {installedTheme && (
              <ThemeActions
                theme={installedTheme}
                busy={busy}
                run={(work) => void run(work)}
              />
            )}
          </ControlRow>
          <AddonReadme
            remote={{ content: details.readme, baseUrl: details.readmeUrl }}
          />
        </>
      )}
    </>
  )
}

export default function CommunityBrowser(props: ManagerProps) {
  const dialogs = useDialogs()
  const inventory = useObsidianInventory(props.pluginsEnabled)
  const [directory, setDirectory] = useState<CommunityDirectory>({
    entries: [],
    fetchedAt: null,
  })
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<string | null>(null)
  const [sort, setSort] = useState<'downloads' | 'name' | 'updated'>(
    'downloads',
  )
  const [limit, setLimit] = useState(50)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [details, setDetails] = useState<Record<string, CommunityDetails>>({})
  const [lastTheme, setLastTheme] = useState<InstalledTheme | null>(null)
  const [busy, setBusy] = useState(false)
  const current = useRef<string | null>(null)
  const load = useCallback(async (refresh = false) => {
    const requestId = crypto.randomUUID()
    if (current.current)
      void window.hibi
        .obsidianCommunity('cancel', { requestId: current.current })
        .catch(() => {})
    current.current = requestId
    setLoading(true)
    setError('')
    try {
      const result = (await window.hibi.obsidianCommunity('directory', {
        requestId,
        refresh,
      })) as CommunityDirectory
      if (current.current === requestId) setDirectory(result)
    } catch (error) {
      if (current.current === requestId) setError(errorMessage(error))
    } finally {
      if (current.current === requestId) {
        current.current = null
        setLoading(false)
      }
    }
  }, [])
  useEffect(() => {
    void load()
    return () => {
      const requestId = current.current
      current.current = null
      if (requestId)
        void window.hibi
          .obsidianCommunity('cancel', { requestId })
          .catch(() => {})
      obsidianThemes.endPreview()
    }
  }, [load])
  const kind =
    category === 'Plugins' ? 'plugin' : category === 'Themes' ? 'theme' : null
  const matches = filterCommunityEntries(directory.entries, kind, query, sort)
  const openDetails = (entry: CommunityEntry) => {
    const onDetails = (value: CommunityDetails) =>
      setDetails((previous) => ({ ...previous, [keyOf(entry)]: value }))
    dialogs.open({
      title: entry.name,
      preserveTitleCase: true,
      size: 'wide',
      content: ({ signal }) => (
        <CommunityDetailsView
          {...props}
          entry={entry}
          signal={signal}
          onDetails={onDetails}
        />
      ),
    })
  }
  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    try {
      await work()
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section aria-label="Obsidian community directory">
      <AddonCatalogToolbar
        actions={
          <>
            <Button
              onClick={() =>
                void window.hibi.openAddonDocumentationLink(
                  'https://obsidian.md/plugins',
                )
              }
            >
              View on website
            </Button>
            <Button disabled={loading} onClick={() => void load(true)}>
              Refresh
            </Button>
            <Select
              aria-label="Sort addons"
              value={sort}
              onChange={(event) => {
                setSort(event.target.value as typeof sort)
                setLimit(50)
              }}
            >
              <option value="downloads">Downloads</option>
              <option value="name">Name</option>
              <option value="updated">Updated</option>
            </Select>
            {loading && (
              <Button
                onClick={() =>
                  current.current &&
                  void window.hibi.obsidianCommunity('cancel', {
                    requestId: current.current,
                  })
                }
              >
                Cancel
              </Button>
            )}
          </>
        }
        query={query}
        onQuery={(value) => {
          setQuery(value)
          setLimit(50)
        }}
        categories={['Plugins', 'Themes']}
        category={category}
        onCategory={(value) => {
          setCategory(value)
          setLimit(50)
        }}
        resetDisabled={!query && !category && sort === 'downloads'}
        onReset={() => {
          setQuery('')
          setCategory(null)
          setSort('downloads')
          setLimit(50)
        }}
      />
      <AddonDirectoryStatus
        name="Obsidian community"
        loading={loading}
        error={error || directory.error}
        fetchedAt={directory.fetchedAt}
        hasEntries={!!directory.entries.length}
        retry={() => void load(true)}
        note="Obsidian community packages are made by their authors. Install only plugins you trust; Hibi keeps its own copies."
      >
        {lastTheme && (
          <div className="addon-garden-status" role="status">
            <span>{lastTheme.manifest.name + ' was installed.'}</span>
            <ThemeActions
              theme={lastTheme}
              busy={busy}
              run={(work) => void run(work)}
            />
          </div>
        )}
        <div className="settings-group addon-list" hidden={!matches.length}>
          {matches.slice(0, limit).map((entry) => {
            const detail = details[keyOf(entry)]
            const installed = installedEntry(entry, inventory)
            return (
              <AddonCatalogRow
                key={keyOf(entry)}
                id={'community-' + entry.kind + '-' + entry.id}
                name={entry.name}
                description={entry.description || 'Obsidian community theme'}
                details={{
                  label: 'Details for ' + entry.name,
                  onOpen: () => openDetails(entry),
                }}
                metadata={
                  <>
                    <span>{entry.author}</span>
                    <span>{entry.kind === 'plugin' ? 'Plugin' : 'Theme'}</span>
                    {entry.kind === 'plugin' && (
                      <span>
                        {entry.downloads.toLocaleString() + ' downloads'}
                      </span>
                    )}
                    {entry.updated > 0 && (
                      <span>
                        {'Updated ' +
                          new Date(entry.updated).toLocaleDateString()}
                      </span>
                    )}
                    {installed && <span>Installed</span>}
                    {newer(entry, inventory, detail) && <span>Update</span>}
                    {detail?.unsupported && <span>Desktop only</span>}
                  </>
                }
              >
                <InstallButton
                  {...props}
                  entry={entry}
                  inventory={inventory}
                  details={detail}
                  onInstalled={setLastTheme}
                />
              </AddonCatalogRow>
            )
          })}
        </div>
        {!matches.length && <NoMatchingAddons />}
        {matches.length > limit && (
          <Button onClick={() => setLimit((value) => value + 50)}>
            Show more
          </Button>
        )}
      </AddonDirectoryStatus>
    </section>
  )
}

export function InstalledObsidian({
  query,
  category,
  onCount,
  openSettings,
  ...props
}: ManagerProps & {
  query: string
  category: string | null
  onCount: (count: number) => void
  openSettings?: ((id: string) => void) | undefined
}) {
  const inventory = useObsidianInventory(props.pluginsEnabled)
  const dialogs = useDialogs()
  const pages = useSyncExternalStore(
    settingsPages.subscribe,
    settingsPages.snapshot,
  ).pages
  const [prefixes, setPrefixes] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    void Promise.all(
      inventory.plugins.map(async (plugin) => [
        plugin.manifest.id,
        await pluginResourcePrefix(plugin.manifest.id),
      ]),
    ).then((values) => {
      if (live) setPrefixes(Object.fromEntries(values))
    })
    return () => {
      live = false
    }
  }, [inventory.plugins])
  const matches = (
    name: string,
    author: string,
    description: string,
    kind: 'plugin' | 'theme',
  ) =>
    (!category ||
      category === 'Obsidian' ||
      (kind === 'theme' ? category === 'Themes' : category === 'Features')) &&
    [name, author, description, 'obsidian']
      .join(' ')
      .toLowerCase()
      .includes(query.trim().toLowerCase())
  const plugins = inventory.plugins.filter((plugin) =>
    matches(
      plugin.manifest.name,
      plugin.manifest.author,
      plugin.manifest.description,
      'plugin',
    ),
  )
  const themes = inventory.themes.filter((theme) =>
    matches(
      theme.manifest.name,
      theme.manifest.author ?? '',
      theme.repository ?? '',
      'theme',
    ),
  )
  const snippets = inventory.snippets.filter((snippet) =>
    matches(snippet.name, '', 'snippet', 'theme'),
  )
  useEffect(() => {
    onCount(plugins.length + themes.length + snippets.length)
  }, [onCount, plugins.length, themes.length, snippets.length])
  useEffect(
    () => () => {
      obsidianThemes.endPreview()
    },
    [],
  )
  const run = async (work: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await work()
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      changed()
      await inventory.refresh()
      setBusy(false)
    }
  }
  const activate = async (kind: 'plugin' | 'theme') => {
    if (!(kind === 'plugin' ? props.pluginsEnabled : props.themesEnabled))
      await props.enable(kind === 'plugin' ? 'obsidian' : 'obsidian-themes')
  }
  const update = (kind: 'plugin' | 'theme', id: string) => {
    const entry = async () => {
      const directory = (await window.hibi.obsidianCommunity('directory', {
        requestId: crypto.randomUUID(),
      })) as CommunityDirectory
      const item = directory.entries.find(
        (entry) =>
          entry.kind === kind &&
          (kind === 'plugin' ? entry.id === id : entry.repo === id),
      )
      if (!item)
        throw new Error(
          'This package is no longer listed in the Obsidian community directory.',
        )
      dialogs.open({
        title: item.name,
        preserveTitleCase: true,
        size: 'wide',
        content: ({ signal }) => (
          <CommunityDetailsView
            {...props}
            entry={item}
            signal={signal}
            onDetails={() => {}}
          />
        ),
      })
    }
    void run(entry)
  }
  return (
    <>
      {(error || inventory.error || inventory.runtimeErrors.$host) && (
        <p role="alert">
          {error || inventory.error || inventory.runtimeErrors.$host}
        </p>
      )}
      <div className="settings-group addon-list">
        {plugins.map((plugin) => {
          const manifest = plugin.manifest
          const offer = inventory.offers.find(
            (offer) => offer.id === manifest.id,
          )
          const page = pages.find((page) =>
            page.id.startsWith(
              'addon-obsidian.' + prefixes[manifest.id] + '-settings-',
            ),
          )
          return (
            <AddonCatalogRow
              key={manifest.id}
              id={'installed-obsidian-' + manifest.id}
              name={manifest.name}
              description={
                <>
                  {manifest.description}
                  {inventory.runtimeErrors[manifest.id] && (
                    <span className="addon-revoked">
                      {inventory.runtimeErrors[manifest.id]}
                    </span>
                  )}
                </>
              }
              metadata={
                <>
                  <span>Obsidian plugin</span>
                  <span>
                    {plugin.source
                      ? 'Obsidian community'
                      : plugin.origin === 'vault'
                        ? 'This vault'
                        : 'Folder'}
                  </span>
                  <span>v{manifest.version}</span>
                  <span>{manifest.author}</span>
                  {plugin.source && <span>{plugin.source.repo}</span>}
                </>
              }
            >
              {offer && (
                <>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const accepted = await dialogs.confirm({
                          title:
                            'Use this vault’s settings for ' +
                            manifest.name +
                            '?',
                          description: offer.overwrite
                            ? 'This replaces the plugin’s global settings for every folder. Hibi keeps the last three backups of the previous settings in its app data. Your vault stays unchanged.'
                            : 'Import a copy of this vault’s plugin settings into Hibi for every folder. Your vault stays unchanged.',
                          confirmLabel: offer.overwrite
                            ? 'Overwrite global settings'
                            : 'Use vault settings',
                          destructive: offer.overwrite,
                        })
                        if (accepted) {
                          await window.hibi.invokeAddon(
                            'obsidian',
                            'importVaultData',
                            offer,
                          )
                          changed(manifest.id, undefined, true)
                        } else {
                          await window.hibi.invokeAddon(
                            'obsidian',
                            'dismissVaultData',
                            { id: manifest.id, vaultId: offer.vaultId },
                          )
                        }
                      })
                    }
                  >
                    Use this vault’s settings
                  </Button>
                  <Button
                    variant="ghost"
                    aria-label={'Dismiss vault settings for ' + manifest.name}
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await window.hibi.invokeAddon(
                          'obsidian',
                          'dismissVaultData',
                          { id: manifest.id, vaultId: offer.vaultId },
                        )
                      })
                    }
                  >
                    Dismiss
                  </Button>
                </>
              )}
              {page && openSettings && (
                <Button
                  aria-label={'Settings for ' + manifest.name}
                  onClick={() => openSettings(page.id)}
                >
                  Settings
                </Button>
              )}
              {plugin.source && (
                <Button
                  aria-label={'Update ' + manifest.name}
                  disabled={busy}
                  onClick={() => update('plugin', manifest.id)}
                >
                  Update
                </Button>
              )}
              <Button
                aria-label={'Remove ' + manifest.name}
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    if (
                      !(await dialogs.confirm({
                        title: 'Remove ' + manifest.name + '?',
                        description:
                          'Remove this plugin from Hibi. Your vault files stay unchanged.',
                        confirmLabel: 'Remove',
                        destructive: true,
                      }))
                    )
                      return
                    await activate('plugin')
                    if (plugin.enabled) {
                      await window.hibi.invokeAddon('obsidian', 'enable', {
                        id: manifest.id,
                        enabled: false,
                      })
                      changed(manifest.id, false)
                    }
                    await window.hibi.invokeAddon('obsidian', 'remove', {
                      id: manifest.id,
                    })
                  })
                }
              >
                Remove
              </Button>
              {!props.pluginsEnabled ? (
                <Button
                  disabled={busy}
                  onClick={() => void run(() => activate('plugin'))}
                >
                  Turn on Obsidian plugins
                </Button>
              ) : (
                <Toggle
                  id={'installed-obsidian-' + manifest.id}
                  aria-label={'Enable ' + manifest.name}
                  disabled={busy}
                  checked={plugin.enabled}
                  onChange={(event) => {
                    const enabled = event.target.checked
                    void run(async () => {
                      await window.hibi.invokeAddon('obsidian', 'enable', {
                        id: manifest.id,
                        enabled,
                      })
                      if (!enabled) changed(manifest.id, false)
                    })
                  }}
                />
              )}
            </AddonCatalogRow>
          )
        })}
        {themes.map((theme) => (
          <AddonCatalogRow
            key={theme.id}
            id={'installed-obsidian-theme-' + theme.id}
            name={theme.manifest.name}
            description="Installed for all folders."
            metadata={
              <>
                <span>Obsidian theme</span>
                <span>
                  {theme.source === 'community'
                    ? 'Obsidian community'
                    : theme.source === 'vault'
                      ? 'This vault'
                      : 'Folder'}
                </span>
                {theme.manifest.version && (
                  <span>{'v' + theme.manifest.version}</span>
                )}
                <span>{theme.manifest.author ?? 'Author not given'}</span>
                {theme.repository && <span>{theme.repository}</span>}
              </>
            }
          >
            {props.themesEnabled ? (
              <ThemeActions
                theme={theme}
                busy={busy}
                run={(work) => void run(work)}
              />
            ) : (
              <Button
                disabled={busy}
                onClick={() => void run(() => activate('theme'))}
              >
                Turn on Obsidian themes
              </Button>
            )}
            {theme.repository && (
              <Button
                aria-label={'Update ' + theme.manifest.name}
                disabled={busy}
                onClick={() => update('theme', theme.repository!)}
              >
                Update
              </Button>
            )}
            <Button
              aria-label={'Remove ' + theme.manifest.name}
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  if (
                    await dialogs.confirm({
                      title: 'Remove ' + theme.manifest.name + '?',
                      description:
                        'Remove this theme from Hibi. Your vault files stay unchanged.',
                      confirmLabel: 'Remove',
                      destructive: true,
                    })
                  ) {
                    await activate('theme')
                    await obsidianThemes.remove(theme.id)
                  }
                })
              }
            >
              Remove
            </Button>
          </AddonCatalogRow>
        ))}
        {snippets.map((snippet) => (
          <AddonCatalogRow
            key={snippet.hash}
            id={'installed-obsidian-snippet-' + snippet.hash}
            name={snippet.name}
            description="CSS snippet installed for all folders."
            metadata={<span>Obsidian snippet</span>}
          >
            <Toggle
              aria-label={'Enable snippet ' + snippet.name}
              disabled={busy}
              checked={inventory.selection.snippets.includes(snippet.hash)}
              onChange={(event) => {
                const enabled = event.target.checked
                void run(async () => {
                  await activate('theme')
                  await obsidianThemes.setSnippets(
                    enabled
                      ? [...inventory.selection.snippets, snippet.hash]
                      : inventory.selection.snippets.filter(
                          (hash) => hash !== snippet.hash,
                        ),
                  )
                })
              }}
            />
            <Button
              aria-label={'Remove snippet ' + snippet.name}
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  if (
                    await dialogs.confirm({
                      title: 'Remove ' + snippet.name + '?',
                      confirmLabel: 'Remove',
                      destructive: true,
                    })
                  ) {
                    await activate('theme')
                    await obsidianThemes.removeSnippet(snippet.hash)
                  }
                })
              }
            >
              Remove
            </Button>
          </AddonCatalogRow>
        ))}
      </div>
      {props.pluginsEnabled &&
        inventory.suggestions.length > 0 &&
        (!category || category === 'Obsidian') && (
          <div className="settings-group addon-list">
            <p className="addon-garden-note">
              {inventory.suggestions.some((item) => item.suggested)
                ? 'This vault uses ' +
                  inventory.suggestions.filter((item) => item.suggested)
                    .length +
                  ' plugins. Install or enable a global copy in Hibi.'
                : 'Plugins found in this vault. Install a global copy in Hibi.'}
            </p>
            {inventory.suggestions
              .filter(
                (item) =>
                  !inventory.plugins.some(
                    (plugin) => plugin.manifest.id === item.id,
                  ),
              )
              .map((item) => (
                <AddonCatalogRow
                  key={item.id}
                  id={'suggested-obsidian-' + item.id}
                  name={item.name}
                  description={
                    item.error || 'This vault’s copy stays unchanged.'
                  }
                  metadata={<span>This vault</span>}
                >
                  <Button
                    disabled={busy || !!item.error}
                    onClick={() =>
                      void run(async () => {
                        await window.hibi.invokeAddon(
                          'obsidian',
                          'installVault',
                          { id: item.id },
                        )
                      })
                    }
                  >
                    Install copy
                  </Button>
                </AddonCatalogRow>
              ))}
          </div>
        )}
      <ControlRow className="addon-catalog-actions">
        <Button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await activate('plugin')
              await window.hibi.invokeAddon('obsidian', 'install')
            })
          }
        >
          Install Obsidian plugin from folder
        </Button>
        <Button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await activate('theme')
              await obsidianThemes.addFolder()
            })
          }
        >
          Install Obsidian theme from folder
        </Button>
      </ControlRow>
    </>
  )
}
