import { useCallback, useEffect, useState } from 'react'
import { errorMessage } from '../../shared/errors'
import type {
  WorkspaceSettings as State,
  WorkspaceManifest,
  WorkspaceSettingsAction,
} from '../../shared/workspace-settings'
import {
  Button,
  Select,
  SettingRow,
  TextArea,
  TextInput,
  Toggle,
} from '../../ui/Controls'
import { useDialogs } from '../../ui/DialogProvider'
import { DocumentNotice } from '../../ui/DocumentNotice'

export function WorkspaceSettings({
  active,
  onChanged,
}: {
  active: boolean
  onChanged: () => Promise<void>
}) {
  const dialogs = useDialogs()
  const [state, setState] = useState<State | null>(null)
  const [manifest, setManifest] = useState<WorkspaceManifest | null>(null)
  const [ignore, setIgnore] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const accept = useCallback((next: State) => {
    setState(next)
    setManifest(next.manifest)
    setIgnore(next.ignore)
  }, [])
  useEffect(() => {
    if (!active) return
    let current = true
    void window.hibi
      .getWorkspaceSettings()
      .then((next) => {
        if (current) accept(next)
      })
      .catch((error) => {
        if (current) setError(errorMessage(error))
      })
    return () => {
      current = false
    }
  }, [active, accept])
  async function update(action: WorkspaceSettingsAction) {
    setBusy(true)
    setError('')
    try {
      accept(await window.hibi.updateWorkspaceSettings(action))
      await onChanged()
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <h1>Workspace</h1>
      <div className="workspace-setting-actions">
        <Button
          disabled={busy}
          onClick={() =>
            void import('./ImportDialog').then(({ openImportDialog }) =>
              openImportDialog(dialogs, () => {}),
            )
          }
        >
          Import…
        </Button>
      </div>
      {error && (
        <DocumentNotice title="Workspace unavailable" message={error} />
      )}
      <div className="settings-group">
        <SettingRow
          id="show-all-files"
          label="Show all files in sidebar"
          description="Show files of any type, including hidden files. Unsupported formats open in source view only."
        >
          <Toggle
            aria-label="Show all files in sidebar"
            checked={state?.showAllFiles ?? false}
            disabled={busy || !state}
            onChange={(event) =>
              void update({
                action: 'show-all-files',
                enabled: event.target.checked,
              })
            }
          />
        </SettingRow>
        <SettingRow
          id="managed-workspace"
          label="Hibi workspace"
          description={
            state?.path ??
            state?.defaultPath ??
            'Keep a dedicated folder for your documents.'
          }
        >
          <Toggle
            aria-label="Hibi workspace"
            checked={state?.enabled ?? false}
            disabled={busy || !state}
            onChange={(event) =>
              void update({ action: 'enable', enabled: event.target.checked })
            }
          />
        </SettingRow>
        <SettingRow id="workspace-location" label="Location">
          <div className="workspace-setting-actions">
            <Button
              disabled={busy}
              onClick={() => void update({ action: 'choose' })}
            >
              Choose folder…
            </Button>
            <Button
              disabled={busy || !state?.enabled}
              onClick={() => void update({ action: 'open' })}
            >
              Open workspace
            </Button>
            <Button
              disabled={busy || !state?.enabled}
              onClick={() => void update({ action: 'relocate' })}
            >
              Relocate…
            </Button>
          </div>
        </SettingRow>
        <SettingRow
          id="workspace-startup"
          label="At startup"
          description={
            state?.startup === 'folder'
              ? (state.startupFolder ?? undefined)
              : undefined
          }
        >
          <Select
            aria-label="At startup"
            disabled={busy || !state}
            value={state?.startup ?? 'empty'}
            onChange={(event) =>
              void update({
                action: 'startup',
                startup: event.target.value as State['startup'],
              })
            }
          >
            <option value="empty">Show empty state</option>
            <option value="managed" disabled={!state?.enabled}>
              Open Hibi workspace
            </option>
            <option value="folder">Choose a folder…</option>
          </Select>
        </SettingRow>
      </div>
      <h2>Current workspace</h2>
      {!state?.currentPath ? (
        <DocumentNotice
          title="No workspace open"
          message="Open a folder to edit its workspace settings."
        />
      ) : !manifest ? (
        <div className="settings-group">
          <SettingRow
            id="create-workspace-manifest"
            label="Workspace manifest"
            description="Give this folder a name, default document, and ignore rules."
          >
            <Button
              disabled={busy}
              onClick={() => void update({ action: 'create-manifest' })}
            >
              Create manifest
            </Button>
          </SettingRow>
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (state.manifestRevision)
              void update({
                action: 'save-manifest',
                manifest,
                revision: state.manifestRevision,
                ignore,
              })
          }}
        >
          <div className="settings-group">
            <SettingRow id="workspace-name" label="Name">
              <TextInput
                aria-label="Workspace name"
                maxLength={120}
                required
                value={manifest.name}
                onChange={(event) =>
                  setManifest({ ...manifest, name: event.target.value })
                }
              />
            </SettingRow>
            <SettingRow id="workspace-description" label="Description">
              <TextArea
                aria-label="Workspace description"
                maxLength={2000}
                rows={3}
                value={manifest.description}
                onChange={(event) =>
                  setManifest({ ...manifest, description: event.target.value })
                }
              />
            </SettingRow>
            <SettingRow
              id="workspace-icon"
              label="Icon"
              description="A Lucide name or an addon icon identifier."
            >
              <TextInput
                aria-label="Workspace icon"
                value={manifest.icon}
                onChange={(event) =>
                  setManifest({ ...manifest, icon: event.target.value })
                }
              />
            </SettingRow>
            <SettingRow
              id="workspace-default-file"
              label="Default document"
              description="Path inside this workspace, such as README.md."
            >
              <TextInput
                aria-label="Default document"
                value={manifest.defaultFile}
                onChange={(event) =>
                  setManifest({ ...manifest, defaultFile: event.target.value })
                }
              />
            </SettingRow>
            <SettingRow
              id="workspace-ignore"
              label="Ignore rules"
              description="One pattern per line, using gitignore syntax."
            >
              <TextArea
                aria-label="Ignore rules"
                monospace
                rows={5}
                value={ignore}
                onChange={(event) => setIgnore(event.target.value)}
              />
            </SettingRow>
          </div>
          <div className="workspace-setting-actions">
            <Button type="submit" disabled={busy}>
              Save workspace settings
            </Button>
          </div>
        </form>
      )}
    </>
  )
}
