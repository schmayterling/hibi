import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import { diagnosticEvents } from '../src/shared/local-diagnostics.ts'
import { electron, stopElectronTree } from './electron.mjs'

async function launchFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'hibi-diagnostic-native-'))
  await mkdir(join(root, 'profile'))
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'hibi-diagnostic-fixture',
      version: '0.1.0',
      type: 'module',
      main: 'index.js',
    }),
  )
  await writeFile(
    join(root, 'utility.cjs'),
    "process.parentPort.once('message', ({data}) => process.exit(data));",
  )
  await writeFile(
    join(root, 'preload.cjs'),
    "throw new Error('PRIVATE_PRELOAD_MESSAGE')",
  )
  await build({
    entryPoints: [resolve('tests/fixtures/local-diagnostics-runtime.ts')],
    outfile: join(root, 'index.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['electron'],
    define: {
      __HIBI_DIAGNOSTIC_BUILD__: '"unknown"',
      __HIBI_DIAGNOSTIC_PROFILE__: '"debug"',
    },
  })
  // Measure only the application's own listener policy.
  const app = await electron.launch({ args: [root], diagnostics: false })
  t.after(async () => {
    await app.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  })
  await app.firstWindow()
  return { root, app }
}

test('pinned Electron exposes exact utility identity and passive JS observation preserves fatal policy', {
  timeout: 30000,
}, async (t) => {
  const { root, app } = await launchFixture(t)
  const policy = await app.evaluate(() => globalThis.diagnosticFixture.policy())
  assert.equal(policy.after.uncaught, policy.before.uncaught)
  assert.equal(policy.after.rejection, policy.before.rejection)
  assert.equal(policy.after.monitor, policy.before.monitor + 1)
  const unexpected = await app.evaluate(() =>
    globalThis.diagnosticFixture.utility(false),
  )
  assert.equal(unexpected.exact, true)
  assert.equal(unexpected.utilityExit, 7)
  assert.ok(Number.isInteger(unexpected.exitCode))
  assert.ok(unexpected.report.includes(`"exitCode":${unexpected.exitCode}`))
  assert.match(unexpected.report, /COMPILER_PROCESS_FAILED/)
  assert.match(unexpected.report, /unavailable-native/)
  assert.ok(!unexpected.report.includes('hibi-diagnostic-'))
  const expected = await app.evaluate(() =>
    globalThis.diagnosticFixture.utility(true),
  )
  assert.equal(expected.exact, true)
  assert.ok(Number.isInteger(expected.exitCode))
  const count = (text, code) =>
    text.split('\n').filter((line) => line.includes(`"code":"${code}"`)).length
  assert.equal(count(expected.report, 'COMPILER_PROCESS_FAILED'), 1)
  await app.evaluate(() => globalThis.diagnosticFixture.exception())
  let captured
  for (let i = 0; i < 100; i++) {
    captured = await app.evaluate(() => globalThis.diagnosticFixture.report())
    if (captured.text.includes('MAIN_EXCEPTION') && captured.dialogs) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(captured.dialogs, 1)
  assert.ok(captured.text.includes('MAIN_EXCEPTION'))
  assert.ok(captured.text.includes('"frames":[[1,'))
  assert.ok(!captured.text.includes('PRIVATE_MAIN_EXCEPTION'))
  assert.ok(!captured.text.includes(root))
  await app.evaluate(() => globalThis.diagnosticFixture.rejection())
  await new Promise((resolve) => setTimeout(resolve, 100))
  captured = await app.evaluate(() => globalThis.diagnosticFixture.report())
  // This pinned runtime's default rejection policy does not reach the monitor.
  // No new rejection listener is installed to manufacture coverage.
  assert.equal(captured.dialogs, 1)
  assert.ok(!captured.text.includes('MAIN_REJECTION'))
  assert.ok(!captured.text.includes('PRIVATE_MAIN_REJECTION'))
  const preload = await app.evaluate(() =>
    globalThis.diagnosticFixture.preload(),
  )
  assert.match(preload, /PRELOAD_ERROR/)
  assert.doesNotMatch(preload, /PRIVATE_PRELOAD|preload\.cjs/)
  const crash = await app.evaluate(() =>
    globalThis.diagnosticFixture.rendererCrash(),
  )
  assert.match(crash.report, /RENDERER_GONE/)
  assert.ok(crash.report.includes(`"reason":"${crash.reason}"`))
  assert.ok(crash.report.includes(`"exitCode":${crash.exitCode}`))
  assert.ok(crash.report.includes('unavailable-native'))
  const crashed = app.process()
  const closed = once(crashed, 'close')
  stopElectronTree(crashed)
  await closed
  const restarted = await electron.launch({ args: [root], diagnostics: false })
  try {
    await restarted.firstWindow()
    const previous = await restarted.evaluate(() =>
      globalThis.diagnosticFixture.report(),
    )
    assert.match(previous.text, /PREVIOUS_RUN_UNCONFIRMED/)
    assert.doesNotMatch(previous.text, /PRIVATE_|hibi-diagnostic-/)
  } finally {
    // This profile cannot be removed until Playwright has closed its transport.
    await restarted.close({ waitForTransport: true })
  }
})

test('aborted navigation is informational while real load failure remains critical', async (t) => {
  const { app } = await launchFixture(t)
  const { text } = await app.evaluate(async ({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents
    contents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'app://hibi/', true)
    contents.emit(
      'did-fail-load',
      {},
      -105,
      'ERR_NAME_NOT_RESOLVED',
      'https://PRIVATE_URL/',
      true,
    )
    contents.emit(
      'did-fail-load',
      {},
      -105,
      'ERR_NAME_NOT_RESOLVED',
      'https://PRIVATE_SUBFRAME/',
      false,
    )
    return globalThis.diagnosticFixture.report()
  })
  const rows = text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  const aborted = rows.filter((row) => row.code === 'NAVIGATION_ABORTED')
  const failed = rows.filter((row) => row.code === 'NAVIGATION_FAILED')
  assert.equal(aborted.length, 1)
  assert.equal(aborted[0].severity, 'info')
  assert.equal(diagnosticEvents.NAVIGATION_ABORTED.critical, false)
  assert.equal(failed.length, 1)
  assert.equal(failed[0].severity, 'error')
  assert.equal(diagnosticEvents.NAVIGATION_FAILED.critical, true)
  assert.doesNotMatch(text, /PRIVATE_|ERR_ABORTED|ERR_NAME_NOT_RESOLVED/)
})

test('main-loop sampling stops while hidden, minimized, suspended or failed', {
  timeout: 10000,
}, async (t) => {
  const { app } = await launchFixture(t)
  await app.evaluate(() => globalThis.diagnosticFixture.report())
  const sampling = () =>
    app.evaluate(() => globalThis.diagnosticFixture.sampling())
  const initial = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    return {
      ...globalThis.diagnosticFixture.sampling(),
      visible: window.isVisible() && !window.isMinimized(),
    }
  })
  assert.equal(initial.armedBeforeReady, false)
  assert.equal(initial.armed, initial.visible)
  assert.equal(
    await app.evaluate(() => globalThis.diagnosticFixture.visibility(true)),
    true,
  )
  assert.equal(
    await app.evaluate(() => globalThis.diagnosticFixture.visibility(false)),
    false,
  )
  assert.equal(
    await app.evaluate(() =>
      globalThis.diagnosticFixture.visibility(true, true),
    ),
    false,
  )
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.isMinimized = () => false
    window.emit('restore')
  })
  assert.equal((await sampling()).armed, true)
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('suspend'))
  assert.equal((await sampling()).armed, false)
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'))
  assert.equal((await sampling()).armed, true)
  assert.equal(
    await app.evaluate(() => globalThis.diagnosticFixture.failSink()),
    'failed',
  )
  assert.equal((await sampling()).armed, false)
  await app.evaluate(({ powerMonitor }) => {
    globalThis.diagnosticFixture.visibility(true)
    powerMonitor.emit('resume')
  })
  assert.equal((await sampling()).armed, false)
})
