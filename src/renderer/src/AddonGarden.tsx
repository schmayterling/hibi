import { CloudOff, Search, Sprout } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import {
  type AddonDirectoryEntry,
  directoryInstallUrl,
} from '../../shared/addon-directory'
import { errorMessage } from '../../shared/errors'
import { sentenceCase } from '../../shared/ui-case'
import {
  Button,
  ControlRow,
  Panel,
  PanelMessage,
  SettingRow,
} from '../../ui/Controls'
import { SettingsFilter } from '../../ui/SettingsFilter'

type Directory = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  entries: readonly AddonDirectoryEntry[]
  fetchedAt?: string | null
  error?: string
}

/** One row vocabulary for installed addons and both community directories. */
export function AddonCatalogRow({
  id,
  name,
  description,
  metadata,
  details,
  hidden,
  children,
}: {
  id: string
  name: string
  description?: ReactNode
  metadata?: ReactNode
  details?: { label: string; onOpen: () => void }
  hidden?: boolean
  children: ReactNode
}) {
  return (
    <SettingRow
      id={id}
      label={name}
      hidden={hidden ?? false}
      {...(details ? { details } : {})}
      description={
        <>
          {description}
          {metadata && <span className="addon-metadata">{metadata}</span>}
        </>
      }
    >
      <div className="addon-actions">{children}</div>
    </SettingRow>
  )
}

/** Shared toolbar, search/reset row and category chips for every addon source. */
export function AddonCatalogToolbar({
  actions,
  query,
  onQuery,
  categories,
  category,
  onCategory,
  onReset,
  resetDisabled,
  disabled,
}: {
  actions: ReactNode
  query: string
  onQuery: (query: string) => void
  categories: readonly string[]
  category: string | null
  onCategory: (category: string | null) => void
  onReset: () => void
  resetDisabled: boolean
  disabled?: boolean
}) {
  return (
    <>
      <ControlRow className="addon-catalog-actions">{actions}</ControlRow>
      <SettingsFilter
        id="addon-filter"
        label="Filter addons"
        placeholder="Filter addons…"
        value={query}
        onChange={onQuery}
        disabled={disabled ?? false}
        resetDisabled={resetDisabled}
        onReset={onReset}
      />
      <ControlRow
        className="addon-categories"
        role="group"
        aria-label="Addon categories"
      >
        {[null, ...categories].map((option) => (
          <Button
            key={option ?? 'all'}
            aria-pressed={category === option}
            onClick={() => onCategory(option)}
          >
            {option ?? 'All'}
          </Button>
        ))}
      </ControlRow>
    </>
  )
}

/** Directory loading, empty, stale-cache and offline states share the garden's layout. */
export function AddonDirectoryStatus({
  name,
  loading,
  error,
  fetchedAt,
  hasEntries,
  retry,
  note,
  children,
}: {
  name: string
  loading: boolean
  error?: string | undefined
  fetchedAt?: string | null | undefined
  hasEntries: boolean
  retry: () => void
  note: string
  children: ReactNode
}) {
  if (!hasEntries)
    return (
      <Panel>
        <PanelMessage
          icon={
            error ? (
              <CloudOff size={32} strokeWidth={1.5} />
            ) : (
              <Sprout size={32} strokeWidth={1.5} />
            )
          }
          title={
            error
              ? "Couldn't load " + name
              : loading
                ? 'Loading ' + name + '…'
                : name + ' has no addons yet'
          }
          role={error ? 'alert' : 'status'}
          loading={!error && loading}
        >
          {error}
        </PanelMessage>
        {error && (
          <ControlRow className="addon-garden-retry">
            <Button onClick={retry}>Try again</Button>
          </ControlRow>
        )}
      </Panel>
    )
  return (
    <>
      <p className="addon-garden-note">{note}</p>
      {(loading || error) && (
        <div className="addon-garden-status" role="status">
          <span>
            {loading
              ? 'Refreshing ' + name + '…'
              : `Showing addons from ${fetchedAt ? new Date(fetchedAt).toLocaleString() : 'an earlier visit'}. ${error ?? ''}`}
          </span>
          {error && <Button onClick={retry}>Try again</Button>}
        </div>
      )}
      {children}
    </>
  )
}

