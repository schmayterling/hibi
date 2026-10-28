// A named last resort for livelocks that keep reporting activity.
export const WORKER_HANG_TIMEOUT = 10 * 60 * 1000

// Worker ELU includes time inside synchronous parser calls, but excludes idle waits.
export const workerBusyProgress = (worker) =>
  Math.floor(worker?.performance.eventLoopUtilization().active ?? 0)

/** Wait for completion while work advances; the timeout measures only silence. */
export function waitForProgress(
  predicate,
  progress,
  timeout = 2000,
  message = 'Worker made no progress',
  { timers = globalThis, subscribe } = {},
) {
  return new Promise((resolve, reject) => {
    let previous = progress(),
      settled = false,
      stalled,
      unsubscribe
    const finish = (error, value) => {
      if (settled) return
      settled = true
      timers.clearTimeout(timer)
      clearInterval(poll)
      clearImmediate(stalled)
      unsubscribe?.()
      if (error) reject(error)
      else resolve(value)
    }
    const check = () => {
      if (settled) return true
      try {
        const value = predicate()
        if (value) {
          finish(null, value)
          return true
        }
        const next = progress()
        if (next !== previous) {
          previous = next
          timer.refresh()
          return true
        }
      } catch (error) {
        finish(error)
        return true
      }
      return false
    }
    const timer = timers.setTimeout(() => {
      if (check()) return
      const checkpoint = previous
      // Deliver already-queued worker replies before declaring a silent worker.
      stalled = setImmediate(() => {
        if (check() || previous !== checkpoint) return
        const error = typeof message === 'function' ? message() : message
        finish(error instanceof Error ? error : new Error(error))
      })
    }, timeout)
    const poll = setInterval(check, 5)
    unsubscribe = subscribe?.(check)
    check()
  })
}
