import { ArrowUpRight, File, Heart } from 'lucide-react'
import { type MouseEvent, useState } from 'react'
import type { AppInfo } from '../../shared/desktop'
import { Button, SettingRow } from '../../ui/Controls'
import { useDialogs } from '../../ui/DialogProvider'
import { Modal } from '../../ui/Modal'
import { RecoveryScreen } from './RecoveryScreen'
import { UpdateSettings } from './UpdateSettings'
import './hibi-settings.css'

export function HibiSettings({ info }: { info: AppInfo | null }) {
  const dialogs = useDialogs()
  const [sponsoring, setSponsoring] = useState(false)
  const [preview, setPreview] = useState(false)
  async function sponsor() {
    setSponsoring(true)
    try {
      await window.hibi.openSponsor()
    } catch {
      void dialogs.alert({
        title: 'Could not open your browser',
        description: 'Try again, or visit GitHub.com/sponsors/schmayterling.',
        confirmLabel: 'Close',
      })
    } finally {
      setSponsoring(false)
    }
  }
  function openCreditLink(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault()
    void window.hibi.openAddonDocumentationLink(event.currentTarget.href)
  }
  return (
    <>
      <h1>Hibi</h1>
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
          <a href="https://github.com/schmayterling" onClick={openCreditLink}>
            may
          </a>{' '}
          and{' '}
          <a
            href="https://github.com/schmayterling/hibi/graphs/contributors"
            onClick={openCreditLink}
          >
            beloved contributors
          </a>{' '}
          <span aria-hidden="true">·</span> © {new Date().getFullYear()}
        </p>
        <SettingRow
          id="sponsor-project"
          label="Support Hibi"
          description="Support development with a donation."
        >
          <Button
            id="sponsor-project"
            aria-label="Sponsor on GitHub"
            aria-describedby="sponsor-project-description"
            className="sponsor-button"
            disabled={sponsoring}
            onClick={() => void sponsor()}
          >
            Sponsor on GitHub <ArrowUpRight aria-hidden="true" />
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
