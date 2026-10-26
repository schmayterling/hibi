import { useEffect, useRef, useState } from 'react'
import { errorMessage } from '../../shared/errors'
import type { Importer, ImportResult, ImportSource } from '../../shared/imports'
import type { WorkspaceHeader } from '../../shared/workspace-view'
import { Button, Select } from '../../ui/Controls'
import { DocumentNotice } from '../../ui/DocumentNotice'
import type { DialogApi } from '../../ui/dialogs'

function ImportDialog({
  close,
  settings,
}: {
  close: () => void
  settings: () => void
}) {
  const [importers, setImporters] = useState<Importer[]>([])
  const [workspace, setWorkspace] = useState<WorkspaceHeader | null>(null)
  const [id, setId] = useState('folder')
  const [source, setSource] = useState<ImportSource>('folder')
  const [busy, setBusy] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const cancelRequested = useRef(false)
  const importing = useRef(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<ImportResult | null>(null)
  useEffect(() => {
    let active = true
    void Promise.all([
      window.hibi.listImporters(),
      window.hibi.getWorkspaceHeader(),
    ])
      .then(([items, workspace]) => {
        if (active) {
          setImporters(items)
          setWorkspace(workspace)
        }
      })
      .catch((error) => {
        if (active) setError(errorMessage(error))
      })
    return () => {
      active = false
      if (importing.current)
        void window.hibi.cancelWorkspaceImport().catch(() => {})
    }
  }, [])
  const importer = importers.find((item) => item.id === id)
  return (
    <div className="dialog-form">
      {result ? (
        <>
          <p>
            Imported {result.files} files into {result.folder}.
          </p>
          {result.warnings.map((warning) => (
            <DocumentNotice key={warning} title={warning} variant="warning" />
          ))}
        </>
      ) : (
        <>
          {!workspace?.manifest ? (
            <DocumentNotice
              title="Hibi workspace required"
              message="Open a workspace with a manifest before importing."
            >
              <Button
                onClick={() => {
                  close()
                  settings()
                }}
              >
                Workspace settings
              </Button>
            </DocumentNotice>
          ) : (
            <p>Import into {workspace.name}</p>
          )}
          <label htmlFor="import-kind">Import from</label>
          <Select
            id="import-kind"
            value={id}
            disabled={busy}
            onChange={(event) => {
              setId(event.target.value)
              setSource(
                importers.find((item) => item.id === event.target.value)
                  ?.sources[0] ?? 'folder',
              )
            }}
          >
            {importers.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </Select>
          {importer?.instructions && <p>{importer.instructions}</p>}
          {(importer?.sources.length ?? 0) > 1 && (
            <>
              <label htmlFor="import-source">Source</label>
              <Select
                id="import-source"
                value={source}
                disabled={busy}
                onChange={(event) =>
                  setSource(event.target.value as ImportSource)
                }
              >
                {importer?.sources.map((source) => (
                  <option key={source} value={source}>
                    {source === 'zip' ? 'ZIP export' : 'Folder'}
                  </option>
                ))}
              </Select>
            </>
          )}
          <p className="hint">
            More importers are available in Settings → Addons.
          </p>
        </>
      )}
      {error && <DocumentNotice title="Import failed" message={error} />}
      {busy && <DocumentNotice title="Importing files…" busy />}
      <div className="dialog-actions">
        <Button
          disabled={cancelling}
          onClick={async () => {
            if (!busy) return close()
            cancelRequested.current = true
            setCancelling(true)
            try {
              await window.hibi.cancelWorkspaceImport()
            } catch (error) {
              cancelRequested.current = false
              setCancelling(false)
              setError(errorMessage(error))
            }
          }}
        >
          {result ? 'Done' : 'Cancel'}
        </Button>
        {!result && (
          <Button
            disabled={busy || !workspace?.manifest || !importer}
            onClick={async () => {
              if (!workspace?.id) return
              cancelRequested.current = false
              importing.current = true
              setBusy(true)
              setError('')
              try {
                const imported = await window.hibi.importIntoWorkspace({
                  id,
                  source,
                  workspaceId: workspace.id,
                })
                if (!imported && cancelRequested.current) close()
                else setResult(imported)
              } catch (error) {
                setError(errorMessage(error))
              } finally {
                importing.current = false
                setBusy(false)
                setCancelling(false)
              }
            }}
          >
            {source === 'zip' ? 'Choose ZIP…' : 'Choose folder…'}
          </Button>
        )}
      </div>
    </div>
  )
}
export function openImportDialog(dialogs: DialogApi, settings: () => void) {
  return dialogs.open({
    title: 'Import into workspace',
    closeOnOutsideClick: false,
    content: ({ close }) => (
      <ImportDialog close={() => close(null)} settings={settings} />
    ),
  }).result
}
