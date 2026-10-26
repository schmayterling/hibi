import assert from 'node:assert/strict'
import { SourceTransferSender } from '../src/shared/source-transfer.ts'

export function loadWorker(
  worker,
  replies,
  source,
  epoch,
  document = { tabId: 'a', revision: 0 },
  version = 0,
) {
  const sender = new SourceTransferSender(
    {
      ...document,
      contentVersion: version,
      streamId: crypto.randomUUID(),
      length: source.length,
    },
    [source],
  )
  let request = { streamId: sender.head.streamId, sequence: 0 }
  try {
    worker.receive({ type: 'load-start', epoch, head: sender.head })
    assert.deepEqual(replies.at(-1), { type: 'load-ack', epoch, request })
    for (;;) {
      const chunk = sender.read(request)
      worker.receive({ type: 'load-chunk', epoch, chunk })
      request = { streamId: chunk.streamId, sequence: chunk.sequence + 1 }
      assert.deepEqual(replies.at(-1), { type: 'load-ack', epoch, request })
      if (chunk.done) break
    }
    sender.finish(request)
    worker.receive({ type: 'load-finish', epoch, request })
    assert.deepEqual(replies.at(-1), { type: 'ack', epoch, version })
  } finally {
    sender.close()
  }
}
