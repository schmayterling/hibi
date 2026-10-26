import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { CustomWordDatabase } from '../src/addons/dictionary/custom-word-database.ts'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'
import { APP_STATE_TIMEOUT, waitForAsync } from './poll.mjs'

async function fixture(t) {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-custom-lifetime-'))
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ dictionary: true }),
  )
  let app
  t.after(async () => {
    if (app) {
      await app
        .evaluate(() => {
          globalThis.finishPicker?.({ canceled: true })
          globalThis.releaseImportStage?.()
          globalThis.releaseCommit?.()
        })
        .catch(() => {})
      await app.close()
    }
    await rm(profile, { recursive: true, force: true })
  })
  return {
    profile,
    async launch() {
      app = await electron.launch({
        args: [resolve('.'), `--user-data-dir=${profile}`],
      })
      await app.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1 })
      })
      const page = await app.firstWindow()
      page.setDefaultTimeout(APP_STATE_TIMEOUT)
      await waitForDocumentEditor(app, page)
      return { app, page }
    },
    async close() {
      await app.close()
      app = undefined
    },
  }
}
const metadata = (page) =>
  page.evaluate(() =>
    window.hibi.invokeAddonProfile('dictionary', 'customWordsMetadata'),
  )
const stageWord = (page, word) =>
  page.evaluate(async (word) => {
    const call = (input) =>
      window.hibi.invokeAddonProfile('dictionary', 'changeCustomWords', input)
    const { revision } = await window.hibi.invokeAddonProfile(
      'dictionary',
      'customWordsMetadata',
    )
    const { token } = await call({ type: 'begin', revision })
    await call({
      type: 'stage',
      token,
      upsert: [{ id: word, word }],
      remove: [],
    })
    return token
  }, word)

test('profile stages and aborts survive a picker, including an import already in flight', async (t) => {
  const fixtureState = await fixture(t)
  const { app, page } = await fixtureState.launch()
  const token = await stageWord(page, 'aborted')
  await app.evaluate(({ dialog }) => {
    globalThis.pickerCount = 0
    dialog.showSaveDialog = () => {
      globalThis.pickerCount++
      return new Promise((resolve) => {
        globalThis.finishPicker = resolve
      })
    }
  })
  await page.evaluate(() => {
    globalThis.picking = window.hibi.selectHostExport('dictionary', {
      suggestedName: 'words.txt',
      extension: 'txt',
    })
  })
  await waitForAsync(app, () => globalThis.pickerCount === 1)
  await page.evaluate(async (token) => {
    const call = (input) =>
      window.hibi.invokeAddonProfile('dictionary', 'changeCustomWords', input)
    await call({
      type: 'stage',
      token,
      upsert: [{ id: 'also-aborted', word: 'also-aborted' }],
      remove: [],
    })
    await call({ type: 'abort', token })
  }, token)
  assert.equal((await metadata(page)).count, 0)
  await app.evaluate(() => globalThis.finishPicker({ canceled: true }))
  await page.evaluate(() => globalThis.picking)

  await clickMenu(app, 'Settings')
  await page
    .getByRole('tab', { name: 'Dictionary and thesaurus', exact: true })
    .click()
  const words = page.getByRole('region', { name: 'Custom words' })
  await words.getByRole('textbox', { name: 'New custom word' }).fill('kept')
  await words.getByRole('button', { name: 'Add', exact: true }).click()
  await words.getByRole('button', { name: 'Remove “kept”' }).waitFor()
  await app.evaluate(({ ipcMain }) => {
    const invoke = ipcMain._invokeHandlers.get('addons:profile')
    let held = false
    ipcMain.removeHandler('addons:profile')
    ipcMain.handle('addons:profile', async (event, id, method, input) => {
      if (!held && method === 'changeCustomWords' && input?.type === 'stage') {
        held = true
        await new Promise((resolve) => {
          globalThis.releaseImportStage = resolve
        })
      }
      return invoke(event, id, method, input)
    })
  })
  await words
    .getByRole('textbox', { name: 'Custom words as text' })
    .scrollIntoViewIfNeeded()
  await words
    .getByRole('textbox', { name: 'Custom words as text' })
    .fill(
      Array.from({ length: 500 }, (_, index) => `imported${index}`).join('\n'),
    )
  await words.getByRole('button', { name: 'Import text', exact: true }).click()
  await waitForAsync(
    app,
    () => typeof globalThis.releaseImportStage === 'function',
  )
  await words.getByRole('button', { name: 'Export to file…' }).click()
  await waitForAsync(app, () => globalThis.pickerCount === 2)
  await app.evaluate(() => globalThis.releaseImportStage())
  await words.getByText('Imported 500 words.').waitFor()
  assert.equal(
    (await metadata(page)).count,
    501,
    'import commits while the picker remains open',
  )
  await app.evaluate(() => globalThis.finishPicker({ canceled: true }))
  await words
    .getByRole('button', { name: 'Export to file…' })
    .waitFor({ state: 'visible' })
  const next = await stageWord(page, 'after-picker')
  await page.evaluate(
    (token) =>
      window.hibi.invokeAddonProfile('dictionary', 'changeCustomWords', {
        type: 'commit',
        token,
      }),
    next,
  )
  assert.equal((await metadata(page)).count, 502)
})

