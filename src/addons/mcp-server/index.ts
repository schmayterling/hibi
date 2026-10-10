import { lazy } from 'react'
import { errorMessage } from '../../shared/errors'
import { type DocumentsApi, defineAddon } from '../api'
import manifest from './manifest'
import { getPreferences, settingsEvent } from './preferences'
import { type OpenEditReply, type OpenEditRequest, planEdits } from './types'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Apply an edit_document request to its open tab as unsaved changes. */
async function applyOpenEdit(
  documents: DocumentsApi,
  { id, tabId, edits }: OpenEditRequest,
): Promise<OpenEditReply> {
  let stale = 0
  for (let attempt = 0; attempt < 6; attempt++) {
    const open = documents.listOpen().find((entry) => entry.tabId === tabId)
    if (!open)
      return { id, ok: false, message: 'The document is no longer open.' }
    const read = documents.readSource(open.target)
    if (read.status !== 'read') return { id, ok: false, message: read.message }
    let changes: ReturnType<typeof planEdits>
    try {
      changes = planEdits(read.source, edits)
    } catch (error) {
      return { id, ok: false, message: errorMessage(error) }
    }
    // Each attempt edits a different version, so it needs its own request ID.
    const result = documents.applyEdits({
      requestId: `${id}.${attempt}`,
      target: read.target,
      changes,
    })
    if (result.status === 'applied')
      return {
        id,
        ok: true,
        message: 'The edits appear in Hibi as unsaved changes.',
      }
    if (result.status === 'stale' && stale++ < 1) continue
    if (result.status !== 'busy' && result.status !== 'composing')
      return { id, ok: false, message: result.message }
    await wait(250)
  }
  return {
    id,
    ok: false,
    message: 'The document is busy. Try again in a moment.',
  }
}

let stop: (() => void) | undefined
export default defineAddon({
  manifest,
  Settings: lazy(() =>
    import('./Settings').then(({ Settings }) => ({ default: Settings })),
  ),
  start({ documents }) {
    const sync = () => {
      void window.hibi
        .invokeAddon(manifest.id, 'start', getPreferences())
        .catch(() => {})
    }
    sync()
    window.addEventListener(settingsEvent, sync)
    let running = true
    void (async () => {
      let reply: OpenEditReply | undefined
      while (running) {
        try {
          const request = (await window.hibi.queryAddon(manifest.id, 'relay', {
            reply,
          })) as OpenEditRequest | null
          reply = undefined
          if (request && running)
            reply = await applyOpenEdit(documents, request).catch((error) => ({
              id: request.id,
              ok: false,
              message: errorMessage(error),
            }))
        } catch {
          // Keep any unsent reply and back off so a failing native side cannot spin.
          await wait(1000)
        }
      }
    })()
    // The main process owns the server and closes it when the addon is disabled;
    // closing one window must not stop it for the others.
    stop = () => {
      running = false
      window.removeEventListener(settingsEvent, sync)
    }
  },
  stop() {
    stop?.()
    stop = undefined
  },
})
