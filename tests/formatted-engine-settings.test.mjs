import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu, replaceRichText } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('experimental editor setting preserves pending edits and switches both engines', {
  timeout: 60000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-engine-settings-'))
  const file = join(profile, 'note.md')
  await writeFile(file, 'on disk')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`, file],
  })
  t.after(async () => {
    await app
      .evaluate(({ dialog }) => {
        globalThis.releaseEngineJournal?.()
        dialog.showMessageBox = async () => ({ response: 1 })
      })
      .catch(() => {})
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  await waitForDocumentEditor(app, page)
  const rich = () =>
    page.getByRole('textbox', {
      name: 'Document editor',
      exact: true,
    })
  const toggle = page.getByRole('checkbox', {
    name: 'Enable exotic butter (experimental)',
    exact: true,
  })
  const settings = async () => {
    await clickMenu(app, 'Settings')
    await page.getByRole('tab', { name: 'Editor', exact: true }).click()
    await toggle.scrollIntoViewIfNeeded()
  }
  const back = async () => {
    await page.getByRole('button', { name: 'Back to app', exact: true }).click()
    await page.locator('.settings-screen').waitFor({ state: 'hidden' })
  }
  const source = async (expected) => {
    await waitForAsync(
      page,
      async (expected) =>
        (await window.hibi.getDocument()).markdown === expected,
      expected,
    )
    assert.equal(await rich().innerText(), expected)
    assert.equal(await readFile(file, 'utf8'), 'on disk')
  }
  await page.locator('.rich-pane .tiptap').waitFor()
  await source('on disk')
  await settings()
  assert.equal(await toggle.isChecked(), false)
  assert.equal(
    await page
      .locator('#settings-editor [data-setting-id]')
      .last()
      .getAttribute('data-setting-id'),
    'exotic-butter',
  )
  await page.evaluate(() => {
    const set = Storage.prototype.setItem
    window.restoreEngineStorage = () => {
      Storage.prototype.setItem = set
    }
    Storage.prototype.setItem = function (key, value) {
      if (key === 'hibi:formatted-engine')
        throw new Error('Engine preference could not be stored')
      return set.call(this, key, value)
    }
  })
  await toggle.click()
  await page.getByText('Could not switch editor', { exact: true }).waitFor()
  assert.equal(await toggle.isEnabled(), true)
  assert.equal(await toggle.isChecked(), false)
  assert.equal(
    await page.evaluate(() => localStorage.getItem('hibi:formatted-engine')),
    null,
  )
  assert.equal(await page.locator('.rich-pane .tiptap').count(), 1)
  await page.evaluate(() => window.restoreEngineStorage())
  await back()
  await app.evaluate(({ ipcMain }) => {
    const append = ipcMain._invokeHandlers.get('document:append')
    const held = new Promise((resolve) => {
      globalThis.releaseEngineJournal = resolve
    })
    ipcMain.removeHandler('document:append')
    ipcMain.handle('document:append', async (...args) => {
      globalThis.engineJournalReached = true
      await held
      return append(...args)
    })
  })
  await replaceRichText(page, rich(), 'pending from tiptap 😀')
  await settings()
  const reloaded = page.waitForEvent('load')
  await toggle.click()
  assert.equal(await toggle.isDisabled(), true)
  assert.equal(
    await page.evaluate(() => localStorage.getItem('hibi:formatted-engine')),
    null,
  )
  assert.equal(await app.evaluate(() => globalThis.engineJournalReached), true)
  await app.evaluate(() => globalThis.releaseEngineJournal())
  await reloaded
  await page.locator('.rich-pane .hibi-formatted .cm-content').waitFor()
  await source('pending from tiptap 😀')
  await settings()
  assert.equal(await toggle.isChecked(), true)
  const colors = await page
    .locator('[data-setting-id="exotic-butter"] label')
    .evaluate((label) => {
      const swatch = document.createElement('span')
      swatch.style.color = 'var(--status-warning)'
      label.append(swatch)
      const result = {
        actual: getComputedStyle(label).color,
        expected: getComputedStyle(swatch).color,
      }
      swatch.remove()
      return result
    })
  assert.equal(colors.actual, colors.expected)
  await mkdir('.scratch', { recursive: true })
  await page
    .locator('.experimental-editor-settings')
    .screenshot({ path: '.scratch/engine-setting-light.png' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page
    .locator('.experimental-editor-settings')
    .screenshot({ path: '.scratch/engine-setting-dark.png' })
  await back()
  await replaceRichText(page, rich(), 'pending from codemirror 😀')
  await settings()
  const returned = page.waitForEvent('load')
  await toggle.click()
  await returned
  await page.locator('.rich-pane .tiptap').waitFor()
  await source('pending from codemirror 😀')
  await settings()
  assert.equal(await toggle.isChecked(), false)
  await page.reload()
  await page.locator('.rich-pane .tiptap').waitFor({ state: 'attached' })
  await settings()
  assert.equal(await toggle.isChecked(), false)
  await back()
  await source('pending from codemirror 😀')
})
