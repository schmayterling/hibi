export const APP_STATE_TIMEOUT = 7000
// The pinned compiler's cold font scan exceeded 30s on hosted Windows runners.
export const NATIVE_FONT_TIMEOUT = process.platform === 'win32' ? 60000 : 30000
export const NATIVE_COMPILER_READY_TIMEOUT = 15000 + NATIVE_FONT_TIMEOUT + 10000

// This Playwright build treats Promise-valued waitForFunction predicates as
// truthy before they resolve. Evaluate and await async checks in the host.
export async function waitForAsync(
  page,
  predicate,
  arg,
  { timeout = APP_STATE_TIMEOUT, polling = 30 } = {},
) {
  const started = performance.now()
  const deadline = started + timeout
  let attempts = 0
  let deadlineTimer
  let pollTimer
  const timedOut = () =>
    new Error(
      `async condition did not settle after ${Math.round(performance.now() - started)} ms (${attempts} checks): ${predicate}`,
    )
  const expired = new Promise((_, reject) => {
    deadlineTimer = setTimeout(() => reject(timedOut()), timeout)
  })
  try {
    for (;;) {
      if (performance.now() >= deadline) throw timedOut()
      attempts++
      const ready = await Promise.race([page.evaluate(predicate, arg), expired])
      if (performance.now() >= deadline) throw timedOut()
      if (ready) return
      await Promise.race([
        new Promise((resolve) => {
          pollTimer = setTimeout(resolve, polling)
        }),
        expired,
      ])
    }
  } finally {
    clearTimeout(deadlineTimer)
    clearTimeout(pollTimer)
  }
}
