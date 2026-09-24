import { ChevronRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { LicenseInfo } from '../../shared/about'
import { useDialogs } from '../../ui/DialogProvider'
import './hibi-settings.css'

function LicenseText({ id }: { id: string }) {
  const [text, setText] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let active = true
    void window.hibi.getLicense(id).then(
      (value) => {
        if (active) setText(value)
      },
      () => {
        if (active) setFailed(true)
      },
    )
    return () => {
      active = false
    }
  }, [id])
  if (failed)
    return (
      <p role="alert">Could not load this license. Close it and try again.</p>
    )
  if (text === null) return <p role="status">Loading license…</p>
  return <pre className="license-text">{text}</pre>
}

export function LicenseSettings() {
  const dialogs = useDialogs()
  const [licenses, setLicenses] = useState<LicenseInfo[] | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let active = true
    void window.hibi.getLicenses().then(
      (value) => {
        if (active) setLicenses(value)
      },
      () => {
        if (active) setFailed(true)
      },
    )
    return () => {
      active = false
    }
  }, [])
  return (
    <>
      <h1 id="credits">Credits</h1>
      <section
        className="settings-group license-list"
        aria-labelledby="credits"
      >
        {failed ? (
          <p role="alert">
            Could not load licenses. Reopen this page to try again.
          </p>
        ) : licenses === null ? (
          <p role="status">Loading licenses…</p>
        ) : (
          licenses.map((license) => (
            <button
              key={license.id}
              className="ui-action-row license-row"
              type="button"
              aria-haspopup="dialog"
              onClick={() =>
                dialogs.open({
                  title: license.name,
                  description: [license.version, license.license]
                    .filter(Boolean)
                    .join(' · '),
                  size: 'wide',
                  content: () => <LicenseText id={license.id} />,
                })
              }
            >
              <span className="license-name">
                {license.name}
                {license.version && (
                  <span className="license-version">{license.version}</span>
                )}
              </span>
              <span className="license-type">{license.license}</span>
              <ChevronRight aria-hidden="true" />
            </button>
          ))
        )}
      </section>
    </>
  )
}
