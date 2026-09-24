import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { build } from 'vite'
import { electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

test('recovery preview preserves the live draft; real render failures offer recovery actions', {
  timeout: 45000,
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'hibi-recovery-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(temp, 'profile')}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(temp, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(6500)
  await page
    .getByRole('textbox', { name: /document editor/i })
    .fill('keep this draft')
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'About', exact: true }).click()
  await page.getByRole('button', { name: /preview recovery screen/i }).click()
  const preview = page.getByRole('dialog', { name: /recovery preview/i })
  await preview
    .getByRole('heading', { name: /the editor stopped working/i })
    .waitFor()
  assert.equal(
    await preview.getByRole('button', { name: /reload hibi/i }).count(),
    0,
  )
  await preview.getByRole('button', { name: /^error details$/i }).click()
  const previewDetails = page.getByRole('dialog', { name: /^error details$/i })
  await previewDetails.waitFor()
  await page.keyboard.press('Escape')
  await previewDetails.waitFor({ state: 'hidden' })
  assert.equal(await preview.isVisible(), true)
  await page.keyboard.press('Escape')
  await preview.waitFor({ state: 'hidden' })
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'keep this draft',
  )
  const bundle = join(temp, 'bundle')
  await build({
    configFile: false,
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
    esbuild: { jsx: 'automatic' },
    build: {
      outDir: bundle,
      lib: {
        entry: resolve('tests/fixtures/recovery.tsx'),
        name: 'RecoveryHarness',
        formats: ['iife'],
        fileName: () => 'harness.js',
        cssFileName: 'harness',
      },
    },
  })
  const html = join(bundle, 'index.html')
  await writeFile(
    html,
    '<!doctype html><html><head><link rel="stylesheet" href="harness.css"></head><body><script src="harness.js"></script></body></html>',
  )
  const next = app.waitForEvent('window')
  await app.evaluate(({ BrowserWindow }, html) => {
    const window = new BrowserWindow({
      width: 800,
      height: 640,
      show: false,
      focusable: false,
      webPreferences: {
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
      },
    })
    void window.loadFile(html)
  }, html)
  const crashed = await next
  crashed.setDefaultTimeout(6500)
  await crashed.getByRole('button', { name: /trigger render failure/i }).click()
  await crashed.getByRole('main', { name: /editor recovery/i }).waitFor()
  await crashed.getByText(/unsaved draft available/i).waitFor()
  await crashed.getByRole('button', { name: /save a copy/i }).click()
  await crashed
    .getByRole('status')
    .filter({ hasText: /copy saved\./i })
    .waitFor()
  assert.equal(
    await crashed.locator('body').getAttribute('data-copy-saved'),
    'true',
  )
  await crashed.getByText(/^error details$/i, { exact: true }).click()
  assert.match(
    await crashed.locator('.recovery-details pre').innerText(),
    /fixture render failure/,
  )
  await crashed.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (text) => {
          document.body.dataset.copiedError = text
        },
      },
    }),
  )
  await crashed.getByRole('button', { name: /copy details/i }).click()
  assert.match(
    await crashed.locator('body').getAttribute('data-copied-error'),
    /fixture render failure/,
  )
  await crashed.getByRole('button', { name: /close error details/i }).click()
  await crashed
    .getByRole('dialog', { name: /^error details$/i })
    .waitFor({ state: 'hidden' })
  assert.equal(
    await crashed
      .getByRole('button', { name: /^error details$/i })
      .evaluate((element) => element === document.activeElement),
    true,
  )
  await crashed.getByRole('button', { name: /reload hibi/i }).click()
  await crashed
    .getByRole('button', { name: /trigger render failure/i })
    .waitFor()
  await crashed.close()
})
