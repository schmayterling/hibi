import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'
import { electron } from './electron.mjs'

test('both renderer profiles preserve native error propagation, safe original locations, recovery actions and listener disposal', {
  timeout: 30000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-log-renderer-'))
  let app
  t.after(async () => {
    try {
      await app?.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  await build({
    configFile: false,
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
    esbuild: { jsx: 'automatic' },
    build: {
      outDir: root,
      emptyOutDir: false,
      lib: {
        entry: resolve('tests/fixtures/local-diagnostics-renderer.tsx'),
        name: 'DiagnosticHarness',
        formats: ['iife'],
        fileName: () => 'harness.js',
      },
    },
  })
  await writeFile(
    join(root, 'index.html'),
    '<!doctype html><body><script src="harness.js"></script></body>',
  )
  await writeFile(
    join(root, 'worker.js'),
    "throw new Error('PRIVATE_NATIVE_WORKER_MESSAGE')",
  )
  await writeFile(
    join(root, 'main.cjs'),
    `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(root, 'profile'))});if(process.platform==='darwin')app.setActivationPolicy('accessory');app.whenReady().then(()=>{const w=new BrowserWindow({show:false,focusable:false,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});w.loadFile(${JSON.stringify(join(root, 'index.html'))});});`,
  )
  app = await electron.launch({ args: [join(root, 'main.cjs')] })
  const page = await app.firstWindow()
  page.setDefaultTimeout(6000)
  const read = () => page.evaluate(() => window.diagnosticHarness.snapshot())
  const count = (records, code) =>
    records.filter((r) => JSON.parse(r).code === code).length
  for (const profile of ['release', 'debug']) {
    await page.goto(
      `${pathToFileURL(join(root, 'index.html')).href}?profile=${profile}`,
    )
    await page.getByRole('button', { name: 'Trigger render failure' }).waitFor()
    await page.waitForFunction(() => window.diagnosticHarness)
    await page.evaluate(() => {
      const input = document.createElement('textarea')
      document.body.append(input)
      input.value = 'PRIVATE_TYPED_PASTED_IME_雪'
      input.dispatchEvent(
        new InputEvent('input', { bubbles: true, data: 'PRIVATE_INPUT' }),
      )
      input.dispatchEvent(
        new CompositionEvent('compositionend', {
          bubbles: true,
          data: 'PRIVATE_IME',
        }),
      )
      input.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key: 'PRIVATE_KEY' }),
      )
      const transfer = new DataTransfer()
      transfer.setData('text/plain', 'PRIVATE_CLIPBOARD')
      input.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, clipboardData: transfer }),
      )
      console.error('PRIVATE_CONSOLE', { source: 'PRIVATE_DOCUMENT' })
      input.remove()
    })
    assert.deepEqual((await read()).records, [])
    const observed = page.waitForEvent('pageerror')
    await page.evaluate(() => window.diagnosticHarness.exception())
    assert.match((await observed).message, /PRIVATE_RENDERER_MESSAGE/)
    await page.waitForFunction(() =>
      window.diagnosticHarness
        .snapshot()
        .records.some((r) => r.includes('RENDERER_ERROR')),
    )
    let state = await read()
    assert.equal(state.reads, 0)
    const error = JSON.parse(
      state.records.find((r) => r.includes('RENDERER_ERROR')),
    )
    assert.equal(error.stackStatus, 'captured')
    assert.equal(error.frames[0][0], 100)
    await page.evaluate(() => {
      window.diagnosticHarness.install()
      window.diagnosticHarness.clear()
    })
    await page.evaluate(() => window.diagnosticHarness.actualWorker())
    state = await read()
    const workerFailure = JSON.parse(
      state.records.find((r) => r.includes('SOURCE_WORKER_FAILED')),
    )
    assert.equal(workerFailure.frames[0][0], 101)
    assert.doesNotMatch(JSON.stringify(state.records), /PRIVATE_|worker\.js/)
    const rejected = page.waitForEvent('pageerror')
    await page.evaluate(() => window.diagnosticHarness.rejection())
    await rejected
    await page.waitForFunction(() =>
      window.diagnosticHarness
        .snapshot()
        .records.some((r) => r.includes('RENDERER_REJECTION')),
    )
    assert.equal(await page.evaluate(() => window.diagnosticHarness.inert()), 0)
    await page.evaluate(() => {
      window.diagnosticHarness.install()
      window.diagnosticHarness.clear()
      window.diagnosticHarness.worker()
    })
    state = await read()
    assert.equal(count(state.records, 'SOURCE_WORKER_FAILED'), 1)
    assert.equal(state.reads, 0)
    await page.evaluate(() => {
      window.diagnosticHarness.install()
      window.diagnosticHarness.install()
      window.diagnosticHarness.clear()
    })
    await page.getByRole('button', { name: 'Trigger render failure' }).click()
    await page.getByRole('main', { name: 'Editor recovery' }).waitFor()
    await page.getByRole('button', { name: 'Save a copy' }).click()
    await page.getByText('Copy saved.', { exact: true }).waitFor()
    state = await read()
    assert.equal(count(state.records, 'REACT_RENDER_FAILED'), 1)
    const react = JSON.parse(
      state.records.find((r) => JSON.parse(r).code === 'REACT_RENDER_FAILED'),
    )
    assert.equal(react.frames[0][0], 100)
    assert.equal(state.saves, 1)
    assert.ok(state.reads > 0) // Existing RecoveryScreen owns this source read.
    for (const wire of state.records) {
      assert.doesNotMatch(wire, /PRIVATE_|file:|harness|node_modules/)
      assert.ok(Buffer.byteLength(wire) <= (profile === 'debug' ? 8192 : 4096))
    }
    await page.evaluate(() => {
      window.diagnosticHarness.stop()
      window.diagnosticHarness.clear()
      window.diagnosticHarness.worker()
    })
    assert.deepEqual((await read()).records, [])
    await page.getByRole('button', { name: 'Reload Hibi' }).click()
    await page.getByRole('button', { name: 'Trigger render failure' }).waitFor()
  }
})
