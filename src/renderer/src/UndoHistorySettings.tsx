import { useEffect, useState } from 'react'
import { errorMessage } from '../../shared/errors'
import { Button, SettingRow, Toggle } from '../../ui/Controls'
import { useDialogs } from '../../ui/DialogProvider'
import { DocumentNotice } from '../../ui/DocumentNotice'
import { clear, setKeep } from './undo-history'

export function UndoHistorySettings() {
  const [keep, setKeepState] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const dialogs = useDialogs()
  useEffect(() => {
    let active = true
    window.hibi.getKeepUndoHistory().then(
      (value) => {
        if (active) setKeepState(value)
      },
      (error: unknown) => {
        if (active) setError(errorMessage(error))
      },
    )
    return () => {
      active = false
    }
  }, [])
  async function run(task: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await task()
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <h2>Undo history</h2>
      <div className="settings-group">
        <SettingRow
          id="keep-undo-history"
          label="Keep undo history after closing"
          description="Reopened notes can undo changes made up to their last save. Hibi keeps these steps, including deleted text, on this device."
        >
          <Toggle
            id="keep-undo-history"
            aria-describedby="keep-undo-history-description"
            checked={keep ?? false}
            disabled={keep === null || busy}
            onChange={(event) => {
              const previous = keep,
                next = event.target.checked
              setKeepState(next)
              void run(() =>
                setKeep(next).catch((error: unknown) => {
                  setKeepState(previous)
                  throw error
                }),
              )
            }}
          />
        </SettingRow>
        <SettingRow
          id="clear-undo-history"
          label="Clear undo history"
          description="Removes the undo steps of open notes and the ones kept for closed notes."
        >
          <Button
            id="clear-undo-history"
            aria-describedby="clear-undo-history-description"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                if (
                  await dialogs.confirm({
                    title: 'Clear undo history?',
                    description:
                      'Open and closed notes lose their undo steps. You can’t undo this.',
                    confirmLabel: 'Clear',
                    destructive: true,
                  })
                )
                  await clear()
              })
            }
          >
            Clear
          </Button>
        </SettingRow>
      </div>
      {error && (
        <DocumentNotice title="Undo history unavailable" message={error} />
      )}
    </>
  )
}
