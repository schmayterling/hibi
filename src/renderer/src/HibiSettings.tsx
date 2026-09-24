import { ArrowUpRight, File, Heart } from 'lucide-react'
import { type MouseEvent, useState } from 'react'
import type { AppInfo } from '../../shared/desktop'
import { Button, SettingRow } from '../../ui/Controls'
import { Modal } from '../../ui/Modal'
import { RecoveryScreen } from './RecoveryScreen'
import { UpdateSettings } from './UpdateSettings'
import './hibi-settings.css'

export function HibiSettings({ info }: { info: AppInfo | null }) {
  const [preview, setPreview] = useState(false)
  function openExternalLink(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault()
    void window.hibi.openAddonDocumentationLink(event.currentTarget.href)
  }
  return (
    <>
      <h1>About</h1>
      <div className="settings-group hibi-about">
        <div className="hibi-identity">
          <span className="hibi-mark" aria-hidden="true">
            <File size={28} strokeWidth={1.25} />
          </span>
          <div>
            <div className="hibi-name">Hibi</div>
            <p>Version {info?.version ?? '…'}</p>
          </div>
          <span className="hibi-description">
            Write, edit, and organize your documents.
          </span>
        </div>
        <p className="hibi-credit">
          Made by <Heart size={12} aria-label="Love" /> with{' '}
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
