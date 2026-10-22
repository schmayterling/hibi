import { CloudOff, Sprout } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
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

type Directory = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  entries: readonly AddonDirectoryEntry[]
  fetchedAt?: string | null
  error?: string
}

/** Loads the directory the first time `active` is true; `retry` asks main to refresh it. */
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
  /** Search and category filters from the addon manager. */
  shown: (entry: AddonDirectoryEntry) => boolean
  /** How this ID relates to the addons Hibi already has. */
  status: (
    entry: AddonDirectoryEntry,
  ) => 'builtin' | 'installed' | 'update' | 'new'
  busy: boolean
  install: (entry: AddonDirectoryEntry) => void
  uninstall: (entry: AddonDirectoryEntry) => void
}) {
  const { entries } = directory
  const matching = entries.filter(shown)
  if (!entries.length) {
    if (directory.status === 'error')
      return (
        <Panel>
          <PanelMessage
            icon={<CloudOff size={32} strokeWidth={1.5} />}
            title="Couldn't load Hibi garden"
            role="alert"
          >
            {directory.error}
          </PanelMessage>
          <ControlRow className="addon-garden-retry">
            <Button onClick={retry}>Try again</Button>
          </ControlRow>
        </Panel>
      )
    return (
      <Panel>
        <PanelMessage
          icon={<Sprout size={32} strokeWidth={1.5} />}
          title={
            directory.status === 'ready'
              ? 'Hibi garden has no addons yet'
              : 'Loading Hibi garden…'
          }
          loading={directory.status !== 'ready'}
        />
      </Panel>
    )
  }
  return (
    <>
      <p className="addon-garden-note">
        Addons in Hibi garden are made by their authors. Hibi checks each
        package and asks before installing it.
      </p>
      {directory.status !== 'ready' && (
        <div className="addon-garden-status" role="status">
          <span>
            {directory.status === 'loading'
              ? 'Refreshing Hibi garden…'
              : `Showing addons from ${directory.fetchedAt ? new Date(directory.fetchedAt).toLocaleString() : 'an earlier visit'}. ${directory.error ?? ''}`}
          </span>
          {directory.status === 'error' && (
            <Button onClick={retry}>Try again</Button>
          )}
        </div>
      )}
      <div className="settings-group addon-list" hidden={!matching.length}>
        {entries.map((entry) => {
          const relation = status(entry)
          return (
            <SettingRow
              key={entry.id}
              id={`garden-${entry.id}`}
              label={entry.name}
              hidden={!shown(entry)}
              description={
                <>
                  {entry.description}
                  <span className="addon-metadata">
                    <span>{sentenceCase(entry.kind)}</span>
                    <span>v{entry.version}</span>
                    <span>{entry.license}</span>
                    {entry.authors?.map((author) => (
                      <span key={author.github ?? author.displayName}>
                        {author.displayName}
                      </span>
                    ))}
                  </span>
                </>
              }
            >
              <div className="addon-actions">
                <Button
                  variant="ghost"
                  aria-label={`${entry.name} source`}
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
                    aria-label={`Uninstall ${entry.name}`}
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
                    id={`garden-${entry.id}-install`}
                    aria-label={`${relation === 'update' ? 'Replace' : 'Install'} ${entry.name}`}
                    disabled={busy}
                    onClick={() => install(entry)}
                  >
                    {relation === 'update' ? 'Replace' : 'Install'}
                  </Button>
                )}
              </div>
            </SettingRow>
          )
        })}
      </div>
    </>
  )
}
