import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { build } from 'vite'
import { electron, waitForDocumentEditor } from './electron.mjs'

test('codemirror: formulas rendering on or above the reading line keep it in place, and later scrolling stands', {
  timeout: 120000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-formula-reading-'))
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
        entry: resolve('tests/fixtures/formatted-math-reading.ts'),
        name: 'FormulaReading',
        formats: ['iife'],
        fileName: () => 'harness.js',
        cssFileName: 'harness',
      },
    },
  })
  const html = join(bundle, 'index.html')
  await writeFile(
    html,
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="harness.css"></head><body><script src="harness.js"></script></body></html>',
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  await waitForDocumentEditor(app, await app.firstWindow())
  const next = app.waitForEvent('window')
  await app.evaluate(({ BrowserWindow }, path) => {
    const window = new BrowserWindow({
      width: 1000,
      height: 700,
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    })
    void window.loadFile(path)
  }, html)
  const page = await next
  page.setDefaultTimeout(10000)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await page.waitForFunction(() => Boolean(window.formulaReading))
  for (const focused of [false, true])
    for (const [type, where] of [
      ['display', 'above'],
      ['inline', 'above'],
      ['inline', 'line'],
      ['display', 'below'],
      ['inline', 'below'],
    ])
      await t.test(
        `${type} formulas ${where === 'line' ? 'on' : where} the reading line${focused ? ', focused' : ''}`,
        async () => {
          await page.evaluate(
            ({ type, focused }) => window.formulaReading.mount(type, focused),
            { type, focused },
          )
          const result = await page.evaluate(
            (where) => window.formulaReading.fill(where),
            where,
          )
          assert.ok(result.filled > 0, JSON.stringify(result))
          assert.ok(Math.abs(result.moved) < 1, JSON.stringify(result))
        },
      )
  for (const focused of [false, true])
    await t.test(
      `idle parsing keeps the reading line${focused ? ', focused' : ''}`,
      async () => {
        await page.evaluate(
          (focused) => window.formulaReading.mount('display', focused, 128),
          focused,
        )
        const moved = await page.evaluate(() => window.formulaReading.idle())
        assert.ok(
          moved < 1,
          `idle parsing moved the reading line by ${moved}px`,
        )
      },
    )
  for (const focused of [false, true])
    await t.test(
      `a very tall formula just before the reading line${focused ? ', focused' : ''}`,
      async () => {
        await page.evaluate(
          (focused) => window.formulaReading.mount('display', focused, 128),
          focused,
        )
        assert.ok((await page.evaluate(() => window.formulaReading.idle())) < 1)
        const result = await page.evaluate(() =>
          window.formulaReading.fill('previous', 0, 16),
        )
        assert.equal(result.filled, 1, JSON.stringify(result))
        assert.ok(Math.abs(result.moved) < 1, JSON.stringify(result))
      },
    )
  for (const type of ['display', 'inline'])
    await t.test(
      `typing while ${type} formulas render keeps the reading line`,
      async () => {
        await page.evaluate(
          (type) => window.formulaReading.mount(type, true),
          type,
        )
        const result = await page.evaluate(() =>
          window.formulaReading.fill('above', 0, 16, true),
        )
        assert.ok(result.filled > 0, JSON.stringify(result))
        assert.ok(Math.abs(result.moved) < 1, JSON.stringify(result))
      },
    )
  await t.test('a scroll command while formulas fill stands', async () => {
    await page.evaluate(() => window.formulaReading.mount('display'))
    const result = await page.evaluate(() =>
      window.formulaReading.fill('above', 0, 2, false, true),
    )
    assert.ok(result.filled > 0, JSON.stringify(result))
    assert.equal(result.landed, true, JSON.stringify(result))
  })
  await t.test('scrolling after the formulas fill stands', async () => {
    await page.evaluate(() => window.formulaReading.mount('display'))
    const result = await page.evaluate(() =>
      window.formulaReading.fill('above', 400),
    )
    assert.ok(result.filled > 0, JSON.stringify(result))
    assert.ok(Math.abs(result.scrolled) < 1, JSON.stringify(result))
  })
})
