import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('split tabs switch the live editor without losing either draft', {
  timeout: 60000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-split-tabs-'))
  const a = join(root, 'a.md'),
    b = join(root, 'b.md')
  await writeFile(a, 'original a')
  await writeFile(b, 'original b')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(6000)
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  const open = async (file) => {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      })
    }, file)
    await clickMenu(app, 'Open…')
    await waitForAsync(
      page,
      async (name) => (await window.hibi.getDocument()).name === name,
      basename(file),
    )
  }
  await open(a)
  const aId = (await page.evaluate(() => window.hibi.getDocument())).tabId
  await open(b)
  const bId = (await page.evaluate(() => window.hibi.getDocument())).tabId

  await page.locator(`[data-tab-key="${aId}"] .tab-split`).click()
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId === id,
    aId,
  )
  await page.getByRole('button', { name: 'Edit b.md' }).waitFor()
  assert.match(
    await page.locator('.split-tab-preview-content').innerText(),
    /original b/,
  )
  const [left, right] = await Promise.all([
    page.locator('.split-tab-preview').boundingBox(),
    page.locator('.editor-page').boundingBox(),
  ])
  assert.ok(left && right && left.x + left.width <= right.x + 2)
  const source = await page
    .locator('.split-tab-preview-content > span')
    .boundingBox()
  assert.ok(source && source.y - left.y < 100)
  await page.setViewportSize({ width: 600, height: 700 })
  assert.equal(await page.locator('.split-tab-preview').isVisible(), false)
  await page.setViewportSize({ width: 1200, height: 700 })
  assert.equal(await page.locator('.split-tab-preview').isVisible(), true)
  const editor = page.getByRole('textbox', { name: /document editor/i })
  await editor.fill('edited a')
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).markdown === 'edited a',
  )
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 2 })
  })
  await page.locator(`[data-tab-key="${aId}"] .tab-close`).click()
  await page.waitForFunction(
    () => document.querySelector('.app').getAttribute('aria-busy') === 'false',
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'edited a',
  )
  assert.equal(await page.locator('.split-tab-preview').count(), 1)

  await page.getByRole('button', { name: 'Edit b.md' }).click()
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId === id,
    bId,
  )
  await page.waitForFunction(() =>
    document.activeElement?.matches('.editor-page [contenteditable="true"]'),
  )
  await page.getByRole('button', { name: 'Edit a.md' }).waitFor()
  assert.match(
    await page.locator('.split-tab-preview-content').innerText(),
    /edited a/,
  )
  await editor.fill('edited b')
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).markdown === 'edited b',
  )
  await page.evaluate(() => window.hibi.saveDocument(false))
  assert.equal(await readFile(b, 'utf8'), 'edited b')

  await page.getByRole('button', { name: 'Edit a.md' }).click()
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId === id,
    aId,
  )
  await page.evaluate(() => window.hibi.saveDocument(false))
  assert.equal(await readFile(a, 'utf8'), 'edited a')
  await page.getByRole('button', { name: 'Close split' }).first().click()
  assert.equal(await page.locator('.split-tab-preview').count(), 0)
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).tabs.length,
    2,
  )
})
