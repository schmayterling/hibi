import { useCallback, useEffect, useRef, useState } from 'react'
import AddonReadme from '../../renderer/src/AddonReadme'
import { errorMessage } from '../../shared/errors'
import {
  Button,
  ControlRow,
  Select,
  SettingRow,
  TextInput,
} from '../../ui/Controls'
import {
  type CommunityDetails,
  type CommunityDirectory,
  type CommunityEntry,
  filterCommunityEntries,
} from './community-types'
import type { InstalledPlugin } from './package'

export default function CommunityBrowser({
  pluginsEnabled,
  themesEnabled,
  enable,
}: {
  pluginsEnabled: boolean
  themesEnabled: boolean
  enable: (id: string) => Promise<void>
}) {
  const [directory, setDirectory] = useState<CommunityDirectory>({
    entries: [],
    fetchedAt: null,
  })
  const [kind, setKind] = useState<'plugin' | 'theme'>('plugin')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'downloads' | 'name' | 'updated'>(
    'downloads',
  )
  const [limit, setLimit] = useState(50)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [selection, setSelection] = useState<CommunityEntry | null>(null)
  const [details, setDetails] = useState<CommunityDetails | null>(null)
  const [installed, setInstalled] = useState<InstalledPlugin[]>([])
  const [vaultId, setVaultId] = useState<string | null>(null)
  const live = useRef(true)
  const pending = useRef(new Map<string, 'browse' | 'plugin' | 'theme'>())
  const running = useRef(false)

  const cancel = useCallback(async () => {
    for (const [requestId, type] of pending.current) {
      const work =
        type === 'theme'
          ? window.hibi.invokeAddonProfile('obsidian-themes', 'cancelInstall', {
              requestId,
            })
          : type === 'plugin'
            ? window.hibi.invokeAddonProfile('obsidian', 'cancelCommunity', {
                requestId,
              })
            : window.hibi.obsidianCommunity('cancel', { requestId })
      void work.catch(() => {})
    }
  }, [])
  const request = useCallback(
    async <T,>(
      type: 'browse' | 'plugin' | 'theme',
      work: (requestId: string) => Promise<T>,
    ) => {
      const requestId = crypto.randomUUID()
      pending.current.set(requestId, type)
      try {
        return await work(requestId)
      } finally {
        pending.current.delete(requestId)
      }
    },
    [],
  )
  const run = useCallback(async (work: () => Promise<void>) => {
    if (running.current) return
    running.current = true
    setLoading(true)
    setError('')
    try {
      await work()
    } catch (error) {
      if (live.current) setError(errorMessage(error))
    } finally {
      running.current = false
      if (live.current) setLoading(false)
    }
  }, [])
  const load = useCallback(
    async (refresh = false) => {
      await run(async () => {
        const result = (await request('browse', (requestId) =>
          window.hibi.obsidianCommunity('directory', { requestId, refresh }),
        )) as CommunityDirectory
        if (live.current) setDirectory(result)
      })
    },
    [request, run],
  )
  const refreshInstalled = useCallback(async () => {
    const workspace = await window.hibi.getWorkspace()
    if (!live.current) return
    const id = workspace?.id ?? null
    setVaultId(id)
    if (!id || !pluginsEnabled) {
      setInstalled([])
      return
    }
    const result = (await window.hibi.queryAddon('obsidian', 'list', {
      vaultId: id,
    })) as InstalledPlugin[]
    if (live.current) setInstalled(result)
  }, [pluginsEnabled])
  useEffect(() => {
    live.current = true
    void load()
    return () => {
      live.current = false
      void cancel()
    }
  }, [cancel, load])
  useEffect(() => {
    void refreshInstalled().catch((error) => {
      if (live.current) setError(errorMessage(error))
    })
  }, [refreshInstalled])
  const matches = filterCommunityEntries(directory.entries, kind, query, sort)

  async function openDetails(entry: CommunityEntry) {
    await run(async () => {
      setSelection(entry)
      setDetails(null)
      const result = (await request('browse', (requestId) =>
        window.hibi.obsidianCommunity('details', {
          requestId,
          kind: entry.kind,
          id: entry.id,
        }),
      )) as CommunityDetails
      if (live.current) setDetails(result)
    })
  }
  const current = (entry: CommunityEntry) =>
    installed.find((plugin) => plugin.manifest.id === entry.id)
  const updateAvailable = (entry: CommunityEntry) => {
    const plugin = current(entry)
    return (
      entry.kind === 'plugin' &&
      plugin?.source?.repo === entry.repo &&
      selection === entry &&
      !!details?.release &&
      details.release !== plugin.source.release
    )
  }
  async function install(entry: CommunityEntry) {
    const addon = entry.kind === 'plugin' ? 'obsidian' : 'obsidian-themes'
    if (!(entry.kind === 'plugin' ? pluginsEnabled : themesEnabled)) {
      await run(() => enable(addon))
      return
    }
    await run(async () => {
      setMessage('')
      if (entry.kind === 'theme') {
        const result = (await request('theme', (requestId) =>
          window.hibi.invokeAddonProfile('obsidian-themes', 'installRepo', {
            repo: entry.repo,
            name: entry.name,
            author: entry.author,
            ...(entry.branch ? { branch: entry.branch } : {}),
            requestId,
          }),
        )) as { ok: boolean; message?: string; code?: string }
        if (!result.ok) {
          if (result.code === 'cancelled') return
          throw new Error(
            result.message || 'This theme could not be installed.',
          )
        }
        if (live.current)
          setMessage(
            entry.name +
              ' was installed. Choose it in Obsidian themes settings to preview or apply it.',
          )
      } else {
        const workspace = await window.hibi.getWorkspace()
        const vaultId = workspace?.id
        if (!vaultId)
          throw new Error('Open a vault folder before installing a plugin.')
        const result = await request('plugin', async (requestId) => {
          const candidate = (await window.hibi.invokeAddonProfile(
            'obsidian',
            'downloadCommunity',
            { vaultId, id: entry.id, requestId },
          )) as { key: string }
          if (!live.current) {
            await window.hibi.invokeAddonProfile(
              'obsidian',
              'cancelCommunity',
              { requestId },
            )
            return null
          }
          return window.hibi.invokeAddon('obsidian', 'installCommunity', {
            vaultId,
            id: entry.id,
            key: candidate.key,
          })
        })
        if (result) {
          window.dispatchEvent(new Event('hibi:obsidian-community-installed'))
          if (live.current) {
            setMessage(
              entry.name +
                ' was installed and starts disabled. Enable it in Obsidian plugins settings when you are ready.',
            )
            await refreshInstalled()
          }
        }
      }
    })
  }
  const actionLabel = (entry: CommunityEntry) =>
    updateAvailable(entry) ? 'Update ' + entry.name : 'Install ' + entry.name
  const enabled = kind === 'plugin' ? pluginsEnabled : themesEnabled
  const chooseKind = (value: 'plugin' | 'theme') => {
    setKind(value)
    if (value === 'theme') setSort('name')
    setLimit(50)
    setSelection(null)
    setDetails(null)
  }

  return (
    <section aria-label="Obsidian community directory">
      <p>
        Browse the official Obsidian community directory. Hibi supports portable
        plugins and stores separate copies outside your vault. Install only code
        you trust.
      </p>
      <ControlRow role="tablist" aria-label="Obsidian community types">
        {(
          [
            ['plugin', 'Plugins'],
            ['theme', 'Themes'],
          ] as const
        ).map(([value, label]) => (
          <Button
            key={value}
            id={'community-tab-' + value}
            role="tab"
            aria-controls="community-results"
            aria-selected={kind === value}
            tabIndex={kind === value ? 0 : -1}
            onClick={() => chooseKind(value)}
            onKeyDown={(event) => {
              if (
                !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
              )
                return
              event.preventDefault()
              const next =
                event.key === 'Home'
                  ? 'plugin'
                  : event.key === 'End'
                    ? 'theme'
                    : kind === 'plugin'
                      ? 'theme'
                      : 'plugin'
              chooseKind(next)
              document.getElementById('community-tab-' + next)?.focus()
            }}
          >
            {label}
          </Button>
        ))}
      </ControlRow>
      <div
        id="community-results"
        role="tabpanel"
        aria-labelledby={'community-tab-' + kind}
      >
        {!enabled && (
          <Button
            disabled={loading}
            onClick={() =>
              void run(() =>
                enable(kind === 'plugin' ? 'obsidian' : 'obsidian-themes'),
              )
            }
          >
            {kind === 'plugin'
              ? 'Turn on Obsidian plugins to install'
              : 'Turn on Obsidian themes to install'}
          </Button>
        )}
        <ControlRow>
          <TextInput
            aria-label="Search Obsidian community"
            placeholder="Search by name, author, or description…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setLimit(50)
            }}
          />
          <Select
            aria-label="Sort Obsidian community"
            value={sort}
            onChange={(event) => {
              setSort(event.target.value as typeof sort)
              setLimit(50)
            }}
          >
            {kind === 'plugin' && <option value="downloads">Downloads</option>}
            <option value="name">Name</option>
            {kind === 'plugin' && <option value="updated">Updated</option>}
          </Select>
          <Button disabled={loading} onClick={() => void load(true)}>
            Refresh community directory
          </Button>
          {loading && (
            <Button onClick={() => void cancel()}>
              Cancel community request
            </Button>
          )}
        </ControlRow>
        {loading && <p role="status">Loading Obsidian community…</p>}
        {error && <p role="alert">{error}</p>}
        {directory.error && (
          <p role="status">
            {'Showing cached directory data. ' + directory.error}
          </p>
        )}
        {message && <p role="status">{message}</p>}
        {selection && (
          <section aria-label={selection.name + ' details'}>
            <h3>{selection.name}</h3>
            <p>{selection.author + ' · ' + selection.repo}</p>
            {details && (
              <>
                {details.version && (
                  <p>
                    {'Version ' +
                      details.version +
                      ' · Requires Obsidian ' +
                      details.minAppVersion +
                      ' or later. Hibi provides a partial compatibility API.'}
                  </p>
                )}
                {details.release && (
                  <p>
                    {(updateAvailable(selection)
                      ? 'New release available: '
                      : 'Latest release: ') + details.release}
                  </p>
                )}
                {details.unsupported && (
                  <p role="status">{details.unsupported}</p>
                )}
                {details.error && <p role="status">{details.error}</p>}
                <Button
                  disabled={
                    loading ||
                    !!details.unsupported ||
                    !(selection.kind === 'plugin'
                      ? pluginsEnabled
                      : themesEnabled) ||
                    (selection.kind === 'plugin' && pluginsEnabled && !vaultId)
                  }
                  onClick={() => void install(selection)}
                >
                  {actionLabel(selection)}
                </Button>
                <AddonReadme
                  remote={{
                    content: details.readme,
                    baseUrl: details.readmeUrl,
                  }}
                />
              </>
            )}
          </section>
        )}
        {kind === 'plugin' && pluginsEnabled && !vaultId && (
          <p>Open a vault folder before installing a plugin.</p>
        )}
        <p role="status">
          {matches.length +
            ' matching ' +
            (kind === 'plugin' ? 'plugins' : 'themes')}
        </p>
        <div className="settings-group">
          {matches.slice(0, limit).map((entry) => (
            <SettingRow
              key={entry.id}
              id={'community-' + entry.kind + '-' + entry.id}
              label={entry.name}
              description={
                <>
                  {entry.description}
                  <span className="addon-metadata">
                    <span>{entry.author}</span>
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
                    {current(entry) && (
                      <span>
                        {'Installed v' + current(entry)?.manifest.version}
                      </span>
                    )}
                  </span>
                </>
              }
            >
              <Button
                disabled={loading}
                aria-label={'Details for ' + entry.name}
                onClick={() => void openDetails(entry)}
              >
                Details
              </Button>
              <Button
                disabled={
                  loading ||
                  !(entry.kind === 'plugin' ? pluginsEnabled : themesEnabled) ||
                  (entry.kind === 'plugin' && pluginsEnabled && !vaultId)
                }
                onClick={() => void install(entry)}
              >
                {actionLabel(entry)}
              </Button>
            </SettingRow>
          ))}
        </div>
        {matches.length > limit && (
          <Button onClick={() => setLimit((value) => value + 50)}>
            Show more community items
          </Button>
        )}
      </div>
    </section>
  )
}