test('renderer loss discards staging and window close drains a pending profile commit', async (t) => {
  const fixtureState = await fixture(t)
  let { app, page } = await fixtureState.launch()
  await stageWord(page, 'lost-renderer')
  await app.evaluate(async ({ BrowserWindow, dialog }) => {
    const window = BrowserWindow.getAllWindows()[0]
    // The crash recovery path must keep this test window hidden.
    window.isVisible = () => true
    dialog.showMessageBox = async () => ({ response: 0 })
    await new Promise((resolve) => {
      window.webContents.once('did-finish-load', resolve)
      window.webContents.forcefullyCrashRenderer()
    })
  })
  // Playwright keeps the crashed target; use the recovered window's real preload bridge.
  page = {
    evaluate: (fn, input) =>
      app.evaluate(
        ({ BrowserWindow }, { source, input }) =>
          BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
            `(${source})(${JSON.stringify(input)})`,
          ),
        { source: fn.toString(), input },
      ),
  }
  await waitForAsync(
    page,
    () =>
      !!document.querySelector(
        '.app[aria-busy="false"] #document-editor-panel[aria-busy="false"] [contenteditable="true"]',
      ),
  )
  const afterCrash = await stageWord(page, 'after-crash')
  await page.evaluate(
    (token) =>
      window.hibi.invokeAddonProfile('dictionary', 'changeCustomWords', {
        type: 'commit',
        token,
      }),
    afterCrash,
  )
  assert.equal(
    (await metadata(page)).count,
    1,
    'uncommitted renderer data never appears',
  )

  const pending = await stageWord(page, 'pending-close')
  await app.evaluate(({ BrowserWindow }) => {
    const threads = process.getBuiltinModule('node:worker_threads')
    const send = threads.Worker.prototype.postMessage
    threads.Worker.prototype.postMessage = function (message, ...rest) {
      if (
        message.method === 'change' &&
        message.input?.type === 'commit' &&
        !globalThis.commitHeld
      ) {
        globalThis.commitHeld = true
        globalThis.releaseCommit = () => send.call(this, message, ...rest)
        return
      }
      return send.call(this, message, ...rest)
    }
    const window = BrowserWindow.getAllWindows()[0]
    globalThis.windowClosed = false
    window.once('closed', () => {
      globalThis.windowClosed = true
    })
  })
  await page.evaluate((token) => {
    globalThis.committing = window.hibi
      .invokeAddonProfile('dictionary', 'changeCustomWords', {
        type: 'commit',
        token,
      })
      .catch(() => {})
  }, pending)
  await waitForAsync(app, () => globalThis.commitHeld === true)
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].close()
  })
  await app.evaluate(() => new Promise((resolve) => setImmediate(resolve)))
  assert.equal(
    await app.evaluate(() => globalThis.windowClosed),
    false,
    'pending commit keeps close from finishing',
  )
  await app.evaluate(() => globalThis.releaseCommit())
  await waitForAsync(app, () => globalThis.windowClosed)
  await fixtureState.close()
  ;({ app, page } = await fixtureState.launch())
  assert.equal((await metadata(page)).count, 2)
  const saved = await page.evaluate(() =>
    window.hibi.invokeAddonProfile('dictionary', 'customWordsGet', {
      id: 'pending-close',
    }),
  )
  assert.equal(saved.word.word, 'pending-close')
  const next = await stageWord(page, 'after-close')
  await page.evaluate(
    (token) =>
      window.hibi.invokeAddonProfile('dictionary', 'changeCustomWords', {
        type: 'commit',
        token,
      }),
    next,
  )
  assert.equal((await metadata(page)).count, 3)
})

