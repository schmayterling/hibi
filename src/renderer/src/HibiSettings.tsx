import { ArrowUpRight, Heart } from 'lucide-react'
import { type MouseEvent, useEffect, useState } from 'react'
import type { AppInfo } from '../../shared/desktop'
import { errorMessage } from '../../shared/errors'
import { Button, SettingRow, Toggle } from '../../ui/Controls'
import { Modal } from '../../ui/Modal'
import { RecoveryScreen } from './RecoveryScreen'
import { UpdateSettings } from './UpdateSettings'
import './hibi-settings.css'

const appIcon = new URL('./assets/app-icon.png', import.meta.url).href
const appIconDark = new URL('./assets/app-icon-dark.png', import.meta.url).href

export function HibiSettings({
  info,
  onShowIntroduction,
}: {
  info: AppInfo | null
  onShowIntroduction: () => void
}) {
  const [preview, setPreview] = useState(false)
  const [background, setBackground] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void window.hibi.getBackgroundMode().then(
      (enabled) => {
        if (active) setBackground(enabled)
      },
      (error) => {
        if (active) setError(errorMessage(error))
      },
    )
    return () => {
      active = false
    }
  }, [])
  async function saveBackground(enabled: boolean) {
    setSaving(true)
    setError('')
    try {
      setBackground(await window.hibi.setBackgroundMode(enabled))
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }
  function openExternalLink(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault()
    void window.hibi.openAddonDocumentationLink(event.currentTarget.href)
  }
  return (
    <>
      <h1>About</h1>
      <div className="settings-group hibi-about">
        <div className="hibi-identity">
          <picture className="hibi-mark">
            <source srcSet={appIconDark} media="(prefers-color-scheme: dark)" />
            <img src={appIcon} alt="" width={44} height={44} />
          </picture>
          <div>
            <div className="hibi-name">Hibi</div>
            <p>Version {info?.version ?? '…'}</p>
          </div>
          <span className="hibi-description">
            Write, edit, and organize your documents.
          </span>
        </div>
        <p className="hibi-credit">
          Made with <Heart size={12} aria-label="Love" /> by{' '}
          <a href="https://github.com/schmayterling" onClick={openExternalLink}>
            may
          </a>{' '}
          and{' '}
          <a
            href="https://github.com/schmayterling/hibi/graphs/contributors"
            onClick={openExternalLink}
          >
            beloved contributors
          </a>{' '}
          <span aria-hidden="true">·</span> © {new Date().getFullYear()}
        </p>
        <nav className="hibi-links" aria-label="Hibi links">
          <a
            href="https://github.com/sponsors/schmayterling"
            onClick={openExternalLink}
          >
            Support Hibi development <ArrowUpRight aria-hidden="true" />
          </a>
          <a href="https://docs.hibi.garden" onClick={openExternalLink}>
            Docs <ArrowUpRight aria-hidden="true" />
          </a>
          <a
            href="https://github.com/schmayterling/hibi/issues"
            onClick={openExternalLink}
          >
            Report an issue <ArrowUpRight aria-hidden="true" />
          </a>
          <a
            href="https://github.com/schmayterling/hibi"
            onClick={openExternalLink}
          >
            Contribute <ArrowUpRight aria-hidden="true" />
          </a>
          <a href="https://discord.gg/v9r4cABUP2" onClick={openExternalLink}>
            Join the Discord <ArrowUpRight aria-hidden="true" />
          </a>
        </nav>
      </div>
      <h2>General</h2>
      <div className="settings-group">
        <SettingRow
          id="keep-running-in-background"
          label="Keep Hibi running in the background"
          description="Closing the window keeps your edits and addons running. Use the menu bar or tray icon to reopen Hibi or quit. Some Linux desktops need indicator support to show the icon. This is off by default."
        >
          <Toggle
            id="keep-running-in-background"
            aria-describedby="keep-running-in-background-description"
            checked={background ?? false}
            disabled={background === null || saving}
            onChange={(event) => void saveBackground(event.target.checked)}
          />
        </SettingRow>
        {error && <p role="alert">{error}</p>}
      </div>
      <h2>Help</h2>
      <div className="settings-group">
        <SettingRow
          id="introduction"
          label="Introduction"
          description="Choose an appearance, default view, and addons, and see essential shortcuts."
        >
          <Button
            id="introduction"
            aria-label="Show introduction"
            onClick={onShowIntroduction}
          >
            Show introduction
          </Button>
        </SettingRow>
      </div>
      <UpdateSettings />
      <h2>Diagnostics</h2>
      <div className="settings-group">
        <SettingRow
          id="recovery-preview"
          label="Recovery screen"
          description="Preview the recovery screen without interrupting your document."
        >
          <Button
            id="recovery-preview"
            aria-label="Preview recovery screen"
            onClick={() => setPreview(true)}
          >
            Preview recovery screen
          </Button>
        </SettingRow>
      </div>
      {preview && (
        <Modal
          className="recovery-preview"
          aria-label="Recovery preview"
          onDismiss={() => setPreview(false)}
        >
          <RecoveryScreen
            error={new Error('This is an example error for the preview.')}
            onBack={() => setPreview(false)}
          />
        </Modal>
      )}
    </>
  )
}
