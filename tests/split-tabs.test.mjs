import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
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
  const bPath = await realpath(b)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      globalThis.releaseSplitAppend?.()
      globalThis.releaseSplitAutosave?.()
      globalThis.restoreSplitAutosaveRename?.()
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
  await app.evaluate(
    ({ ipcMain }, ids) => {
      const focus = ipcMain._invokeHandlers.get('document:focus-tab')
      const get = ipcMain._invokeHandlers.get('document:get')
      if (!focus) throw new Error('Document focus handler is unavailable.')
      if (!get) throw new Error('Document get handler is unavailable.')
      let phase = 0
      ipcMain.removeHandler('document:focus-tab')
      ipcMain.handle('document:focus-tab', async (...args) => {
        if (phase === 1 && args[1] === ids.left) {
          phase = 2
          throw new Error('Simulated focus rollback failure.')
        }
        const metadata = await focus(...args)
        if (phase === 0 && args[1] === ids.right) {
          phase = 1
          return { ...metadata, contentVersion: metadata.contentVersion + 1 }
        }
        if (phase === 2 && args[1] === ids.left) {
          phase = 3
          return { ...metadata, contentVersion: metadata.contentVersion + 1 }
        }
        return metadata
      })
      ipcMain.removeHandler('document:get')
      ipcMain.handle('document:get', async (...args) => {
        const document = await get(...args)
        if (phase === 3) {
          phase = 4
          return { ...document, markdown: `${document.markdown}mismatch` }
        }
        return document
      })
    },
    { left: aId, right: bId },
  )
  await page.locator(`[data-tab-key="${bId}"] .tab-split`).click()
  await page.getByRole('button', { name: 'Retry document focus' }).waitFor()
  assert.equal(await page.locator('.app').getAttribute('aria-busy'), 'true')
  assert.equal(await page.locator('.editor-page[data-side]').count(), 0)
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).tabId,
    bId,
  )
  await page.getByRole('button', { name: 'Retry document focus' }).click()
  await page
    .getByText('This tab has local edits waiting to synchronize. Try again.')
    .waitFor()
  assert.equal(await page.locator('.app').getAttribute('aria-busy'), 'true')
  await page.getByRole('button', { name: 'Retry document focus' }).waitFor()
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).tabId,
    aId,
  )
  await page.getByRole('button', { name: 'Retry document focus' }).click()
  await page.waitForFunction(
    () => document.querySelector('.app')?.getAttribute('aria-busy') === 'false',
  )
  await page.getByRole('button', { name: 'Retry document focus' }).waitFor({
    state: 'hidden',
  })
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).tabId,
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
  await page.waitForFunction(
    () => document.querySelector('.app')?.getAttribute('aria-busy') === 'false',
  )
  await page.evaluate(() => {
    window.splitKeyBusy = null
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Z')
          window.splitKeyBusy = document
            .querySelector('.app')
            ?.getAttribute('aria-busy')
      },
      true,
    )
  })
  await right.click()
  await page.keyboard.type('Z')
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId === id,
    bId,
  )
  await page.waitForFunction(
    () => document.querySelector('.app')?.getAttribute('aria-busy') === 'false',
  )
  const typed = (await right.innerText()).split('Z').length - 1
  assert.ok(
    typed === 1 ||
      (typed === 0 &&
        (await page.evaluate(() => window.splitKeyBusy)) === 'true'),
    'An immediate keypress must be inserted once or visibly blocked during focus.',
  )
  assert.doesNotMatch(await left.innerText(), /Z/)
  await app.evaluate(
    ({ ipcMain }, { path, tabId }) => {
      const autosave = ipcMain._invokeHandlers.get('document:autosave')
      if (!autosave) throw new Error('Autosave handler is unavailable.')
      globalThis.splitAutosaveCalls = 0
      globalThis.splitAutosaveStatuses = []
      globalThis.splitAutosaveRenames = []
      globalThis.splitAutosaveRenamed = false
      ipcMain.removeHandler('document:autosave')
      ipcMain.handle('document:autosave', (...args) => {
        if (args[1] !== tabId) return autosave(...args)
        globalThis.splitAutosaveCalls++
        return Promise.resolve(autosave(...args)).then((result) => {
          globalThis.splitAutosaveStatuses.push(result.status)
          return result
        })
      })
      const { syncBuiltinESMExports } = process.getBuiltinModule('node:module')
      const promises = process.getBuiltinModule('node:fs/promises')
      const rename = promises.rename
      globalThis.restoreSplitAutosaveRename = () => {
        promises.rename = rename
        syncBuiltinESMExports()
      }
      promises.rename = async (from, to) => {
        if (globalThis.splitAutosaveRenames.length < 12)
          globalThis.splitAutosaveRenames.push(to)
        await rename(from, to)
        if (to !== path) return
        globalThis.restoreSplitAutosaveRename()
        globalThis.splitAutosaveRenamed = true
        await new Promise((resolve) => {
          globalThis.releaseSplitAutosave = resolve
        })
      }
      syncBuiltinESMExports()
    },
    { path: bPath, tabId: bId },
  )
  await right.fill('edited b')
  const autosaveDeadline = performance.now() + 7000
  let autosaveState
  do {
    autosaveState = await app.evaluate(() => ({
      renamed: globalThis.splitAutosaveRenamed,
      calls: globalThis.splitAutosaveCalls,
      statuses: globalThis.splitAutosaveStatuses,
      renames: globalThis.splitAutosaveRenames,
    }))
    if (autosaveState.renamed) break
    await delay(30)
  } while (performance.now() < autosaveDeadline)
  assert.ok(
    autosaveState.renamed,
    JSON.stringify({ expected: bPath, autosaveState }),
  )
  assert.ok((await app.evaluate(() => globalThis.splitAutosaveCalls)) > 0)
  assert.equal(await readFile(b, 'utf8'), 'edited b')
  await left.click()
  await page.waitForFunction(
    () => document.querySelector('.app')?.getAttribute('aria-busy') === 'true',
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).tabId,
    bId,
  )
  await app.evaluate(() => globalThis.releaseSplitAutosave())
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId === id,
    aId,
  )
  await right.click()
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId === id,
    bId,
  )
  const aAutosaveDeadline = performance.now() + 7000
  while (
    (await readFile(a, 'utf8')) !== 'edited a' &&
    performance.now() < aAutosaveDeadline
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
  await page.locator(`[data-tab-key="${bId}"] .tab-split`).click()
  await rightSource.waitFor()
  await leftSource.click()
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId === id,
    aId,
  )
  await page.waitForFunction(
    () => document.querySelector('.app')?.getAttribute('aria-busy') === 'false',
  )
  await app.evaluate(
    ({ ipcMain }, ids) => {
      const focus = ipcMain._invokeHandlers.get('document:focus-tab')
      if (!focus) throw new Error('Document focus handler is unavailable.')
      let phase = 0
      ipcMain.removeHandler('document:focus-tab')
      ipcMain.handle('document:focus-tab', async (...args) => {
        const id = args[1]
        if (phase === 0 && id === ids.right) {
          phase = 1
          const metadata = await focus(...args)
          return { ...metadata, contentVersion: metadata.contentVersion + 1 }
        }
        if (phase === 1 && id === ids.left) {
          phase = 2
          throw new Error('Simulated focus rollback failure.')
        }
        return focus(...args)
      })
    },
    { left: aId, right: bId },
  )
  await rightSource.click()
  await page.waitForFunction(
    () => document.querySelector('.app')?.getAttribute('aria-busy') === 'true',
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
