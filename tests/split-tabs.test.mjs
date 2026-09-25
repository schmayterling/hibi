import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('split panes keep both editors mounted, edit both files, and share one document session', {
  timeout: 90000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-split-tabs-'))
  const a = join(root, 'a.md')
  const b = join(root, 'b.md')
  await writeFile(a, 'original a')
  await writeFile(b, 'original b')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      globalThis.releaseSplitAppend?.()
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7500)
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await page.locator('[data-status-id="autosave"]').click()
  await page.getByRole('checkbox', { name: /^autosave$/i }).check()
  await page.getByLabel(/^save after$/i).selectOption('1000')
  await page.getByRole('button', { name: /^back to app$/i }).click()
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
  const bDocument = await page.evaluate(() => window.hibi.getDocument())
  const bId = bDocument.tabId
  await page.getByRole('tab', { name: 'a.md' }).click()
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId === id,
    aId,
  )
  await page.waitForFunction(
    (id) =>
      document.querySelector('.app')?.getAttribute('aria-busy') === 'false' &&
      document
        .getElementById(`document-tab-${id}`)
        ?.getAttribute('aria-selected') === 'true',
    aId,
  )
  await page.locator(`[data-tab-key="${bId}"] .tab-split`).click()
  const left = page.locator('.editor-page[data-side="left"] .tiptap')
  const right = page.locator('.editor-page[data-side="right"] .tiptap')
  await left.waitFor()
  await right.waitFor()
  assert.equal(await page.locator('.editor-page[data-side]').count(), 2)
  await page.waitForTimeout(500)
  const splitState = await page.evaluate(async () => ({
    native: (await window.hibi.getDocument()).tabId,
    panes: Array.from(document.querySelectorAll('.editor-page[data-side]')).map(
      (pane) => ({
        side: pane.getAttribute('data-side'),
        active: pane.getAttribute('data-active'),
        title: pane.querySelector('.split-tab-heading')?.textContent,
      }),
    ),
  }))
  assert.equal(splitState.native, bId, JSON.stringify(splitState))
  await page.waitForFunction(
    () =>
      document
        .querySelector('.editor-page[data-side="right"]')
        ?.getAttribute('data-active') === 'true',
  )
  await page.setViewportSize({ width: 600, height: 700 })
  assert.equal(
    await left.isVisible(),
    false,
    JSON.stringify(
      await page.evaluate(() => ({
        width: innerWidth,
        split: document
          .querySelector('.split-tab-pages')
          ?.getAttribute('data-split'),
        panes: Array.from(
          document.querySelectorAll('.editor-page[data-side]'),
        ).map((pane) => ({
          side: pane.getAttribute('data-side'),
          active: pane.getAttribute('data-active'),
          display: getComputedStyle(pane).display,
        })),
      })),
    ),
  )
  assert.equal(await right.isVisible(), true)
  await page.setViewportSize({ width: 1200, height: 700 })
  assert.equal(await left.isVisible(), true)
  await app.evaluate(({ ipcMain }) => {
    const attach = ipcMain._invokeHandlers.get('media:attach')
    if (!attach) throw new Error('Media attachment handler is unavailable.')
    globalThis.splitAttachCalls = 0
    ipcMain.removeHandler('media:attach')
    ipcMain.handle('media:attach', (...args) => {
      globalThis.splitAttachCalls++
      return attach(...args)
    })
  })
  await left.evaluate((element) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['image'], 'photo.png', { type: 'image/png' }))
    element.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }),
    )
  })
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  )
  assert.equal(await app.evaluate(() => globalThis.splitAttachCalls), 0)
  await page.evaluate(() => {
    window.splitNodes = {
      left: document.querySelector('.editor-page[data-side="left"] .tiptap'),
      right: document.querySelector('.editor-page[data-side="right"] .tiptap'),
    }
  })
  await left.click()
  await right.click()
  await left.click()
  await right.click()
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId === id,
    bId,
  )
  await page.waitForFunction(
    () =>
      document
        .querySelector('.editor-page[data-side="right"]')
        ?.getAttribute('data-active') === 'true',
  )

  await left.click()
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId === id,
    aId,
  )
  await app.evaluate(({ ipcMain }) => {
    const append = ipcMain._invokeHandlers.get('document:append')
    if (!append) throw new Error('Document journal handler is unavailable.')
    let started
    globalThis.splitAppendStarted = new Promise((resolve) => {
      started = resolve
    })
    globalThis.pauseSplitAppend = true
    ipcMain.removeHandler('document:append')
    ipcMain.handle('document:append', async (...args) => {
      if (!globalThis.pauseSplitAppend) return append(...args)
      globalThis.pauseSplitAppend = false
      started()
      await new Promise((resolve) => {
        globalThis.releaseSplitAppend = resolve
      })
      return append(...args)
    })
  })
  await left.fill('edited a')
  await app.evaluate(() => globalThis.splitAppendStarted)
  await right.click()
  await page.waitForFunction(
    () => document.querySelector('.app')?.getAttribute('aria-busy') === 'true',
  )
  assert.match(await left.innerText(), /edited a/)
  await app.evaluate(() => globalThis.releaseSplitAppend())
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId === id,
    bId,
  )
  await left.click()
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId === id,
    aId,
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'edited a',
  )
  await assert.rejects(
    page.evaluate(
      (target) => window.hibi.focusDocumentTab(target.id, target.expected),
      {
        id: bId,
        expected: {
          contentVersion: bDocument.contentVersion + 1,
          revision: bDocument.revision,
        },
      },
    ),
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).tabId,
    aId,
  )
  const aRevision = (await page.evaluate(() => window.hibi.getDocument()))
    .revision
  await right.fill('edited b')
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId === id,
    bId,
  )
  const autosaveDeadline = performance.now() + 7000
  while (
    (await readFile(a, 'utf8')) !== 'edited a' &&
    performance.now() < autosaveDeadline
  )
    await delay(30)
  assert.equal(await readFile(a, 'utf8'), 'edited a')
  const bRevision = (await page.evaluate(() => window.hibi.getDocument()))
    .revision
  await left.click()
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId === id,
    aId,
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).revision,
    aRevision,
  )
  await right.click()
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId === id,
    bId,
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).revision,
    bRevision,
  )
  assert.equal(
    await page.evaluate(
      () =>
        window.splitNodes.left ===
          document.querySelector('.editor-page[data-side="left"] .tiptap') &&
        window.splitNodes.right ===
          document.querySelector('.editor-page[data-side="right"] .tiptap'),
    ),
    true,
  )
  assert.match(await left.innerText(), /edited a/)
  assert.match(await right.innerText(), /edited b/)

  await left.click()
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await page.locator('.editor-page[data-side="left"] .cm-content').waitFor()
  assert.equal(await right.isVisible(), true)
  await right.click()
  assert.equal(
    await page
      .locator('.editor-page[data-side="left"] .cm-content')
      .isVisible(),
    true,
  )
  await page.evaluate(() => window.hibi.saveDocument(false))
  assert.equal(await readFile(b, 'utf8'), 'edited b')
  await page.locator('.editor-page[data-side="left"] .cm-content').click()
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId === id,
    aId,
  )
  await page.evaluate(() => window.hibi.saveDocument(false))
  assert.equal(await readFile(a, 'utf8'), 'edited a')

  await page.getByRole('button', { name: 'Close split' }).click()
  await page.waitForFunction(
    () => !document.querySelector('.editor-page[data-side]'),
  )
  await page.locator('[data-status-id="autosave"]').click()
  await page.getByLabel(/^save after$/i).selectOption('30000')
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await page.locator(`[data-tab-key="${aId}"] .tab-split`).click()
  const leftSource = page.locator('.editor-page[data-side="left"] .cm-content')
  const rightSource = page.locator(
    '.editor-page[data-side="right"] .cm-content',
  )
  await leftSource.waitFor()
  await rightSource.waitFor()
  await rightSource.click()
  await rightSource.press('End')
  await page.keyboard.type('!')
  await page.waitForFunction(() =>
    document
      .querySelector('.editor-page[data-side="left"] .cm-content')
      ?.textContent?.includes('edited a!'),
  )
  const long = `edited a!\n${Array.from({ length: 100 }, (_, index) => `line ${index}`).join('\n')}`
  await rightSource.fill(long)
  await page.waitForFunction(() =>
    document
      .querySelector('.editor-page[data-side="left"] .cm-content')
      ?.textContent?.includes('line 99'),
  )
  const leftScroll = page.locator('.editor-page[data-side="left"] .cm-scroller')
  const rightScroll = page.locator(
    '.editor-page[data-side="right"] .cm-scroller',
  )
  const leftBefore = await leftScroll.evaluate((element) => element.scrollTop)
  await rightScroll.evaluate((element) => {
    element.scrollTop = 400
  })
  assert.ok((await rightScroll.evaluate((element) => element.scrollTop)) > 0)
  assert.equal(
    await leftScroll.evaluate((element) => element.scrollTop),
    leftBefore,
  )
  await leftSource.click()
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId === id,
    aId,
  )
  assert.ok((await rightScroll.evaluate((element) => element.scrollTop)) > 0)
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 2 })
  })
  await page.locator(`[data-tab-key="${aId}"] .tab-close`).click()
  await page.waitForFunction(
    () => document.querySelector('.app')?.getAttribute('aria-busy') === 'false',
  )
  assert.equal(await page.locator('.editor-page[data-side]').count(), 2)
  await page.getByRole('button', { name: 'Close split' }).click()
  await page.waitForFunction(
    () => !document.querySelector('.editor-page[data-side]'),
  )
  assert.match(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    /line 99/,
  )
})
