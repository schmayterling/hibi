import type { SourceStore } from './source-buffer.ts'

/** Cooperative iterable driver, loaded only by callers that need it. */
export async function loadSource(
  loader: ReturnType<typeof SourceStore.loader>,
  chunks: AsyncIterable<string> | Iterable<string>,
): Promise<SourceStore> {
  let pending = '',
    reads = 0,
    channel: MessageChannel | undefined
  const pause = () =>
    new Promise<void>((resolve) => {
      const immediate = (
        globalThis as {
          setImmediate?: (callback: () => void) => unknown
        }
      ).setImmediate
      if (typeof immediate === 'function') {
        immediate(resolve)
        return
      }
      channel ??= new MessageChannel()
      channel.port1.onmessage = () => resolve()
      channel.port2.postMessage(null)
    })
  try {
    for await (const chunk of chunks) {
      if (typeof chunk !== 'string')
        throw new Error('Source chunks must be strings.')
      let from = 0
      while (from < chunk.length) {
        const length = Math.min(65536 - pending.length, chunk.length - from)
        pending += chunk.slice(from, from + length)
        from += length
        if (pending.length === 65536) {
          loader.append(pending)
          pending = ''
          reads = 0
          await pause()
        }
      }
      if (++reads >= 64) {
        loader.append(pending)
        pending = ''
        reads = 0
        await pause()
      }
    }
    if (pending) loader.append(pending)
    return loader.finish()
  } finally {
    channel?.port1.close()
    channel?.port2.close()
  }
}
