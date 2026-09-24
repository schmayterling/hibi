import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { electron } from '../tests/electron.mjs'
import { clickMenu } from '../tests/keyboard.mjs'

const mode = process.argv[2]
if (!['immediate', 'ready'].includes(mode))
  throw new Error('Choose immediate or ready')
const trials = Number(process.argv[3] ?? 1)

async function bounded(request, timeout) {
  let timer
  try {
    return await Promise.race([
      request.then(
        (value) => ({ status: 'ok', value }),
        () => ({ status: 'error' }),
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ status: 'timeout' }), timeout)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function probe() {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-raf-probe-'))
  const result = {}
  let app
  try {
    app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${profile}`],
      timeout: 10000,
      testShowAtReady: mode === 'ready',
    })
    await app.evaluate(({ app }) => {
      globalThis.__ciGpuExits = 0
      app.on('child-process-gone', (_event, details) => {
        if (details.type === 'GPU') globalThis.__ciGpuExits++
      })
    })
    const page = await app.firstWindow()
    page.setDefaultTimeout(2000)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await clickMenu(app, 'Settings')
    const about = page
      .getByRole('tablist', { name: /settings categories/i })
      .getByRole('tab', { name: 'About', exact: true })
    await about.waitFor()
    const native = await bounded(
      app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        return {
          visible: window.isVisible(),
          focused: window.isFocused(),
          painted: !!performance.getEntriesByName('hibi:window-painted').length,
        }
      }),
      1500,
    )
    result.native = native.status === 'ok' ? native.value : null
    await page.evaluate(() => {
      window.__ciRafProbe = 0
      const tick = () => {
        window.__ciRafProbe++
        if (window.__ciRafProbe < 5) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    await delay(250)
    const frames = await bounded(
      page.evaluate(() => window.__ciRafProbe),
      1500,
    )
    result.frames = frames.status === 'ok' ? frames.value : null
    try {
      await about.click({ timeout: 1200 })
      result.click =
        (await about.getAttribute('aria-selected')) === 'true'
          ? 'selected'
          : 'unselected'
    } catch (error) {
      result.click = error?.name === 'TimeoutError' ? 'timeout' : 'error'
    }
    const gpu = await bounded(
      app.evaluate(({ app }) => ({
        exits: globalThis.__ciGpuExits,
        alive: app.getAppMetrics().some(({ type }) => type === 'GPU'),
      })),
      500,
    )
    result.gpu = gpu.status === 'ok' ? gpu.value : null
    const nativeAfter = await bounded(
      app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        return {
          visible: window.isVisible(),
          focused: window.isFocused(),
          painted: !!performance.getEntriesByName('hibi:window-painted').length,
        }
      }),
      500,
    )
    result.nativeAfter = nativeAfter.status === 'ok' ? nativeAfter.value : null
    if (result.frames === 0) {
      result.capture = await bounded(
        app.evaluate(async ({ BrowserWindow }) => {
          const image = await BrowserWindow.getAllWindows()[0].capturePage()
          return { empty: image.isEmpty(), size: image.getSize() }
        }),
        500,
      )
    }
  } catch (error) {
    result.error = error instanceof Error ? error.name : 'Unknown'
  } finally {
    if (app) {
      try {
        await app.close()
      } catch {
        result.cleanup = 'failed'
      }
    }
    try {
      await rm(profile, { recursive: true, force: true })
    } catch {
      result.profileCleanup = 'failed'
    }
  }
  return result
}

const results = []
for (let index = 0; index < trials; index++) results.push(await probe())
const count = (check) => results.filter(check).length
const indices = (check) =>
  results.flatMap((result, index) => (check(result) ? [index + 1] : []))
console.log(
  JSON.stringify({
    mode,
    trials: results.length,
    setupErrors: count((result) => !!result.error),
    rafZero: count((result) => result.frames === 0),
    rafZeroIndices: indices((result) => result.frames === 0),
    rafOneToFour: count((result) => result.frames > 0 && result.frames < 5),
    rafUnavailable: count((result) => result.frames == null),
    clickSelected: count((result) => result.click === 'selected'),
    clickTimeout: count((result) => result.click === 'timeout'),
    clickTimeoutIndices: indices((result) => result.click === 'timeout'),
    clickError: count((result) => result.click === 'error'),
    clickNotAttempted: count((result) => result.click == null),
    unfocused: count((result) => result.native?.focused === false),
    invisible: count((result) => result.native?.visible === false),
    paintedAtLaunch: count((result) => result.native?.painted === true),
    paintedAtEnd: count((result) => result.nativeAfter?.painted === true),
    visibleAtEnd: count((result) => result.nativeAfter?.visible === true),
    captureOk: count((result) => result.capture?.status === 'ok'),
    captureEmpty: count(
      (result) => result.capture?.status === 'ok' && result.capture.value.empty,
    ),
    captureTimeout: count((result) => result.capture?.status === 'timeout'),
    captureError: count((result) => result.capture?.status === 'error'),
    gpuExits: results.reduce(
      (sum, result) => sum + (result.gpu?.exits ?? 0),
      0,
    ),
    gpuMissing: count((result) => result.gpu?.alive === false),
    cleanupErrors: count((result) => result.cleanup || result.profileCleanup),
  }),
)
