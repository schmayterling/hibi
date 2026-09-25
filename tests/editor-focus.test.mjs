import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'

test('new sidebar click keeps focus while source waits for font', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-editor-focus-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1 })
      })
      .catch(() => {})
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await page.addInitScript(() => {
    const load = document.fonts.load.bind(document.fonts)
    document.fonts.load = (font, text) =>
      font.includes('Geist Mono')
        ? new Promise((resolve) => {
            window.releaseSourceFont = () => load(font, text).then(resolve)
          })
        : load(font, text)
  })
  await Promise.all([
    page.waitForEvent('domcontentloaded'),
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].reload(),
    ),
  ])
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  const toggle = page.getByRole('button', {
    name: /^toggle workspace sidebar$/i,
  })
  await toggle.focus()
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+Shift+]' : 'Control+Shift+]',
  )
  await page.waitForFunction(
    () =>
      typeof window.releaseSourceFont === 'function' &&
      !!document.querySelector('.source-pane .cm-content'),
  )
  const sidebar = page.locator('.workspace-sidebar')
  const wasOpen = await sidebar.getAttribute('data-open')
  assert.equal(
    await page.locator('.editor-panes').getAttribute('data-source-ready'),
    'false',
  )
  await toggle.click()
  assert.notEqual(await sidebar.getAttribute('data-open'), wasOpen)
  assert.equal(
    await toggle.evaluate((element) => element === document.activeElement),
    true,
  )
  await page.evaluate(() => window.releaseSourceFont())
  await page.waitForFunction(
    () =>
      document.querySelector('.editor-panes')?.dataset.sourceReady === 'true',
  )
  assert.equal(
    await toggle.evaluate((element) => element === document.activeElement),
    true,
  )
})
