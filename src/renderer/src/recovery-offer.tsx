import { useState } from 'react'
import type { RecoveryCopy, RecoveryWaiting } from '../../shared/recovery'
import { RECOVERY_OPEN_LIMIT } from '../../shared/recovery'
import { Button } from '../../ui/Controls'
import type { DialogApi } from '../../ui/dialogs'
import type { ToastApi } from '../../ui/toasts'
import './recovery-offer.css'

const opensAs: Record<RecoveryCopy['state'], { description: string }> = {
  unchanged: {
    description: 'Opens the note with this text as unsaved changes.',
  },
  changed: {
    description:
      'The file changed after this text was written. It opens as a separate note, and the file stays as it is.',
  },
  missing: {
    description:
      'The file was moved or deleted. This text opens as a separate note.',
  },
  untitled: {
    description: 'This note was never saved. It opens as a new note.',
  },
}
const size = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`

type Choice = { restore: string }

function CopyList({
  copies,
  close,
}: {
  copies: readonly RecoveryCopy[]
  close: (value: Choice | null) => void
}) {
  const [left, setLeft] = useState(copies)
  return (
    <ul className="recovery-copies">
      {left.map((copy) => (
        <li key={copy.id} data-recovery-copy={copy.id}>
          <strong>{copy.name}</strong>
          {copy.folder && <p>{copy.folder}</p>}
          <p>
            {new Date(copy.time).toLocaleString()} · {size(copy.bytes)}
          </p>
          {copy.preview && <blockquote>{copy.preview}</blockquote>}
          <p>{opensAs[copy.state].description}</p>
          <Button
            className="dialog-primary"
            aria-label={`Restore ${copy.name}`}
            onClick={() => close({ restore: copy.id })}
          >
            Restore
          </Button>{' '}
          <Button
            aria-label={`Discard ${copy.name}`}
            onClick={async () => {
              await window.hibi.discardRecovery(copy.id)
              const rest = left.filter((other) => other !== copy)
              setLeft(rest)
              if (!rest.length) close(null)
            }}
          >
            Discard
          </Button>
        </li>
      ))}
    </ul>
  )
}

function chooseCopy(dialogs: DialogApi, copies: readonly RecoveryCopy[]) {
  return dialogs.open<Choice>({
    title: 'Get back unsaved text?',
    description:
      'Hibi closed before these notes were saved. Your files have not been changed.',
    closeOnOutsideClick: false,
    content: ({ close }) => <CopyList copies={copies} close={close} />,
    footer: ({ close }) => (
      <Button onClick={() => close(null)}>Decide later</Button>
    ),
  })
}

/** Offers, or opens, the text an earlier run left unsaved. */
export async function offerRecovery(
  waiting: RecoveryWaiting,
  app: {
    dialogs: DialogApi
    toasts: ToastApi
    tabsEnabled: boolean
    /** Opens a copy once the app is free; returns the tab it became. */
    open: (id: string) => Promise<string | undefined>
    show: (tabId: string) => void
  },
) {
  let { copies } = waiting
  if (waiting.newer)
    app.toasts.show({
      message:
        waiting.newer === 1
          ? 'A newer version of Hibi left a recovery copy. Update Hibi to get it back.'
          : `A newer version of Hibi left ${waiting.newer} recovery copies. Update Hibi to get them back.`,
    })
  if (waiting.openAtLaunch && copies.length) {
    // One at a time, each its own file operation, so the app stays free between them.
    let shown = ''
    for (const copy of copies.slice(
      0,
      app.tabsEnabled ? RECOVERY_OPEN_LIMIT : 1,
    )) {
      const tabId = await app.open(copy.id)
      shown ||= tabId ?? ''
    }
    const before = copies.length
    ;({ copies } = await window.hibi.waitingRecovery())
    const opened = before - copies.length
    if (opened)
      app.toasts.show({
        message:
          opened === 1
            ? 'Hibi opened a note with unsaved text.'
            : `Hibi opened ${opened} notes with unsaved text.`,
        ...(shown
          ? {
              action: {
                label: 'Show unsaved text',
                run: () => app.show(shown),
              },
            }
          : {}),
      })
  }
  while (copies.length) {
    const choice = await chooseCopy(app.dialogs, copies).result
    if (!choice) {
      ;({ copies } = await window.hibi.waitingRecovery())
      if (copies.length) await window.hibi.dismissRecovery()
      return
    }
    await app.open(choice.restore)
    ;({ copies } = await window.hibi.waitingRecovery())
  }
}
