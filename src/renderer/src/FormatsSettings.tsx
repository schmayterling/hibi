import { Search, Settings as SettingsIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Addon, AddonState } from '../../addons/api'
import { errorMessage } from '../../shared/errors'
import {
  type FileAssociationState,
  fileAssociations,
} from '../../shared/file-associations'
import {
  Button,
  IconButton,
  Panel,
  PanelMessage,
  SettingRow,
  Toggle,
} from '../../ui/Controls'
import { DocumentNotice } from '../../ui/DocumentNotice'
import { SettingsFilter } from '../../ui/SettingsFilter'
import { useToasts } from '../../ui/Sonner'

export function FormatsSettings({
  active,
  addons,
  states,
  setEnabled,
  open,
}: {
  active: boolean
  addons: readonly Addon[]
  states: readonly AddonState[]
  setEnabled: (id: string, enabled: boolean) => Promise<void>
  open: (category: string) => void
}) {
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [associations, setAssociations] = useState<FileAssociationState | null>(
    null,
  )
  const toasts = useToasts()
  useEffect(() => {
    if (!active) return
    let mounted = true
    const refresh = () =>
      void window.hibi
        .getFileAssociations()
        .then((state) => {
          if (mounted) setAssociations(state)
        })
        .catch(() => {
          if (mounted)
            toasts.show({
              message:
                'Could not check your default apps. Check the default app settings on your computer.',
              variant: 'error',
            })
        })
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      mounted = false
      window.removeEventListener('focus', refresh)
    }
  }, [active, toasts])

  const defaultButton = (id: string) => {
    if (!Object.hasOwn(fileAssociations, id)) return null
    const format = fileAssociations[id as keyof typeof fileAssociations]
    const isDefault = format.ext.every((ext) =>
      associations?.defaults.includes(ext),
    )
    return (
      <Button
        disabled={busy || !associations?.available || isDefault}
        aria-label={`${format.name} default application`}
        title={
          associations?.available
            ? `Open .${format.ext.join(', .')} files with Hibi`
            : 'Install Hibi to choose it as your default app'
        }
        onClick={async () => {
          setBusy(true)
          try {
            await window.hibi.setFileAssociation(id)
            if (associations?.systemSettings) {
              toasts.show({
                message: `In Default apps, choose Hibi for .${format.ext.join(' and .')}.`,
              })
            }
            setAssociations(await window.hibi.getFileAssociations())
          } catch (error) {
            toasts.show({
              message: errorMessage(error),
              variant: 'error',
            })
          } finally {
            setBusy(false)
          }
        }}
      >
        {isDefault
          ? 'Default app'
          : associations?.systemSettings
            ? 'Choose default…'
            : 'Make default'}
      </Button>
    )
  }
  const formats = addons.filter(
    ({ manifest }) =>
      manifest.fileExtensions?.length &&
      states.some((state) => state.id === manifest.id && state.enabled),
  )
  const matching = formats.filter(({ manifest }) =>
    `${manifest.name} ${manifest.fileExtensions?.map((extension) => `.${extension}`).join(' ')}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  )
  const plainText = 'plain text .txt'.includes(query.trim().toLowerCase())
  return (
    <>
      <h1>Formats</h1>
      <div className="formats-intro">
        <p className="plugin-description">
          Enable more document formats in{' '}
          {/* biome-ignore lint/a11y/useValidAnchor: this link selects its settings panel instead of scrolling to the hidden panel. */}
          <a
            href="#settings-addons"
            onClick={(event) => {
              event.preventDefault()
              open('addons')
            }}
          >
            Addon Manager
          </a>
          .
        </p>
        {associations && !associations.available && (
          <DocumentNotice
            variant="warning"
            title="Install Hibi to choose it as your default app."
          />
        )}
      </div>
      <SettingsFilter
        id="formats-filter"
        label="Filter formats"
        placeholder="Filter formats…"
        value={query}
        onChange={setQuery}
      />
      <h2>Document formats</h2>
      <div className="settings-group" hidden={!matching.length && !plainText}>
        <SettingRow
          id="format-text"
          label="Plain text"
          hidden={!plainText}
          description=".txt · Built in"
        >
          {defaultButton('text')}
          <Toggle id="format-text" checked disabled />
        </SettingRow>
        {formats.map(({ manifest }) => (
          <SettingRow
            key={manifest.id}
            id={`format-${manifest.id}`}
            label={manifest.name}
            hidden={
              !matching.some((addon) => addon.manifest.id === manifest.id)
            }
            description={manifest.fileExtensions
              ?.map((extension) => `.${extension}`)
              .join(' · ')}
          >
            {defaultButton(manifest.id)}
            <IconButton
              onClick={() => open(`plugin-${manifest.id}`)}
              aria-label={`${manifest.name} settings`}
              title={`${manifest.name} settings`}
            >
              <SettingsIcon size={16} aria-hidden />
            </IconButton>
            {manifest.id === 'markdown' ? (
              <Toggle id={`format-${manifest.id}`} checked disabled />
            ) : (
              <Toggle
                id={`format-${manifest.id}`}
                disabled={busy}
                checked={states.some(
                  (state) => state.id === manifest.id && state.enabled,
                )}
                onChange={async (event) => {
                  setBusy(true)
                  try {
                    await setEnabled(manifest.id, event.target.checked)
                  } catch (error) {
                    toasts.show({
                      message:
                        error instanceof Error ? error.message : String(error),
                      variant: 'error',
                    })
                  } finally {
                    setBusy(false)
                  }
                }}
              />
            )}
          </SettingRow>
        ))}
      </div>
      {!matching.length && !plainText && (
        <Panel>
          <PanelMessage
            icon={<Search size={32} strokeWidth={1.5} />}
            title="No matching formats"
          />
        </Panel>
      )}
    </>
  )
}
