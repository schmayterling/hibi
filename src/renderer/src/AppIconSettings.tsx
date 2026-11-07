import { useEffect, useState } from 'react'
import { type AppIconMode, isAppIconMode } from '../../shared/app-icon'
import { errorMessage } from '../../shared/errors'
import { Select, SettingRow } from '../../ui/Controls'
import { DocumentNotice } from '../../ui/DocumentNotice'

export function AppIconSettings() {
  const [mode, setMode] = useState<AppIconMode | null>(null)
  const [changing, setChanging] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    window.hibi.getAppIconMode().then(
      (value) => {
        if (active) setMode(value)
      },
      (error) => {
        if (active) setError(errorMessage(error))
      },
    )
    return () => {
      active = false
    }
  }, [])
  async function change(value: string) {
    if (!isAppIconMode(value)) return
    setChanging(true)
    setError('')
    try {
      await window.hibi.setAppIconMode(value)
      setMode(value)
    } catch (error) {
      setError(errorMessage(error))
      try {
        setMode(await window.hibi.getAppIconMode())
      } catch (loadError) {
        setError(`${errorMessage(error)} ${errorMessage(loadError)}`)
      }
    } finally {
      setChanging(false)
    }
  }
  return (
    <>
      <h2>App icon</h2>
      <div className="settings-group">
        <SettingRow
          id="app-icon-appearance"
          label="App icon appearance"
          description="Choose the Dock icon independently of Hibi’s colors. Your choice also applies after quitting."
        >
          <Select
            id="app-icon-appearance"
            aria-describedby="app-icon-appearance-description"
            value={mode ?? 'app'}
            disabled={mode === null || changing}
            onChange={(event) => void change(event.target.value)}
          >
            <option value="system">Follow system</option>
            <option value="app">Follow app appearance</option>
            <option value="light">Always light</option>
            <option value="dark">Always dark</option>
          </Select>
        </SettingRow>
        {error && (
          <DocumentNotice title="App icon unavailable" message={error} />
        )}
      </div>
    </>
  )
}
