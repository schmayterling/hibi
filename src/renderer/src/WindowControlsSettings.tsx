import { useEffect, useRef, useState } from 'react'
import { errorMessage } from '../../shared/errors'
import { SettingRow, Toggle } from '../../ui/Controls'
import { useDialogs } from '../../ui/DialogProvider'
import { DocumentNotice } from '../../ui/DocumentNotice'

export function WindowControlsSettings({
  appliedHidden,
}: {
  appliedHidden: boolean
}) {
  const [hidden, setHidden] = useState<boolean | null>(null)
  const [changing, setChanging] = useState(false)
  const [error, setError] = useState('')
  const dialogs = useDialogs()
  const control = useRef<HTMLInputElement>(null)
  useEffect(() => {
    let active = true
    window.hibi.getHideWindowControls().then(
      (value) => {
        if (active) {
          setHidden(value)
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
    let saved = false
    try {
      await window.hibi.setHideWindowControls(value)
      saved = true
      setChanging(false)
      if (value !== appliedHidden) {
        const restart = await dialogs.confirm({
          title: 'Restart Hibi?',
          description: 'Restart Hibi to apply your window controls preference.',
          confirmLabel: 'Restart Hibi',
          cancelLabel: 'Later',
        })
        if (restart) await window.hibi.restartForWindowControls()
        else control.current?.focus()
      }
    } catch (error) {
      if (!saved) setHidden(previous)
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
        description="On Linux, hide the minimize, maximize, and close buttons. Restart Hibi to apply."
      >
        <Toggle
          ref={control}
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
