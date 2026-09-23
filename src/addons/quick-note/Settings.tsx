import { useEffect, useState } from 'react'
import type { RecentWorkspace } from '../../shared/workspace'
import { Button, Select, SettingRow, TextInput, Toggle } from '../ui'
import { type QuickNoteSettings, readSettings, writeSettings } from './settings'

export function Settings() {
  const [value, setValue] = useState(readSettings)
  const [targets, setTargets] = useState<RecentWorkspace[]>([])
  const [current, setCurrent] = useState<string | null>(null)
  const [folders, setFolders] = useState<string[]>([])
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [choosing, setChoosing] = useState(false)
  useEffect(() => {
    let active = true
    let generation = 0
    const refresh = () => {
      const current = ++generation
      void Promise.all([
        window.hibi.queryAddon('quick-note', 'targets') as Promise<
          RecentWorkspace[]
        >,
        window.hibi.getWorkspace(),
      ]).then(
        ([recent, workspace]) => {
          if (!active || current !== generation) return
          setTargets(recent)
          setCurrent(workspace?.name ?? null)
        },
        (failure) => {
          if (active && current === generation) setError(String(failure))
        },
      )
    }
    refresh()
    const off = window.hibi.onWorkspaceChanged(refresh)
    return () => {
      active = false
      off()
    }
  }, [])
  useEffect(() => {
    let active = true
    void (
      window.hibi.queryAddon(
        'quick-note',
        'folders',
        value.workspaceId,
      ) as Promise<string[]>
    ).then(
      (result) => {
        if (active) setFolders(result)
      },
      (failure) => {
        if (active) {
          setFolders([])
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      },
    )
    return () => {
      active = false
    }
  }, [value.workspaceId])
  const change = (patch: Partial<QuickNoteSettings>) => {
    setValue((previous) => ({ ...previous, ...patch }))
    setSaved(false)
    setError('')
  }
  return (
    <>
      <SettingRow
        id="quick-note-workspace"
        label="Workspace"
        description="Choose the current workspace or one of your recent workspaces."
      >
        <div className="quick-note-target">
          <Select
            id="quick-note-workspace"
            value={value.workspaceId}
            onChange={(event) =>
              change({ workspaceId: event.target.value, folder: '' })
            }
          >
            <option value="" disabled={!current}>
              {current
                ? `Current workspace: ${current}`
                : 'Open a workspace first'}
            </option>
            {targets.map((target) => (
              <option key={target.id} value={target.id}>
                {target.path}
              </option>
            ))}
          </Select>
          <Button
            disabled={choosing}
            onClick={async () => {
              setChoosing(true)
              try {
                const chosen = (await window.hibi.invokeAddon(
                  'quick-note',
                  'chooseWorkspace',
                )) as RecentWorkspace | null
                if (!chosen) return
                setTargets((previous) => [
                  chosen,
                  ...previous.filter((entry) => entry.id !== chosen.id),
                ])
                change({ workspaceId: chosen.id, folder: '' })
              } catch (failure) {
                setError(
                  failure instanceof Error
                    ? failure.message
                    : 'Could not choose this workspace.',
                )
              } finally {
                setChoosing(false)
              }
            }}
          >
            Choose workspace…
          </Button>
        </div>
      </SettingRow>
      <SettingRow id="quick-note-folder" label="Folder">
        <Select
          id="quick-note-folder"
          value={value.folder}
          onChange={(event) => change({ folder: event.target.value })}
        >
          <option value="">Workspace root</option>
          {folders.map((folder) => (
            <option key={folder} value={folder}>
              {folder}
            </option>
          ))}
        </Select>
      </SettingRow>
      <SettingRow id="quick-note-prompt-title" label="Ask for a title">
        <Toggle
          id="quick-note-prompt-title"
          checked={value.promptForTitle}
          onChange={(event) => change({ promptForTitle: event.target.checked })}
        />
      </SettingRow>
      <SettingRow
        id="quick-note-default-title"
        label="Default title"
        description="Used automatically, or offered when Hibi asks for a title. Repeated titles get a number."
      >
        <TextInput
          id="quick-note-default-title"
          value={value.defaultTitle}
          onChange={(event) => change({ defaultTitle: event.target.value })}
        />
      </SettingRow>
      <SettingRow
        id="quick-note-shortcut"
        label="Global shortcut"
        description="Use an Electron accelerator such as CommandOrControl+Alt+N. Clear it to disable the shortcut."
      >
        <TextInput
          id="quick-note-shortcut"
          value={value.shortcut}
          onChange={(event) => change({ shortcut: event.target.value })}
          monospace
        />
      </SettingRow>
      {error && <p role="alert">{error}</p>}
      {saved && <p role="status">Quick note settings saved.</p>}
      <Button
        variant="primary"
        onClick={() => {
          try {
            writeSettings(value)
            setSaved(true)
            setError('')
          } catch (failure) {
            setError(
              failure instanceof Error
                ? failure.message
                : 'Could not save quick note settings.',
            )
          }
        }}
      >
        Save settings
      </Button>
    </>
  )
}
