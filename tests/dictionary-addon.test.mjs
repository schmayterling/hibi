import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu, pressShortcut, splitTab } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const fixture = (name) =>
  readFile(new URL(`./fixtures/dictionary/${name}`, import.meta.url), 'utf8')

test('dictionary looks up the caret word and replaces it with one undo step in both editors', {
  timeout: 60000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-dictionary-'))
  const file = join(profile, 'note.md')
  await writeFile(file, 'I am Happy today')
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ dictionary: true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(8000)
  await waitForDocumentEditor(app, page)
  const responses = {
    'https://en.wiktionary.org/api/rest_v1/page/definition/happy':
      await fixture('wiktionary-happy.json'),
    'https://api.datamuse.com/words?rel_syn=happy&max=24': await fixture(
      'datamuse-synonyms-happy.json',
    ),
    'https://api.datamuse.com/words?rel_ant=happy&max=24': await fixture(
      'datamuse-antonyms-happy.json',
    ),
  }
  // Replace the network bridge so tests never reach the live services.
  await app.evaluate(({ ipcMain }, responses) => {
    globalThis.dictionaryRequests = []
    globalThis.dictionaryHolds = {}
    ipcMain.removeHandler('host-network:get-text')
    ipcMain.handle('host-network:get-text', async (_event, owner, request) => {
      globalThis.dictionaryRequests.push(`${owner} ${request.url}`)
      await globalThis.dictionaryHolds[request.url]
      const text = responses[request.url]
      return text === undefined
        ? { ok: false, code: 'http-status', status: 404 }
        : { ok: true, value: { url: request.url, status: 200, text } }
    })
  }, responses)
  const requests = () => app.evaluate(() => globalThis.dictionaryRequests)
  const markdown = async () =>
    (await page.evaluate(() => window.hibi.getDocument())).markdown
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await clickMenu(app, 'Open…')
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).name === 'note.md',
  )
  await waitForDocumentEditor(app, page)
  const rich = page.locator('.rich-pane .tiptap[contenteditable="true"]')
  await rich.click()
  await rich.evaluate((element) => element.editor.commands.setTextSelection(8))
  assert.deepEqual(await requests(), [])

  await clickMenu(app, 'Command palette')
  await page
    .getByRole('combobox', { name: /search commands/i })
    .fill('Define word')
  await page.getByRole('option', { name: /Define word/ }).click()
  const define = page.getByRole('dialog', { name: 'Define “Happy”' })
  await define.getByText('Music makes me feel happy.').waitFor()
  const english = define.getByRole('region', { name: 'English', exact: true })
  await english.getByRole('heading', { name: 'adjective' }).waitFor()
  await english.getByRole('heading', { name: 'noun' }).waitFor()
  await english.getByRole('heading', { name: 'verb' }).waitFor()
  await define
    .getByRole('region', { name: 'German', exact: true })
    .getByRole('heading', { name: 'adjective' })
    .waitFor()
  await define.getByText('Wiktionary · CC BY-SA 4.0').first().waitFor()
  assert.deepEqual(await requests(), [
    'dictionary https://en.wiktionary.org/api/rest_v1/page/definition/happy',
  ])
  await page.keyboard.press('Escape')
  await define.waitFor({ state: 'detached' })
  await waitForAsync(page, () =>
    document.activeElement?.classList.contains('tiptap'),
  )
  assert.equal(await markdown(), 'I am Happy today')

  await rich.press('Shift+F10')
  await page
    .getByRole('menu', { name: 'Editor actions' })
    .getByRole('menuitem', { name: /^Find synonyms/ })
    .click()
  const synonyms = page.getByRole('dialog', { name: 'Synonyms for “Happy”' })
  await synonyms
    .getByRole('region', { name: 'Antonyms' })
    .getByRole('button', { name: 'sad', exact: true })
    .waitFor()
  await synonyms.getByRole('button', { name: 'glad', exact: true }).click()
  await synonyms.waitFor({ state: 'detached' })
  await waitForAsync(
    page,
    async () =>
      (await window.hibi.getDocument()).markdown === 'I am Glad today',
  )
  assert.equal(
    await page.evaluate(() =>
      document.activeElement?.classList.contains('tiptap'),
    ),
    true,
  )
  await page.evaluate(() =>
    document.querySelector('.tiptap').editor.commands.undo(),
  )
  await waitForAsync(
    page,
    async () =>
      (await window.hibi.getDocument()).markdown === 'I am Happy today',
  )

  // Editing while the dialog is open cancels the choice with a notice.
  await rich.evaluate((element) => element.editor.commands.focus(8))
  await pressShortcut(app, 'Shift+F7')
  await synonyms.getByRole('button', { name: 'glad', exact: true }).waitFor()
  await rich.evaluate((element) =>
    element.editor.commands.insertContentAt(1, 'Oh, '),
  )
  await synonyms.getByRole('button', { name: 'glad', exact: true }).click()
  await page
    .locator('.toast')
    .filter({ hasText: 'The document changed. Look up the word again.' })
    .waitFor()
  assert.equal(await markdown(), 'Oh, I am Happy today')
  assert.deepEqual(pageErrors, [])
  await rich.evaluate((element) => element.editor.commands.undo())
  await waitForAsync(
    page,
    async () =>
      (await window.hibi.getDocument()).markdown === 'I am Happy today',
  )

  // Dismissal stops the lookup before the exit animation ends.
  const todaySynonyms = 'https://api.datamuse.com/words?rel_syn=today&max=24'
  await app.evaluate((_electron, url) => {
    globalThis.dictionaryHolds[url] = new Promise((resolve) => {
      globalThis.releaseHold = resolve
    })
  }, todaySynonyms)
  await rich.evaluate((element) => element.editor.commands.focus(13))
  await pressShortcut(app, 'Shift+F7')
  const today = page.getByRole('dialog', { name: 'Synonyms for “today”' })
  await today.waitFor()
  await waitForAsync(
    app,
    (_electron, url) =>
      globalThis.dictionaryRequests.at(-1) === `dictionary ${url}`,
    todaySynonyms,
  )
  await page.keyboard.press('Escape')
  await app.evaluate(() => globalThis.releaseHold())
  await today.waitFor({ state: 'detached' })
  // A later lookup's request proves the closed one sent nothing after it.
  await rich.evaluate((element) => element.editor.commands.focus(13))
  await clickMenu(app, 'Command palette')
  await page
    .getByRole('combobox', { name: /search commands/i })
    .fill('Define word')
  await page.getByRole('option', { name: /Define word/ }).click()
  const defineToday = page.getByRole('dialog', { name: 'Define “today”' })
  await defineToday.getByText('No definitions found').waitFor()
  assert.deepEqual((await requests()).slice(-2), [
    `dictionary ${todaySynonyms}`,
    'dictionary https://en.wiktionary.org/api/rest_v1/page/definition/today',
  ])
  await page.keyboard.press('Escape')
  await defineToday.waitFor({ state: 'detached' })

  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  const source = page.getByRole('textbox', {
    name: 'Markdown editor',
    exact: true,
  })
  await source.focus()
  await source.press(
    process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home',
  )
  for (let step = 0; step < 7; step++) await source.press('ArrowRight')
  await pressShortcut(app, 'Shift+F7')
  const sourceSynonyms = page.getByRole('dialog', {
    name: 'Synonyms for “Happy”',
  })
  await sourceSynonyms
    .getByRole('button', { name: 'content', exact: true })
    .click()
  await waitForAsync(
    page,
    async () =>
      (await window.hibi.getDocument()).markdown === 'I am Content today',
  )
  assert.equal((await requests()).length, 5, 'cached words are not re-sent')
  await source.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await waitForAsync(
    page,
    async () =>
      (await window.hibi.getDocument()).markdown === 'I am Happy today',
  )
})

