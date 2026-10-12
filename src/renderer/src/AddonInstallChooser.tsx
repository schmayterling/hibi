import { useEffect, useId, useRef, useState } from 'react'
import type {
  AddonInstallResult,
  AddonInstallSession,
} from '../../shared/sideload'
import { Button } from '../../ui/Controls'
import type { DialogApi } from '../../ui/dialogs'

export async function reviewAddonInstall(
  dialogs: DialogApi,
  session: AddonInstallSession,
): Promise<void> {
  let operation: Promise<AddonInstallResult[]> | undefined
  let cancellation: Promise<void> | undefined
  const cancel = () => {
    if (cancellation) return
    cancellation = window.hibi.cancelAddonInstall(session.id)
    void cancellation.catch(() => {})
  }
  const install = (keys: string[]) => {
    operation = window.hibi
      .installAddonSelection(session.id, keys)
      .catch((error): AddonInstallResult[] =>
        keys.map((key) => ({
          key,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        })),
      )
    return operation
  }
  try {
    await dialogs.open({
      title: 'Install addons',
      size: 'wide',
      closeOnOutsideClick: false,
      description:
        'Review each addon before installing. Installed addons stay disabled until you enable them.',
      content: ({ close, signal }) => (
        <AddonInstallChooser
          session={session}
          signal={signal}
          cancel={cancel}
          install={install}
          close={() => close(null)}
        />
      ),
    }).result
  } finally {
    cancel()
    await operation
    await cancellation
  }
}

