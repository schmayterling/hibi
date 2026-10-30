import { useEffect, useState } from 'react'
import { errorMessage } from '../../shared/errors'
import { SettingRow, Toggle } from '../../ui/Controls'
import { DocumentNotice } from '../../ui/DocumentNotice'

export function WindowControlsSettings() {
  const [hidden, setHidden] = useState<boolean | null>(null)
  const [changing, setChanging] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    window.hibi.getHideWindowControls().then(
      (value) => {
        if (active) setHidden(value)
      },
      (error: unknown) => {
        if (active) setError(errorMessage(error))
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
        description="Hide the minimize, maximize, and close buttons. Restart Hibi to apply."
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
