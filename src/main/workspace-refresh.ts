export function createScanCoordinator<T>(
  scan: (signal: AbortSignal) => Promise<T>,
  publish: (result: T) => void,
) {
  let closed = false
  let running = false
  let controller: AbortController | undefined
  let queued: Promise<T | null> | undefined
  let pending:
    | {
        resolve: (result: T | null) => void
        reject: (error: unknown) => void
      }
    | undefined

  async function run() {
    running = true
    try {
      while (!closed && pending) {
        // Requests arriving during this scan belong to the next scan.
        const waiting = pending
        pending = undefined
        queued = undefined
        controller = new AbortController()
        try {
          const result = await scan(controller.signal)
          // Same-root changes queue a follow-up; only closure makes this result obsolete.
          if (!closed) publish(result)
          waiting.resolve(closed ? null : result)
        } catch (error) {
          if (closed) waiting.resolve(null)
          else waiting.reject(error)
        }
      }
    } finally {
      running = false
      controller = undefined
    }
  }

  function request(): Promise<T | null> {
    if (closed) return Promise.resolve(null)
    if (!queued)
      queued = new Promise<T | null>((resolve, reject) => {
        pending = { resolve, reject }
      })
    const task = queued
    if (!running) void run()
    return task
  }

  return {
    request,
    close() {
      closed = true
      controller?.abort()
      pending?.resolve(null)
      pending = undefined
      queued = undefined
    },
  }
}

export function watchNeedsScan(
  cached: 'file' | 'folder' | null,
  current: 'file' | 'folder' | null,
): boolean {
  return cached !== current || current === 'folder'
}
