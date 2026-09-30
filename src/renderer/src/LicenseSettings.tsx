import { ChevronRight, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { LicenseInfo } from '../../shared/about'
import { Panel, PanelMessage } from '../../ui/Controls'
import { useDialogs } from '../../ui/DialogProvider'
import { SettingsFilter } from '../../ui/SettingsFilter'
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
  const [query, setQuery] = useState('')
  const matching = licenses?.filter((license) =>
    `${license.name} ${license.version ?? ''} ${license.license}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  )
  const noMatches = !!licenses?.length && !matching?.length
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
      <SettingsFilter
        id="license-filter"
        label="Filter licenses"
        placeholder="Filter licenses…"
        value={query}
        onChange={setQuery}
        disabled={!licenses?.length}
      />
      <section
        className="settings-group license-list"
        aria-labelledby="credits"
        hidden={noMatches}
      >
        {failed ? (
          <p role="alert">
            Could not load licenses. Reopen this page to try again.
          </p>
        ) : !matching ? (
          <p role="status">Loading licenses…</p>
        ) : (
          matching.map((license) => (
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
      {noMatches && (
        <Panel>
          <PanelMessage
            icon={<Search size={32} strokeWidth={1.5} />}
            title="No matching licenses"
          />
        </Panel>
      )}
    </>
  )
}