export function NoMatchingAddons() {
  return (
    <Panel>
      <PanelMessage
        icon={<Search size={32} strokeWidth={1.5} />}
        title="No matching addons"
      />
    </Panel>
  )
}

/** Loads the directory the first time active is true; retry asks main to refresh it. */
export function useAddonDirectory(active: boolean) {
  const [directory, setDirectory] = useState<Directory>({
    status: 'idle',
    entries: [],
  })
  const request = useRef(0)
  const load = useCallback((refresh: boolean) => {
    const current = ++request.current
    setDirectory((previous) => ({ ...previous, status: 'loading' }))
    window.hibi.getAddonDirectory(refresh).then(
      ({ entries, fetchedAt, error }) => {
        if (current !== request.current) return
        setDirectory({
          status: error ? 'error' : 'ready',
          entries,
          ...(fetchedAt ? { fetchedAt } : {}),
          ...(error ? { error } : {}),
        })
      },
      (error) => {
        if (current !== request.current) return
        setDirectory((previous) => ({
          ...previous,
          status: 'error',
          error: errorMessage(error),
        }))
      },
    )
  }, [])
  useEffect(() => {
    if (active && directory.status === 'idle') load(false)
  }, [active, directory.status, load])
  return { directory, retry: () => load(true) }
}

export function AddonGarden({
  directory,
  retry,
  shown,
  status,
  busy,
  install,
  uninstall,
}: {
  directory: Directory
  retry: () => void
  shown: (entry: AddonDirectoryEntry) => boolean
  status: (
    entry: AddonDirectoryEntry,
  ) => 'builtin' | 'installed' | 'update' | 'new'
  busy: boolean
  install: (entry: AddonDirectoryEntry) => void
  uninstall: (entry: AddonDirectoryEntry) => void
}) {
  const matching = directory.entries.filter(shown)
  return (
    <AddonDirectoryStatus
      name="Hibi garden"
      loading={directory.status === 'idle' || directory.status === 'loading'}
      error={directory.error}
      fetchedAt={directory.fetchedAt}
      hasEntries={!!directory.entries.length}
      retry={retry}
      note="Addons in Hibi garden are made by their authors. Hibi checks each package and asks before installing it."
    >
      <div className="settings-group addon-list" hidden={!matching.length}>
        {directory.entries.map((entry) => {
          const relation = status(entry)
          return (
            <AddonCatalogRow
              key={entry.id}
              id={'garden-' + entry.id}
              name={entry.name}
              description={entry.description}
              hidden={!shown(entry)}
              metadata={
                <>
                  <span>{sentenceCase(entry.kind)}</span>
                  <span>v{entry.version}</span>
                  <span>{entry.license}</span>
                  {entry.authors?.map((author) => (
                    <span key={author.github ?? author.displayName}>
                      {author.displayName}
                    </span>
                  ))}
                </>
              }
            >
              <Button
                variant="ghost"
                aria-label={entry.name + ' source'}
                onClick={() =>
                  void window.hibi.openAddonDocumentationLink(
                    directoryInstallUrl(entry),
                  )
                }
              >
                Source
              </Button>
              {(relation === 'installed' || relation === 'update') && (
                <Button
                  aria-label={'Uninstall ' + entry.name}
                  disabled={busy}
                  onClick={() => uninstall(entry)}
                >
                  Uninstall
                </Button>
              )}
              {relation === 'builtin' ? (
                <span className="addon-garden-included">
                  Included with Hibi
                </span>
              ) : relation === 'installed' ? (
                <span className="addon-garden-included">Installed</span>
              ) : (
                <Button
                  id={'garden-' + entry.id + '-install'}
                  aria-label={
                    (relation === 'update' ? 'Replace ' : 'Install ') +
                    entry.name
                  }
                  disabled={busy}
                  onClick={() => install(entry)}
                >
                  {relation === 'update' ? 'Replace' : 'Install'}
                </Button>
              )}
            </AddonCatalogRow>
          )
        })}
      </div>
      {!matching.length && <NoMatchingAddons />}
    </AddonDirectoryStatus>
  )
}
