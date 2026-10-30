import { useEffect, useState } from 'react'
import { errorMessage } from '../../shared/errors'
import { SettingRow, Toggle } from '../../ui/Controls'
import { DocumentNotice } from '../../ui/DocumentNotice'

export function WindowControlsSettings({
  appliedHidden,
}: {
  appliedHidden: boolean
}) {
  const [hidden, setHidden] = useState<boolean | null>(null)
  const [saved, setSaved] = useState<boolean | null>(null)
  const [changing, setChanging] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    window.hibi.getHideWindowControls().then(
      (value) => {
        if (active) {
          setHidden(value)
          setSaved(value)
        }
      },
      () => {
        if (active)
          setError(
            'Could not load your window controls preference. Restart Hibi to try again.',
          )
      },
    )
    return () => {
      active = false
    }
  }, [])
  async function change(value: boolean) {
    const previous = hidden
    setHidden(value)
    setChanging(true)
    setError('')
    try {
      await window.hibi.setHideWindowControls(value)
      setSaved(value)
    } catch (error) {
      setHidden(previous)
      setError(errorMessage(error))
    } finally {
      setChanging(false)
    }
  }
  return (
    <>
      <SettingRow
        id="hide-window-controls"
        label="Hide window controls"
        description={
          <>
            On Linux, hide the minimize, maximize, and close buttons. Restart
            Hibi to apply.
            {saved !== null && saved !== appliedHidden && (
              <span
                className="setting-description"
                role="status"
                aria-live="polite"
              >
                Saved. Quit and reopen Hibi to apply your window controls
                preference.
              </span>
            )}
          </>
        }
      >
        <Toggle
          id="hide-window-controls"
          aria-describedby="hide-window-controls-description"
          checked={hidden ?? false}
          disabled={hidden === null || changing}
          onChange={(event) => void change(event.target.checked)}
        />
      </SettingRow>
      {error && (
        <DocumentNotice title="Window controls unavailable" message={error} />
      )}
    </>
  )
}
