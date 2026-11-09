import { useEffect, useState } from 'react'
import { errorMessage } from '../../shared/errors'
import {
  recoveryDays,
  recoveryMegabytes,
  type RecoverySettings as Settings,
} from '../../shared/recovery'
import { Select, SettingRow, Toggle } from '../../ui/Controls'
import { useDialogs } from '../../ui/DialogProvider'
import { DocumentNotice } from '../../ui/DocumentNotice'

export function RecoverySettings() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [error, setError] = useState('')
  const dialogs = useDialogs()
  useEffect(() => {
    let active = true
    window.hibi.getRecoverySettings().then(
      (value) => {
        if (active) setSettings(value)
      },
      (error: unknown) => {
        if (active) setError(errorMessage(error))
      },
    )
    return () => {
      active = false
    }
  }, [])
  /** A choice that removes copies says which first; the control stays as it was if declined. */
  async function change(changes: Partial<Settings>) {
    if (!settings) return
    const next = { ...settings, ...changes }
    setError('')
    try {
      const going = await window.hibi.previewRecoverySettings(next)
      if (
        going.length &&
        !(await dialogs.confirm({
          title:
            going.length === 1
              ? 'Delete a waiting recovery copy?'
              : `Delete ${going.length} waiting recovery copies?`,
          description: `This removes unsaved text you can't get back: ${going
            .map((name) => name ?? 'a copy Hibi can’t read')
            .join(', ')}.`,
          confirmLabel: 'Delete',
          destructive: true,
        }))
      )
        return
      await window.hibi.setRecoverySettings(next)
      setSettings(next)
    } catch (error) {
      setError(errorMessage(error))
    }
  }
  const off = !settings?.keep
  return (
    <>
      <SettingRow
        id="keep-recovery"
        label="Keep unsaved text for recovery"
        description="If Hibi or your computer stops suddenly, you can get unsaved text back. Hibi keeps it as plain text in its app data until you save or discard it, and backups of your user folder can include it. Turning this off deletes these copies."
      >
        <Toggle
          id="keep-recovery"
          aria-describedby="keep-recovery-description"
          checked={settings?.keep ?? false}
          disabled={!settings}
          onChange={(event) => void change({ keep: event.target.checked })}
        />
      </SettingRow>
      <SettingRow
        id="recovery-days"
        label="Delete unclaimed copies after"
        description="Counted from the first time Hibi offers a copy."
      >
        <Select
          id="recovery-days"
          value={settings?.days ?? 30}
          disabled={off}
          onChange={(event) =>
            void change({
              days: Number(event.target.value) as Settings['days'],
            })
          }
        >
          {recoveryDays.map((days) => (
            <option key={days} value={days}>
              {days === 0 ? 'Never' : `${days} days`}
            </option>
          ))}
        </Select>
      </SettingRow>
      <SettingRow
        id="recovery-megabytes"
        label="Recovery copies size limit"
        description="Past this, the oldest unclaimed copies go first. Copies of open notes stay, and a note too large to fit gets no copy."
      >
        <Select
          id="recovery-megabytes"
          value={settings?.megabytes ?? 512}
          disabled={off}
          onChange={(event) =>
            void change({
              megabytes: Number(event.target.value) as Settings['megabytes'],
            })
          }
        >
          {recoveryMegabytes.map((megabytes) => (
            <option key={megabytes} value={megabytes}>
              {megabytes < 1024 ? `${megabytes} MB` : `${megabytes / 1024} GB`}
            </option>
          ))}
        </Select>
      </SettingRow>
      <SettingRow
        id="recovery-open"
        label="Open unsaved text at launch"
        description="Opens recovered notes without asking. Autosave can save them if their files have not changed."
      >
        <Toggle
          id="recovery-open"
          aria-describedby="recovery-open-description"
          checked={settings?.openAtLaunch ?? false}
          disabled={off}
          onChange={(event) =>
            void change({ openAtLaunch: event.target.checked })
          }
        />
      </SettingRow>
      {error && (
        <DocumentNotice title="Recovery settings unavailable" message={error} />
      )}
    </>
  )
}
