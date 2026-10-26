import { parentPort, workerData } from 'node:worker_threads'
import { WorkspaceTextIndex } from './workspace-text-index.ts'

const port = parentPort as NonNullable<typeof parentPort>
type DraftReply = { text: string | null; failed?: boolean }
const drafts = new Map<
  number,
  {
    resolve: (value: DraftReply) => void
    reject: (reason: Error) => void
  }
>()
let draftRequest = 0
const index = await WorkspaceTextIndex.open({
  ...workerData,
  async *readDraft(query: string, path: string) {
    let offset = 0
    for (;;) {
      const id = ++draftRequest
      const reply = await new Promise<DraftReply>((resolve, reject) => {
        drafts.set(id, { resolve, reject })
        port.postMessage({ type: 'draft', id, query, path, offset })
      })
      if (reply.failed) throw new Error('This search changed. Start again.')
      if (reply.text === null) return
      offset += reply.text.length
      yield reply.text
    }
  },
})
const expiry = setInterval(() => {
  void index.expire()
}, 30_000)
expiry.unref()

let commands = Promise.resolve()
port.on('message', (message) => {
  if (message.type === 'draft') {
    const pending = drafts.get(message.id)
    drafts.delete(message.id)
    pending?.resolve(message)
    return
  }
  commands = commands
    .then(async () => {
      let value: unknown
      if (message.type === 'begin')
        value = index.createQuery(
          message.query,
          message.drafts,
          message.includePaths,
          new Int32Array(message.cancel),
        )
      else if (message.type === 'page')
        value = await index.page(message.queryId, message.limit)
      else if (message.type === 'cancel')
        value = await index.cancel(message.queryId)
      else if (message.type === 'invalidate')
        value = index.invalidate(message.paths)
      else if (message.type === 'idle') {
        await index.idle()
        value = { ...index.counters }
      } else if (message.type === 'close') {
        clearInterval(expiry)
        for (const draft of drafts.values())
          draft.reject(new Error('This search changed. Start again.'))
        drafts.clear()
        await index.close()
      }
      port.postMessage({ type: 'reply', id: message.id, value })
      if (message.type === 'close') port.close()
    })
    .catch((error: unknown) => {
      const code = (error as { errcode?: number }).errcode
      port.postMessage({
        type: 'reply',
        id: message.id,
        failed: true,
        fatal: index.failed || code === 11 || code === 26,
        corrupt: code === 11 || code === 26,
        error:
          error instanceof Error
            ? error.message
            : 'This search changed. Start again.',
      })
    })
})
port.postMessage({ type: 'ready' })
