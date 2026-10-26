import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('history above its retention budget keeps a distinct version restorable through bounded preview', {
  timeout: 120000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-history-scale-'))
  const file = join(root, 'large.md')
  const unit = `${'ordinary words '.repeat(16)}\r\n\r\n`
  const text =
    '\uFEFF# history\r\n\r\n' +
    unit.repeat(Math.ceil((21 * 1048576) / unit.length))
  await writeFile(file, text)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`, file],
  })
  t.after(async () => {
    await app.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({
      response: 1,
      checkboxChecked: false,
    })
  })
  const page = await app.firstWindow()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  await page.evaluate(() => {
    const view = document.querySelector('.source-pane .cm-content').cmTile.root
      .view
    view.dispatch({
      changes: { from: 1, to: 2, insert: 'Z' },
      userEvent: 'input.type',
    })
    return window.hibi.flushDocumentChanges()
  })
  await clickMenu(app, 'Save')
  await page.waitForFunction(
    () => document.querySelector('.app')?.getAttribute('aria-busy') === 'false',
  )
  const versions = await page.evaluate(() => window.hibi.listVersions())
  assert.equal(versions.length, 2)
  assert.ok(versions.every((version) => version.bytes > 20 * 1048576))
  const before = await page.evaluate(
    async () => (await window.hibi.getDocument()).contentVersion,
  )
  const savedText = text.slice(0, 1) + 'Z' + text.slice(2)
  assert.equal(await readFile(file, 'utf8'), savedText)
  await page.evaluate(() => {
    const preview = window.hibi.previewVersion
    globalThis.historyScalePreviewCalls = 0
    window.hibi.previewVersion = (...args) => {
      globalThis.historyScalePreviewCalls++
      return preview(...args)
    }
  })
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+k' : 'Control+k',
  )
  await page
    .getByRole('combobox', { name: /search commands/i })
    .fill('version history')
  await page.getByRole('option').first().waitFor()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: /^version history$/i })
  await dialog
    .getByRole('navigation', { name: /saved versions/i })
    .getByRole('button')
    .last()
    .click()
  assert.equal(
    await page.evaluate(() => globalThis.historyScalePreviewCalls),
    0,
  )
  await dialog
    .getByRole('region', { name: 'Version preview' })
    .getByRole('status')
    .filter({ hasText: /too large to preview.*still restore/i })
    .waitFor()
  assert.equal(await dialog.getByRole('alert').count(), 0)
  assert.equal(
    await dialog.getByText('Loading preview…', { exact: true }).count(),
    0,
  )
  const restore = dialog.getByRole('button', { name: /restore to editor/i })
  assert.equal(await restore.isEnabled(), true)
  await restore.click()
  await dialog.waitFor({ state: 'hidden' })
  await waitForAsync(
    page,
    async (version) =>
      (await window.hibi.getDocument()).contentVersion > version,
    before,
  )
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  const restored = await page.evaluate(async () => {
    const current = await window.hibi.getDocument()
    return { markdown: current.markdown, dirty: current.dirty }
  })
  assert.equal(restored.markdown, text)
  assert.equal(restored.dirty, true)
  assert.equal(await readFile(file, 'utf8'), savedText)
})