test('large custom lists load only visible pages and keep row edits keyed', async (t) => {
  const fixtureState = await fixture(t)
  const store = await CustomWordDatabase.open(fixtureState.profile)
  try {
    const { token } = store.change({
      type: 'begin',
      revision: store.revision(),
    })
    for (let start = 0; start < 10050; start += 256)
      store.change({
        type: 'stage',
        token,
        remove: [],
        upsert: Array.from(
          { length: Math.min(256, 10050 - start) },
          (_, index) => ({
            id: `id-${start + index}`,
            word: `paged${String(start + index).padStart(5, '0')}`,
            note: 'old note',
          }),
        ),
      })
    store.change({ type: 'commit', token })
  } finally {
    store.close()
  }
  const { app, page } = await fixtureState.launch()
  await app.evaluate(({ ipcMain }) => {
    const invoke = ipcMain._invokeHandlers.get('addons:profile')
    globalThis.wordPageReads = 0
    ipcMain.removeHandler('addons:profile')
    ipcMain.handle('addons:profile', (event, id, method, input) => {
      if (method === 'customWords') globalThis.wordPageReads++
      return invoke(event, id, method, input)
    })
  })
  await clickMenu(app, 'Settings')
  assert.equal(
    await app.evaluate(() => globalThis.wordPageReads),
    0,
    'hidden settings never read word pages',
  )
  await page
    .getByRole('tab', { name: 'Dictionary and thesaurus', exact: true })
    .click()
  const words = page.getByRole('region', { name: 'Custom words' })
  await words.getByRole('button', { name: 'Remove “paged00000”' }).waitFor()
  const chooser = words.getByRole('spinbutton', { name: 'Word list page' })
  const navigation = words.getByRole('navigation', {
    name: 'Custom word pages',
  })
  await navigation.scrollIntoViewIfNeeded()
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme })
    const layout = await navigation.evaluate((nav) => ({
      centers: [...nav.children].map((item) => {
        const rect = item.getBoundingClientRect()
        return rect.y + rect.height / 2
      }),
      inputWidth: nav.querySelector('input').getBoundingClientRect().width,
      counterFont: getComputedStyle(nav.querySelector('.setting-description'))
        .fontSize,
      descriptionFont: getComputedStyle(
        document.querySelector('#dictionary-new-word-description'),
      ).fontSize,
    }))
    assert.ok(Math.max(...layout.centers) - Math.min(...layout.centers) < 1)
    assert.ok(layout.inputWidth < 100)
    assert.equal(layout.counterFont, layout.descriptionFont)
    await page.screenshot({
      path: `test-results/dictionary-pages-${colorScheme}.png`,
    })
  }
  await chooser.fill('2')
  const note = words.getByRole('textbox', { name: 'Note for “paged10000”' })
  await note.waitFor()
  const row = words.getByRole('listitem').filter({
    has: page.getByRole('textbox', { name: 'Note for “paged10000”' }),
  })
  assert.equal(await row.getAttribute('aria-posinset'), '10001')
  assert.equal(await row.getAttribute('aria-setsize'), '10050')
  assert.ok((await words.getByRole('listitem').count()) < 80)
  const reads = await app.evaluate(() => globalThis.wordPageReads)
  await note.fill('tail note')
  await note.blur()
  await waitForAsync(
    page,
    async () =>
      (
        await window.hibi.invokeAddonProfile('dictionary', 'customWordsGet', {
          id: 'id-10000',
        })
      ).word.note === 'tail note',
  )
  assert.equal(
    await app.evaluate(() => globalThis.wordPageReads),
    reads,
    'one row edit never reloads pages',
  )
  await chooser.fill('1')
  await words.getByRole('button', { name: 'Remove “paged00000”' }).waitFor()
  await chooser.fill('2')
  await words.getByRole('textbox', { name: 'Note for “paged10000”' }).waitFor()
  assert.equal(
    await words
      .getByRole('textbox', { name: 'Note for “paged10000”' })
      .inputValue(),
    'tail note',
  )
})