test('dictionary replaces the word in the split pane it was invoked from', {
  timeout: 90000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-dictionary-split-'))
  const left = join(profile, 'left.md')
  const right = join(profile, 'right.md')
  await writeFile(left, 'Happy')
  await writeFile(right, 'Sad')
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ dictionary: true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(8000)
  await waitForDocumentEditor(app, page)
  const responses = {
    'https://api.datamuse.com/words?rel_syn=happy&max=24': await fixture(
      'datamuse-synonyms-happy.json',
    ),
    'https://api.datamuse.com/words?rel_syn=sad&max=24': '[{"word":"unhappy"}]',
  }
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await app.evaluate(({ ipcMain }, responses) => {
    ipcMain.removeHandler('host-network:get-text')
    ipcMain.handle('host-network:get-text', (_event, _owner, request) => {
      const text = responses[request.url]
      return text === undefined
        ? { ok: false, code: 'http-status', status: 404 }
        : { ok: true, value: { url: request.url, status: 200, text } }
    })
  }, responses)
  const open = async (file, name) => {
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
      name,
    )
    await waitForDocumentEditor(app, page)
  }
  await open(left, 'left.md')
  await open(right, 'right.md')
  const rightId = await page
    .getByRole('tab', { name: 'right.md' })
    .evaluate((tab) => tab.closest('[data-tab-key]').dataset.tabKey)
  await page.getByRole('tab', { name: 'left.md' }).click()
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).name === 'left.md',
  )
  await splitTab(app, page, rightId)
  const panes = {
    left: page.locator('.editor-page[data-side="left"]'),
    right: page.locator('.editor-page[data-side="right"]'),
  }
  const focusPane = async (side, editor) => {
    await editor.click()
    // The pane is marked active before its tab switch finishes; the app stays
    // busy (editors read-only) until it refocuses the pane's editor.
    await page.waitForFunction((side) => {
      const pane = document.querySelector(`.editor-page[data-side="${side}"]`)
      const input = document.activeElement
      return (
        pane?.getAttribute('data-active') === 'true' &&
        document.querySelector('.app')?.getAttribute('aria-busy') === 'false' &&
        pane.contains(input) &&
        input.isContentEditable
      )
    }, side)
  }
  const markdown = async (side, editor) => {
    await focusPane(side, editor(side))
    return (await page.evaluate(() => window.hibi.getDocument())).markdown
  }
  const pick = async () => {
    const synonyms = page.getByRole('dialog', { name: 'Synonyms for “Happy”' })
    await synonyms.getByRole('button', { name: 'glad', exact: true }).click()
    await synonyms.waitFor({ state: 'detached' })
  }

  // Both carets sit at the same offset, so only view identity tells them apart.
  const rich = (side) => panes[side].locator('.rich-pane .tiptap')
  for (const side of ['right', 'left']) {
    await focusPane(side, rich(side))
    await rich(side).evaluate((element) =>
      element.editor.commands.setTextSelection(3),
    )
  }
  await rich('left').press('Shift+F10')
  await page
    .getByRole('menu', { name: 'Editor actions' })
    .getByRole('menuitem', { name: /^Find synonyms/ })
    .click()
  await pick()
  await waitForAsync(
    page,
    () =>
      document.querySelector('.editor-page[data-side="left"] .tiptap')
        ?.textContent === 'Glad',
  )
  assert.equal(await rich('right').textContent(), 'Sad')
  assert.equal(await markdown('right', rich), 'Sad')
  assert.equal(await markdown('left', rich), 'Glad')
  await rich('left').evaluate((element) => element.editor.commands.undo())
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).markdown === 'Happy',
  )

  // Activating the other pane during the lookup makes restoring focus switch
  // back, which briefly leaves the left editor read-only.
  await rich('left').press('Shift+F10')
  await page
    .getByRole('menu', { name: 'Editor actions' })
    .getByRole('menuitem', { name: /^Find synonyms/ })
    .click()
  await page
    .getByRole('dialog', { name: 'Synonyms for “Happy”' })
    .getByRole('button', { name: 'glad', exact: true })
    .waitFor()
  await panes.right.evaluate((pane) =>
    pane.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })),
  )
  await page.waitForFunction(
    () =>
      document
        .querySelector('.editor-page[data-side="right"]')
        ?.getAttribute('data-active') === 'true',
  )
  await pick()
  await waitForAsync(
    page,
    () =>
      document.querySelector('.editor-page[data-side="left"] .tiptap')
        ?.textContent === 'Glad',
  )
  assert.equal(await page.locator('.toast').count(), 0)
  assert.equal(await markdown('right', rich), 'Sad')
  assert.equal(await markdown('left', rich), 'Glad')
  await rich('left').evaluate((element) => element.editor.commands.undo())
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).markdown === 'Happy',
  )

  const source = (side) => panes[side].locator('.cm-content')
  for (const side of ['left', 'right']) {
    await focusPane(side, rich(side))
    await page.getByRole('button', { name: 'Source view', exact: true }).click()
    await page.waitForFunction(
      (side) =>
        document.querySelector(`.editor-page[data-side="${side}"] .cm-content`)
          ?.isContentEditable,
      side,
    )
  }
  for (const side of ['right', 'left']) {
    await focusPane(side, source(side))
    await source(side).press(
      process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home',
    )
    for (let step = 0; step < 3; step++) await source(side).press('ArrowRight')
  }
  await pressShortcut(app, 'Shift+F7')
  await pick()
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).markdown === 'Glad',
  )
  assert.equal(await source('right').textContent(), 'Sad')
  assert.equal(await markdown('right', source), 'Sad')

  // Closing the pane while its lookup is open reports the lost word.
  await focusPane('right', source('right'))
  await pressShortcut(app, 'Shift+F7')
  const sad = page.getByRole('dialog', { name: 'Synonyms for “Sad”' })
  await sad.getByRole('button', { name: 'unhappy', exact: true }).waitFor()
  await page.evaluate(() =>
    document.querySelector('[aria-label="Close split"]').click(),
  )
  await panes.right.waitFor({ state: 'detached' })
  await sad.getByRole('button', { name: 'unhappy', exact: true }).click()
  await page
    .locator('.toast')
    .filter({ hasText: 'The document changed. Look up the word again.' })
    .waitFor()
  await page.locator('.editor-page .cm-content').waitFor()
  assert.deepEqual(pageErrors, [])
})
