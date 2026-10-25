export function createScanCoordinator<T>(
  scan: (signal: AbortSignal) => Promise<T>,
  publish: (result: T) => void,
) {
  let generation = 0
  let closed = false
  let task: Promise<T | null> | undefined
  let controller: AbortController | undefined

  return {
    request(): Promise<T | null> {
      if (closed) return Promise.resolve(null)
      generation += 1
      controller?.abort()
      if (!task) {
        const next = (async () => {
          while (!closed) {
            const current = generation
            let result: T
            try {
              controller = new AbortController()
              result = await scan(controller.signal)
            } catch (error) {
              if (current !== generation) continue
              throw error
            }
            if (current !== generation) continue
            if (closed) break
            publish(result)
            return result
          }
          return null
        })().finally(() => {
          if (task === next) {
            task = undefined
            controller = undefined
          }
        })
        task = next
      }
      return task
    },
    invalidate() {
      if (!closed && task) {
        generation += 1
        controller?.abort()
      }
    },
    close() {
      closed = true
      generation += 1
      controller?.abort()
    },
  }
}

export function watchNeedsScan(
  cached: 'file' | 'folder' | null,
  current: 'file' | 'folder' | null,
): boolean {
  return cached !== current || current === 'folder'
}
