import { useEffect, useRef, useState } from 'react'
import {
  type AppIconMode,
  type AppIconState,
  isAppIconMode,
} from '../../shared/app-icon'
import { errorMessage } from '../../shared/errors'
import { Button, ControlRow, Select, SettingRow } from '../../ui/Controls'
import { DocumentNotice } from '../../ui/DocumentNotice'

// Adapted from the prototype in #879 by doublezz10.
export function AppIconSettings({ platform }: { platform: string }) {
  const [state, setState] = useState<AppIconState | null>(null)
  const [changing, setChanging] = useState(false)
  // The mode being saved, shown while it saves; the select stays focusable.
  const [pending, setPending] = useState<AppIconMode | null>(null)
  const busy = useRef(false)
  const [error, setError] = useState('')
  const select = useRef<HTMLSelectElement>(null)
  const refocus = useRef(false)
  useEffect(() => {
    // Reset removes the focused image row; keep keyboard focus on the setting.
    if (refocus.current && !changing) {
      refocus.current = false
      // Unless the user has moved on to another control meanwhile.
      if (!document.activeElement || document.activeElement === document.body)
        select.current?.focus()
    }
  })
  useEffect(() => {
    let active = true
    window.hibi.getAppIcon().then(
      (value) => {
        if (active) setState(value)
      },
      () => {
        if (active)
          setError('Could not load your app icon. Restart Hibi to try again.')
      },
    )
    return () => {
      active = false
    }
  }, [])
  async function run(
    change: () => Promise<AppIconState | null>,
    next: AppIconMode | null = null,
  ) {
    // Controls stay enabled, so keyboard focus stays put; repeats wait their turn.
    if (busy.current) return
    busy.current = true
    setChanging(true)
    setPending(next)
    setError('')
    try {
      const saved = await change()
      if (saved) setState(saved)
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      busy.current = false
      setChanging(false)
      setPending(null)
    }
  }
  const choose = () => run(() => window.hibi.chooseAppIcon())
  return (
    <>
      <h2>App icon</h2>
      <div className="settings-group">
        <SettingRow
          id="app-icon"
          label="App icon"
          description={
            platform === 'darwin'
              ? 'Shown in the Dock while Hibi is open. When Hibi is closed, macOS shows its light icon, because changing the installed app would break its signature.'
              : platform === 'linux'
                ? "Shown in the taskbar and window switcher while Hibi is open. When Hibi is closed, your system shows its light icon. Follow system isn't available on Linux, where Hibi can't read the system appearance while it uses its own; choose Follow app appearance with Hibi's appearance set to System."
                : 'Shown in the taskbar and window switcher while Hibi is open. When Hibi is closed, your system shows its light icon.'
          }
        >
          <Select
            ref={select}
            id="app-icon"
            aria-describedby="app-icon-description"
            value={pending ?? state?.mode ?? 'app'}
            disabled={state === null}
            aria-busy={changing}
            onChange={(event) => {
              const mode = event.target.value
              if (!isAppIconMode(mode)) return
              void (mode === 'custom' && !state?.custom
                ? choose()
                : run(() => window.hibi.setAppIcon(mode), mode))
            }}
          >
            {platform !== 'linux' && (
              <option value="system">Follow system</option>
            )}
            <option value="app">Follow app appearance</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
            <option value="custom">Custom image…</option>
          </Select>
        </SettingRow>
        {state?.custom && (
          <SettingRow
            id="app-icon-custom"
            label="Custom image"
            description="Hibi keeps a copy of the image, up to 512 pixels."
          >
            <ControlRow>
              <img
                src={state.custom}
                alt="Custom app icon preview"
                width={32}
                height={32}
              />
              <Button onClick={() => void choose()}>Choose image…</Button>
              <Button
                onClick={() => {
                  refocus.current = true
                  void run(() => window.hibi.resetAppIcon())
                }}
              >
                Reset
              </Button>
            </ControlRow>
          </SettingRow>
        )}
        {error && (
          <DocumentNotice title="App icon unavailable" message={error} />
        )}
      </div>
    </>
  )
}