function AddonInstallChooser({
  session,
  signal,
  cancel,
  install,
  close,
}: {
  session: AddonInstallSession
  signal: AbortSignal
  cancel: () => void
  install: (keys: string[]) => Promise<AddonInstallResult[]>
  close: () => void
}) {
  const id = useId()
  const closeButton = useRef<HTMLButtonElement>(null)
  const [selected, setSelected] = useState(
    () =>
      new Set(
        session.candidates
          .filter((candidate) => candidate.status === 'installable')
          .map((candidate) => candidate.key),
      ),
  )
  const [busy, setBusy] = useState(false)
  const [canceled, setCanceled] = useState(false)
  const [results, setResults] = useState<AddonInstallResult[] | null>(null)
  const completed = new Set(
    results
      ?.filter((result) => result.status === 'installed')
      .map(({ key }) => key),
  )
  const providers = new Map(
    session.providers.map((manifest) => [manifest.id, manifest]),
  )
  for (const candidate of session.candidates)
    if (
      candidate.manifest &&
      (completed.has(candidate.key) ||
        (candidate.status === 'installable' && selected.has(candidate.key)))
    )
      providers.set(candidate.manifest.id, candidate.manifest)
  const missing = new Map(
    session.candidates.map((candidate) => {
      const pending = [...(candidate.manifest?.requires?.addons ?? [])]
      const visited = new Set<string>()
      const unavailable: string[] = []
      for (const dependency of pending) {
        if (dependency.optional || visited.has(dependency.id)) continue
        visited.add(dependency.id)
        const provider = providers.get(dependency.id)
        if (provider) pending.push(...(provider.requires?.addons ?? []))
        else unavailable.push(dependency.id)
      }
      return [candidate.key, unavailable]
    }),
  )
  const remaining = session.candidates.filter(
    (candidate) =>
      candidate.status === 'installable' && !completed.has(candidate.key),
  )
  const keys = remaining
    .filter(
      (candidate) =>
        selected.has(candidate.key) && !missing.get(candidate.key)?.length,
    )
    .map((candidate) => candidate.key)
  useEffect(() => {
    if (results) closeButton.current?.focus()
  }, [results])
  useEffect(() => {
    if (signal.aborted) cancel()
    signal.addEventListener('abort', cancel, { once: true })
    return () => signal.removeEventListener('abort', cancel)
  }, [signal, cancel])
  async function submit() {
    if (busy || canceled || !keys.length || signal.aborted) return
    setBusy(true)
    const next = await install(keys)
    if (signal.aborted) return
    setResults((previous) => [
      ...(previous ?? []).filter((result) => !keys.includes(result.key)),
      ...next,
    ])
    setBusy(false)
  }
  return (
    <>
      <ul className="addon-install-list">
        {session.candidates.map((candidate, index) => {
          const manifest = candidate.manifest
          const details = `${id}-${index}-details`
          const result = results?.find((item) => item.key === candidate.key)
          const unavailable = missing.get(candidate.key) ?? []
          const required = manifest?.requires?.addons?.filter(
            (provider) => !provider.optional,
          )
          return (
            <li key={candidate.key}>
              <label className="addon-install-label">
                <input
                  type="checkbox"
                  checked={selected.has(candidate.key) && !unavailable.length}
                  disabled={
                    busy ||
                    canceled ||
                    completed.has(candidate.key) ||
                    candidate.status !== 'installable' ||
                    !!unavailable.length
                  }
                  aria-describedby={details}
                  onChange={(event) => {
                    const checked = event.target.checked
                    setSelected((current) => {
                      const next = new Set(current)
                      if (checked) next.add(candidate.key)
                      else next.delete(candidate.key)
                      return next
                    })
                  }}
                />
                <strong>{manifest?.name ?? candidate.folder}</strong>
              </label>
              <div id={details} className="addon-install-details">
                {manifest && (
                  <p>{`${manifest.id} · v${manifest.version} · ${manifest.kind ?? 'extension'}`}</p>
                )}
                <p>{`Folder: ${candidate.folder}`}</p>
                <p>
                  {session.source === 'local'
                    ? 'Source: local folder'
                    : `Source: third-party · ${session.host ?? ''}`}
                </p>
                {manifest?.kind === 'extension' && (
                  <>
                    <p>
                      Can run code and read or edit your documents. Only install
                      extensions you trust.
                    </p>
                    <p>
                      {manifest.capabilities
                        ? manifest.capabilities.length
                          ? `SDK capabilities: ${manifest.capabilities.join(', ')}`
                          : 'SDK capabilities: document helpers only'
                        : 'SDK capabilities: all'}
                    </p>
                  </>
                )}
                {manifest?.kind === 'theme' && <p>Color data only.</p>}
                {!!manifest?.network?.origins.length && (
                  <p>{`Network origins: ${manifest.network.origins.join(', ')}`}</p>
                )}
                {!!required?.length && (
                  <p>
                    Requires:{' '}
                    {required
                      .map((provider) => {
                        const paths = session.candidates
                          .filter((item) => item.manifest?.id === provider.id)
                          .map((item) => item.folder)
                        return paths.length
                          ? `${provider.id} (${paths.join(', ')})`
                          : provider.id
                      })
                      .join('; ')}
                  </p>
                )}
                {candidate.replaces && (
                  <p>
                    {`Replaces v${candidate.replaces.version} (${candidate.replaces.source}) with v${manifest?.version} (${session.source}).`}
                  </p>
                )}
                {candidate.status !== 'installable' && (
                  <p>
                    {candidate.status === 'invalid'
                      ? 'Invalid package'
                      : 'Blocked package'}
                  </p>
                )}
                {!!unavailable.length && candidate.status === 'installable' && (
                  <p>{`Select required providers: ${unavailable.join(', ')}`}</p>
                )}
                {candidate.reasons.map((reason) => (
                  <p key={reason}>{reason}</p>
                ))}
              </div>
              <p aria-live="polite" aria-atomic="true">
                {busy && keys.includes(candidate.key)
                  ? 'Installing…'
                  : result
                    ? result.status === 'installed'
                      ? 'Installed — disabled'
                      : `Failed: ${result.error ?? 'Could not install this addon.'}`
                    : results && candidate.status === 'installable'
                      ? 'Not selected'
                      : null}
              </p>
            </li>
          )
        })}
      </ul>
      <div className="dialog-actions">
        <Button
          ref={closeButton}
          onClick={() => {
            if (busy) {
              setCanceled(true)
              cancel()
            } else close()
          }}
        >
          {busy || !results ? 'Cancel' : 'Close'}
        </Button>
        {!canceled && !!remaining.length && (
          <Button
            className="dialog-primary"
            disabled={busy || !keys.length}
            onClick={() => void submit()}
          >
            {busy ? 'Installing…' : `Install selected (${keys.length})`}
          </Button>
        )}
      </div>
    </>
  )
}
