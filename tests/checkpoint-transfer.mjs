import { createCheckpointVerifier } from '../src/shared/document-checkpoint-stream.ts'
import { SourceTransferSender } from '../src/shared/source-transfer.ts'

export function createCheckpointTransfer(read) {
  const verifier = createCheckpointVerifier(read),
    senders = new Map()
  let sequence = 0
  return {
    checkpoint(head, source) {
      const checkpoint = {
        ...head,
        streamId: `checkpoint-${sequence++}`,
        length: source.length,
      }
      senders.set(
        checkpoint.streamId,
        new SourceTransferSender(checkpoint, [source]),
      )
      return checkpoint
    },
    async verify(checkpoint, progress = () => {}) {
      const sender = senders.get(checkpoint.streamId)
      let request = { streamId: checkpoint.streamId, sequence: 0 }
      try {
        verifier.begin(checkpoint)
        for (;;) {
          const chunk = sender.read(request)
          request = verifier.append(chunk)
          await progress()
          if (chunk.done) break
        }
        sender.finish(request)
        return verifier.finish(request)
      } finally {
        sender?.close()
        senders.delete(checkpoint.streamId)
        verifier.abort(request)
      }
    },
  }
}
