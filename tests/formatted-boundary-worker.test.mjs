import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import test from 'node:test'
import { build } from 'vite'
import { electron, waitForDocumentEditor } from './electron.mjs'

test('a real worker formats a never-visited 50 mib far jump without main-thread scanning and declines unknown blocks', {
  timeout: 180000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-boundary-worker-'))
  let app, server
  t.after(async () => {
    await app?.close()
    if (server) await new Promise((done) => server.close(done))
    await rm(folder, { recursive: true, force: true })
  })
  const bundle = join(folder, 'bundle')
  await build({
    configFile: false,
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
    worker: { format: 'es' },
    build: {
      outDir: bundle,
      assetsInlineLimit: 0,
      lib: {
        entry: resolve('tests/fixtures/live-preview.ts'),
        name: 'LivePreviewHarness',
        formats: ['iife'],
        fileName: () => 'harness.js',
        cssFileName: 'harness',
      },
    },
  })
  await writeFile(
    join(bundle, 'index.html'),
    '<!doctype html><html lang="en"><head><link rel="stylesheet" href="harness.css"></head><body><script src="harness.js"></script></body></html>',
  )
  server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://fixture').pathname
      const file = join(bundle, path === '/' ? 'index.html' : path)
      const type = {
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.html': 'text/html',
      }[extname(file)]
      response.writeHead(200, {
        'Content-Type': type ?? 'application/octet-stream',
      })
      response.end(await readFile(file))
    } catch {
      response.writeHead(404)
      response.end()
    }
  })
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
  app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  const main = await app.firstWindow()
  await waitForDocumentEditor(app, main)
  const next = app.waitForEvent('window')
  await app.evaluate(({ BrowserWindow }, port) => {
    const window = new BrowserWindow({
      show: false,
      width: 1200,
      height: 800,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    })
    void window.loadURL(`http://127.0.0.1:${port}/`)
  }, server.address().port)
  const page = await next
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.waitForFunction(() => Boolean(window.livePreview))
  await page.evaluate(async () => {
    const unit = '# heading\n\nparagraph **bold** words\n\n- one\n- two\n\n'
    await window.livePreview.mount(
      unit.repeat(Math.ceil((50 * 1024 * 1024) / unit.length)),
      undefined,
      { worker: true },
    )
  })
  await page
    .waitForFunction(
      () =>
        window.livePreview.workerState.ready ||
        window.livePreview.workerState.errors.length,
      undefined,
      { timeout: 120000 },
    )
    .catch(async (error) => {
      t.diagnostic(
        JSON.stringify(
          await page.evaluate(() => ({
            ...window.livePreview.workerState,
            ...window.livePreview.probe,
          })),
        ),
      )
      throw error
    })
  assert.deepEqual(
    await page.evaluate(() => window.livePreview.workerState.errors),
    [],
  )
  const before = await page.evaluate(() => {
    const preview = window.livePreview,
      view = preview.view()
    preview.reset()
    const at = view.state.doc.lineAt(view.state.doc.length - 4096).from
    view.dispatch({ selection: { anchor: at }, scrollIntoView: true })
    return { at, length: view.state.doc.length }
  })
  await page.waitForFunction(
    (at) =>
      [...document.querySelectorAll('.hibi-lp-heading')].some(
        (element) =>
          Math.abs(window.livePreview.view().posAtDOM(element) - at) < 12000,
      ),
    before.at,
  )
  const after = await page.evaluate(() => ({
    ...window.livePreview.probe,
    ...window.livePreview.workerState,
  }))
  assert.ok(before.length >= 50 * 1024 * 1024)
  assert.equal(after.scannedUnits, 0, JSON.stringify(after))
  assert.ok(after.parsedUnits < 64 * 1024, JSON.stringify(after))
  assert.ok(after.maxRecords <= 128)
  assert.deepEqual(errors, [])
  t.diagnostic(
    JSON.stringify({
      length: before.length,
      mainThreadScannedUnits: after.scannedUnits,
      mainThreadParsedUnits: after.parsedUnits,
      pages: after.pages,
    }),
  )

  // A same-config remote edit gets a new exact index on the same replica.
  await page.evaluate(() =>
    window.livePreview.edit(
      window.livePreview.view().state.doc.length - 12,
      window.livePreview.view().state.doc.length - 12,
      '\n# changed\n',
    ),
  )
  await page.waitForFunction(
    () =>
      window.livePreview.workerState.ready ||
      window.livePreview.workerState.errors.length,
    undefined,
    { timeout: 30000 },
  )
  assert.deepEqual(
    await page.evaluate(() => window.livePreview.workerState.errors),
    [],
  )

  const unknown = await page.evaluate(async () => {
    window.removeUnknown = window.livePreview.unknownBlock()
    await window.livePreview.mount(
      '%%\n\n# heading\n\nparagraph\n\n'.repeat(4000),
      undefined,
      { worker: true },
    )
    const result = {
      requests: window.livePreview.workerState.requests,
      declined: window.livePreview.probe.adoptionDeclined ?? 0,
    }
    window.livePreview.reset()
    const view = window.livePreview.view()
    view.dispatch({
      selection: { anchor: view.state.doc.length - 10 },
      scrollIntoView: true,
    })
    return result
  })
  assert.equal(unknown.requests, 0)
  assert.ok(unknown.declined > 0)
  await page.waitForFunction(() => window.livePreview.probe.scannedUnits > 0)
  await page.evaluate(() => window.removeUnknown())
})
