import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'
import { APP_STATE_TIMEOUT, waitForAsync } from './poll.mjs'

test('legacy words migrate in the native worker and remain available to older builds', async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-dictionary-migration-'))
  await mkdir(join(profile, 'addon-storage', 'global'), { recursive: true })
  const file = join(profile, 'addon-storage', 'global', 'dictionary.json')
  const saved = Array.from({ length: 5000 }, (_, index) => ({
    id: `id-${index}`,
    word: `legacy${index}`,
  }))
  const original = JSON.stringify({
    format: 1,
    entries: { 'custom-words': { version: 1, revision: 7, value: saved } },
  })
  await writeFile(file, original)
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
  await waitForDocumentEditor(app, page)
  const words = await page.evaluate(async () => {
    const words = []
    let after = 0
    for (;;) {
      const page = await window.hibi.queryAddon('dictionary', 'customWords', {
        after,
      })
      words.push(...page.words)
      if (!page.more) return words
      after = page.after
    }
  })
  assert.deepEqual(words, saved)
  assert.equal(await readFile(file, 'utf8'), original)
  assert.equal(
    await page
      .locator('.tiptap')
      .evaluate((element) => element.isContentEditable),
    true,
  )
})

test('custom words are added, edited, removed, kept across restart, and suggested without going online', {
  timeout: 120000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-dictionary-custom-'))
  const file = join(profile, 'note.md')
  await writeFile(file, 'The zorp is kilig')
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ dictionary: true, autocomplete: true }),
  )
  let app
  t.after(async () => {
    await app?.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app?.close()
    await rm(profile, { recursive: true, force: true })
  })
  const launch = async () => {
    app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${profile}`],
    })
    await app.evaluate(({ dialog }, path) => {
      dialog.showMessageBox = async () => ({ response: 1 })
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      })
      globalThis.fetch = async (input) => {
        throw new Error(`network forbidden: ${input}`)
      }
    }, file)
    const page = await app.firstWindow()
    page.setDefaultTimeout(APP_STATE_TIMEOUT)
    await waitForDocumentEditor(app, page)
    await app.evaluate(({ ipcMain }) => {
      globalThis.onlineRequests = []
      ipcMain.removeHandler('host-network:get-text')
      ipcMain.handle('host-network:get-text', (_event, _owner, request) => {
        globalThis.onlineRequests.push(request.url)
        throw new Error('online dictionary network forbidden')
      })
    })
    return page
  }
  let page = await launch()
  const online = () => app.evaluate(() => globalThis.onlineRequests)
  const openSettings = async () => {
    await clickMenu(app, 'Settings')
    await page
      .getByRole('tab', { name: 'Dictionary and thesaurus', exact: true })
      .click()
    return page.getByRole('region', { name: 'Custom words' })
  }
  const closeSettings = async () => {
    await page.getByRole('button', { name: /back to app/i }).click()
    await page.locator('.settings-screen').waitFor({ state: 'hidden' })
    await waitForDocumentEditor(app, page)
  }

  await clickMenu(app, 'Open…')
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).name === 'note.md',
  )
  await waitForDocumentEditor(app, page)
  const rich = page.locator('.rich-pane .tiptap[contenteditable="true"]')
  await rich.click()
  await rich.evaluate((element) => element.editor.commands.setTextSelection(6))

  // A word with no entry is added from the side view and then shown as yours.
  await clickMenu(app, 'Command palette')
  await page
    .getByRole('combobox', { name: /search commands/i })
    .fill('Open dictionary side view')
  await page.getByRole('option', { name: /Open dictionary side view/ }).click()
  const side = page.getByRole('complementary', { name: 'Dictionary' })
  await side.getByRole('heading', { name: 'zorp', exact: true }).waitFor()
  await side.getByRole('button', { name: 'Add to dictionary' }).click()
  await side.getByText('Added to your dictionary.').waitFor()
  await side.getByText('Your word', { exact: true }).waitFor()

  // Settings: add, give a language and a note, and remove.
  let words = await openSettings()
  await words.getByRole('listitem').filter({ hasText: 'zorp' }).waitFor()
  await words.getByRole('textbox', { name: 'New custom word' }).fill('kilig')
  await words.getByRole('button', { name: 'Add', exact: true }).click()
  await words
    .getByRole('combobox', { name: 'Language of “kilig”' })
    .selectOption('tl')
  const longTerm = `custom${'x'.repeat(128)}`
  const longNote = 'full note '.repeat(400).trim()
  await words.getByRole('textbox', { name: 'New custom word' }).fill(longTerm)
  await words.getByRole('button', { name: 'Add', exact: true }).click()
  const longInput = words.getByRole('textbox', {
    name: `Note for “${longTerm}”`,
  })
  await longInput.fill(longNote)
  await longInput.blur()
  await waitForAsync(
    page,
    async ({ longTerm, longNote }) =>
      (
        await window.hibi.queryAddon('dictionary', 'customWords', {})
      ).words.some((item) => item.word === longTerm && item.note === longNote),
    { longTerm, longNote },
  )
  await words.getByRole('button', { name: `Remove “${longTerm}”` }).click()
  await longInput.waitFor({ state: 'detached' })
  const note = words.getByRole('textbox', { name: 'Note for “zorp”' })
  await note.fill('a made-up word')
  await note.press('Tab')
  await words.getByRole('textbox', { name: 'New custom word' }).fill('Hibiland')
  await words.getByRole('button', { name: 'Add', exact: true }).click()
  await words.getByRole('button', { name: 'Remove “kilig”' }).click()
  await words.getByRole('button', { name: 'Remove “kilig”' }).waitFor({
    state: 'detached',
  })
  await page.screenshot({ path: 'test-results/dictionary-custom-words.png' })
  await closeSettings()

  // Suggestions put custom words first and never go online.
  await rich.evaluate((element) => element.editor.commands.focus('end'))
  await page.keyboard.type(' Hib')
  const menu = page.getByRole('listbox', { name: 'Completions' })
  await menu
    .getByRole('option', { name: /^Hibiland/ })
    .filter({ hasText: 'Your word' })
    .waitFor()
  await page.keyboard.press('ArrowDown')
  await menu.getByRole('option', { selected: true }).waitFor()
  await page.keyboard.press('Enter')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.endsWith(' Hibiland'),
  )
  assert.deepEqual(await online(), [])

  // Words, notes, and languages survive a restart.
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  await app.close()
  app = undefined
  page = await launch()
  words = await openSettings()
  await words.getByRole('listitem').filter({ hasText: 'Hibiland' }).waitFor()
  assert.equal(
    await words.getByRole('textbox', { name: 'Note for “zorp”' }).inputValue(),
    'a made-up word',
  )
  assert.equal(
    await words.getByRole('button', { name: 'Remove “kilig”' }).count(),
    0,
  )
  // Export copies plain text that import accepts.
  await words.getByRole('button', { name: 'Export as text' }).click()
  await waitForAsync(
    page,
    () =>
      document.getElementById('dictionary-words-text').value ===
      'zorp\t\ta made-up word\nHibiland',
  )
  await words
    .getByRole('textbox', { name: 'Custom words as text' })
    .fill('kilig\ttl\tgiddy')
  await words.getByRole('button', { name: 'Import text' }).click()
  await words.getByText('Imported 1 word.').waitFor()
  assert.equal(
    await words
      .getByRole('combobox', { name: 'Language of “kilig”' })
      .inputValue(),
    'tl',
  )

  // A second click while the picker is open is ignored, and cancelling changes nothing.
  const status = words.getByRole('status')
  const listed = words.getByRole('listitem')
  const importFile = words.getByRole('button', { name: 'Import from file…' })
  await app.evaluate(({ dialog }) => {
    globalThis.pickers = 0
    dialog.showOpenDialog = () => {
      globalThis.pickers++
      return new Promise((done) => {
        globalThis.closePicker = done
      })
    }
  })
  await importFile.dblclick()
  await waitForAsync(app, () => globalThis.pickers === 1)
  assert.equal(await importFile.isDisabled(), true)
  await app.evaluate(() =>
    globalThis.closePicker({ canceled: true, filePaths: [] }),
  )
  await waitForAsync(page, () =>
    [...document.querySelectorAll('button')].some(
      (button) =>
        button.textContent === 'Import from file…' && !button.disabled,
    ),
  )
  assert.equal(await app.evaluate(() => globalThis.pickers), 1)
  assert.equal(await status.textContent(), 'Imported 1 word.')
  assert.equal(await listed.count(), 3)

  // Export writes a new file only and never replaces one.
  const directory = await realpath(profile)
  const exported = join(directory, 'words.txt')
  const saved = 'zorp\t\ta made-up word\nHibiland\nkilig\ttl\tgiddy\n'
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
  }, exported)
  const exportFile = words.getByRole('button', { name: 'Export to file…' })
  await exportFile.click()
  await words.getByText('Saved your words to words.txt.').waitFor()
  assert.equal(await readFile(exported, 'utf8'), saved)
  await exportFile.click()
  await words.getByText('A file already exists at the selected name.').waitFor()
  assert.equal(await readFile(exported, 'utf8'), saved)

  // A file that is not UTF-8 text keeps the typed text and the words.
  const text = words.getByRole('textbox', { name: 'Custom words as text' })
  await text.fill('draft\ten')
  const choose = (path) =>
    app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      })
    }, path)
  await writeFile(join(directory, 'bad.txt'), Buffer.from([0x7a, 0xff, 0x0a]))
  await choose(join(directory, 'bad.txt'))
  await importFile.click()
  await words.getByText('Choose a text file saved as UTF-8.').waitFor()
  assert.equal(await text.inputValue(), 'draft\ten')
  assert.equal(await listed.count(), 3)

  await writeFile(
    join(directory, 'good.txt'),
    'zest\ten\tkeen\nkilig\ttl\tbutterflies\n',
  )
  await choose(join(directory, 'good.txt'))
  await importFile.click()
  await words.getByText('Imported 2 words.').waitFor()
  assert.equal(await listed.count(), 4)
  assert.equal(await text.inputValue(), 'draft\ten')

  // An imported note shows at once, focus alone saves nothing, and a typed note outlives an import.
  const kiligNote = words.getByRole('textbox', { name: 'Note for “kilig”' })
  assert.equal(await kiligNote.inputValue(), 'butterflies')
  await kiligNote.focus()
  await kiligNote.blur()
  const zorpNote = words.getByRole('textbox', { name: 'Note for “zorp”' })
  await text.fill('zorp\t\timported')
  await zorpNote.fill('typed note')
  // A DOM click keeps focus in the note.
  await words
    .getByRole('button', { name: 'Import text' })
    .evaluate((button) => button.click())
  await words.getByText('Imported 1 word.').waitFor()
  assert.equal(await zorpNote.inputValue(), 'typed note')
  await zorpNote.blur()
  await status.waitFor({ state: 'detached' })
  await words.getByRole('button', { name: 'Export as text' }).click()
  await waitForAsync(
    page,
    () =>
      document.getElementById('dictionary-words-text').value ===
      'zorp\t\ttyped note\nHibiland\nkilig\ttl\tbutterflies\nzest\ten\tkeen',
  )

  // With slow saves, typing a note, another, then the first again keeps the last one typed.
  await app.evaluate(({ ipcMain, app }) => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
    const path = process
      .getBuiltinModule('node:path')
      .join(app.getPath('userData'), 'dictionary-custom-words', 'words.sqlite')
    const exportWrite = ipcMain._invokeHandlers.get(
      'host-selected-io:write-export',
    )
    const cancel = ipcMain._invokeHandlers.get('host-selected-io:cancel')
    globalThis.exportWrites = 0
    globalThis.canceledExports = []
    ipcMain.removeHandler('host-selected-io:write-export')
    ipcMain.handle('host-selected-io:write-export', (...args) => {
      globalThis.exportWrites++
      return exportWrite(...args)
    })
    ipcMain.removeHandler('host-selected-io:cancel')
    ipcMain.handle('host-selected-io:cancel', async (...args) => {
      const result = await cancel(...args)
      globalThis.canceledExports.push(result)
      return result
    })
    const write = ipcMain._invokeHandlers.get('addons:profile')
    globalThis.held = []
    globalThis.written = 0
    ipcMain.removeHandler('addons:profile')
    ipcMain.handle('addons:profile', async (event, id, method, input) => {
      if (
        id !== 'dictionary' ||
        method !== 'changeCustomWords' ||
        input?.type !== 'commit'
      )
        return write(event, id, method, input)
      await new Promise((resolve) => globalThis.held.push(resolve))
      try {
        if (globalThis.failNextWrite) {
          globalThis.failNextWrite = false
          throw new Error('Could not save custom words.')
        }
        const result = await write(event, id, method, input)
        const db = new DatabaseSync(path, { readOnly: true })
        try {
          globalThis.lastWrite = {
            value: db.prepare('SELECT word, note FROM words').all(),
          }
        } finally {
          db.close()
        }
        return result
      } finally {
        globalThis.written++
      }
    })
  })
  const release = async (count) => {
    await waitForAsync(app, () => globalThis.held.length === 1)
    await app.evaluate(() => globalThis.held.shift()())
    await waitForAsync(app, (_, count) => globalThis.written === count, count)
  }
  const stored = (note) =>
    waitForAsync(
      app,
      (_, note) =>
        globalThis.lastWrite?.value?.find((item) => item.word === 'zorp')
          ?.note === note,
      note,
    )
  await zorpNote.fill('first')
  await zorpNote.blur()
  await zorpNote.fill('second')
  await zorpNote.blur()
  await zorpNote.fill('first')
  await release(1)
  await release(2)
  await stored('second')
  assert.equal(await zorpNote.inputValue(), 'first')
  await zorpNote.blur()
  await release(3)
  await stored('first')
  assert.equal(await zorpNote.inputValue(), 'first')
  // Typing back the saved note while another save waits still saves it last.
  await zorpNote.fill('other')
  await zorpNote.blur()
  await zorpNote.fill('first')
  await zorpNote.blur()
  await release(4)
  await stored('other')
  await release(5)
  await stored('first')
  assert.equal(await zorpNote.inputValue(), 'first')

  // Clicking export blurs the note; saving while the picker waits must reach the file.
  const heldExport = join(directory, 'held-words.txt')
  await app.evaluate(({ dialog }) => {
    globalThis.exportPickers = 0
    dialog.showSaveDialog = () => {
      globalThis.exportPickers++
      return new Promise((done) => {
        globalThis.closeExportPicker = done
      })
    }
  })
  await zorpNote.fill('exported note')
  await exportFile.click()
  await waitForAsync(
    app,
    () => globalThis.held.length === 1 && globalThis.exportPickers === 1,
  )
  assert.equal(await exportFile.isDisabled(), true)
  await release(6)
  await stored('exported note')
  await app.evaluate(
    (_, path) =>
      globalThis.closeExportPicker({ canceled: false, filePath: path }),
    heldExport,
  )
  await words.getByText('Saved your words to held-words.txt.').waitFor()
  assert.equal(
    await readFile(heldExport, 'utf8'),
    'zorp\t\texported note\nHibiland\nkilig\ttl\tbutterflies\nzest\ten\tkeen\n',
  )

  // Clipboard export waits for the note save too, leaving the text alone until then.
  await text.fill('paste draft')
  await zorpNote.fill('copied note')
  await words.getByRole('button', { name: 'Export as text' }).click()
  await waitForAsync(app, () => globalThis.held.length === 1)
  assert.equal(await text.inputValue(), 'paste draft')
  await release(7)
  const copied =
    'zorp\t\tcopied note\nHibiland\nkilig\ttl\tbutterflies\nzest\ten\tkeen'
  await waitForAsync(
    page,
    (copied) =>
      document.getElementById('dictionary-words-text').value === copied,
    copied,
  )
  await words.getByText('Copied your words as text.').waitFor()
  assert.equal(
    await app.evaluate(({ clipboard }) => clipboard.readText()),
    copied,
  )

  // A failed pending save blocks file export and keeps both typed drafts.
  const failedExport = join(directory, 'failed-words.txt')
  await app.evaluate(({ dialog }, path) => {
    globalThis.failNextWrite = true
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
  }, failedExport)
  await text.fill('keep pasted draft')
  await zorpNote.fill('unsaved note')
  await exportFile.click()
  await waitForAsync(app, () => globalThis.held.length === 1)
  await release(8)
  await waitForAsync(
    page,
    () =>
      ![...document.querySelectorAll('button')].find(
        (button) => button.textContent === 'Export to file…',
      ).disabled,
  )
  assert.equal(await status.textContent(), 'Could not save custom words.')
  assert.equal(await zorpNote.inputValue(), 'unsaved note')
  assert.equal(await text.inputValue(), 'keep pasted draft')
  await assert.rejects(readFile(failedExport), { code: 'ENOENT' })
  assert.deepEqual(await app.evaluate(() => globalThis.canceledExports), [
    { ok: true, value: null },
  ])
  assert.equal(await app.evaluate(() => globalThis.exportWrites), 1)
  assert.equal(await app.evaluate(() => globalThis.written), 8)
  assert.equal(await app.evaluate(() => globalThis.held.length), 0)

  // A failed note followed by a successful language save stays an export failure.
  const queuedExport = join(directory, 'queued-failure.txt')
  await app.evaluate(({ dialog }) => {
    globalThis.failNextWrite = true
    globalThis.exportPickers = 0
    dialog.showSaveDialog = () => {
      globalThis.exportPickers++
      return new Promise((done) => {
        globalThis.closeExportPicker = done
      })
    }
  })
  await text.fill('queued paste draft')
  await zorpNote.fill('queued unsaved note')
  await zorpNote.blur()
  await waitForAsync(app, () => globalThis.held.length === 1)
  await words
    .getByRole('combobox', { name: 'Language of “zorp”' })
    .selectOption('en')
  await exportFile.click()
  await waitForAsync(app, () => globalThis.exportPickers === 1)
  await release(9)
  await waitForAsync(app, () => globalThis.held.length === 1)
  assert.equal(await exportFile.isDisabled(), true)
  await release(10)
  await stored('copied note')
  assert.equal(await zorpNote.inputValue(), 'queued unsaved note')
  await app.evaluate(
    (_, path) =>
      globalThis.closeExportPicker({ canceled: false, filePath: path }),
    queuedExport,
  )
  await waitForAsync(
    page,
    () =>
      ![...document.querySelectorAll('button')].find(
        (button) => button.textContent === 'Export to file…',
      ).disabled,
  )
  assert.equal(await status.textContent(), 'Could not save custom words.')
  assert.equal(await text.inputValue(), 'queued paste draft')
  assert.equal(await zorpNote.inputValue(), 'queued unsaved note')
  await assert.rejects(readFile(queuedExport), { code: 'ENOENT' })
  assert.deepEqual(await app.evaluate(() => globalThis.canceledExports), [
    { ok: true, value: null },
    { ok: true, value: null },
  ])
  assert.equal(await app.evaluate(() => globalThis.exportWrites), 1)

  // An explicit note retry recovers without retaining the earlier export failure.
  await zorpNote.fill('recovered note')
  await words.getByRole('button', { name: 'Export as text' }).click()
  await waitForAsync(app, () => globalThis.held.length === 1)
  await release(11)
  await waitForAsync(
    page,
    () =>
      document.getElementById('dictionary-words-text').value ===
      'zorp\ten\trecovered note\nHibiland\nkilig\ttl\tbutterflies\nzest\ten\tkeen',
  )
  await words.getByText('Copied your words as text.').waitFor()
  const recoveredExport = join(directory, 'recovered-words.txt')
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
  }, recoveredExport)
  await exportFile.click()
  await words.getByText('Saved your words to recovered-words.txt.').waitFor()
  assert.equal(
    await readFile(recoveredExport, 'utf8'),
    'zorp\ten\trecovered note\nHibiland\nkilig\ttl\tbutterflies\nzest\ten\tkeen\n',
  )
  assert.equal(await app.evaluate(() => globalThis.exportWrites), 2)
  assert.equal(await app.evaluate(() => globalThis.canceledExports.length), 2)
  assert.equal(await app.evaluate(() => globalThis.written), 11)
  assert.equal(await app.evaluate(() => globalThis.held.length), 0)
  assert.deepEqual(await online(), [])
})

test('5,000 custom words keep bounded live rows, skip hidden discovery work, and keep a failed note', {
  timeout: 120000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-dictionary-many-'))
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
  page.setDefaultTimeout(APP_STATE_TIMEOUT)
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ ipcMain }) => {
    const query = ipcMain._invokeHandlers.get('addons:query')
    const write = ipcMain._invokeHandlers.get('addons:profile')
    globalThis.packReads = 0
    ipcMain.removeHandler('addons:query')
    ipcMain.handle('addons:query', (event, id, method, ...input) => {
      if (id === 'dictionary' && method === 'packs') globalThis.packReads++
      return query(event, id, method, ...input)
    })
    ipcMain.removeHandler('addons:profile')
    ipcMain.handle('addons:profile', (event, id, method, input) => {
      if (
        globalThis.failNextWrite &&
        id === 'dictionary' &&
        method === 'changeCustomWords' &&
        input?.type === 'commit'
      ) {
        globalThis.failNextWrite = false
        throw new Error('Could not save custom words.')
      }
      return write(event, id, method, input)
    })
  })
  const palette = page.getByRole('dialog', { name: /command palette/i })
  const search = page.getByRole('combobox', { name: /search commands/i })
  // The background addon is running once its command is listed.
  await clickMenu(app, 'Command palette')
  await search.fill('Open dictionary side view')
  await page
    .getByRole('option', { name: /Open dictionary side view/ })
    .waitFor()
  await page.keyboard.press('Escape')
  await palette.waitFor({ state: 'hidden' })

  await clickMenu(app, 'Settings')
  await page
    .getByRole('tab', { name: 'Dictionary and thesaurus', exact: true })
    .click()
  const words = page.getByRole('region', { name: 'Custom words' })
  const name = (index) => `w${String(index).padStart(4, '0')}`
  const file = join(await realpath(profile), 'words.txt')
  await writeFile(
    file,
    Array.from({ length: 5000 }, (_, index) => name(index)).join('\n'),
  )
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await words.getByRole('button', { name: 'Import from file…' }).click()
  await words.getByText('Imported 5000 words.').waitFor()
  await waitForAsync(app, () => globalThis.packReads > 0)
  const remove = (index) =>
    words.getByRole('button', { name: `Remove “${name(index)}”` })
  const note = (index) =>
    words.getByRole('textbox', { name: `Note for “${name(index)}”` })
  const scrollList = (edge) =>
    page.evaluate((edge) => {
      const scroller = document.querySelector('.settings-content')
      // Spacers around the mounted rows hold the full list height.
      const list = document
        .querySelector('.dictionary-custom-words ul')
        .parentElement.getBoundingClientRect()
      const view = scroller.getBoundingClientRect()
      scroller.scrollTop +=
        edge === 'end' ? list.bottom - view.bottom : list.top - view.top
    }, edge)
  // Rows within one viewport above and below stay live, plus a focused row and
  // its neighbors; the rest only keep their height.
  const live = () =>
    page.evaluate(() => {
      const section = document.querySelector('.dictionary-custom-words')
      const rows = section.querySelectorAll('li')
      return {
        rows: rows.length,
        selects: section.querySelectorAll('select').length,
        bound:
          Math.ceil(
            (3 * document.querySelector('.settings-content').clientHeight) /
              rows[0].offsetHeight,
          ) + 2,
        height: section.querySelector('ul').parentElement.offsetHeight,
        expected: 5000 * rows[0].offsetHeight,
      }
    })
  await remove(0).waitFor()
  let shown = await live()
  assert.ok(shown.rows > 0 && shown.rows <= shown.bound, JSON.stringify(shown))
  assert.equal(shown.selects, shown.rows)
  assert.equal(shown.height, shown.expected)

  // A focused row stays mounted while the list scrolls past it.
  await note(0).focus()
  await scrollList('end')
  await remove(4999).waitFor()
  assert.equal(
    await page.evaluate(() =>
      document.activeElement?.getAttribute('aria-label'),
    ),
    `Note for “${name(0)}”`,
  )
  shown = await live()
  assert.ok(shown.rows <= shown.bound + 3, JSON.stringify(shown))

  // A note whose save failed keeps its text after its row unmounts far off screen.
  await app.evaluate(() => {
    globalThis.failNextWrite = true
  })
  await note(4999).fill('kept after failure')
  await note(4999).blur()
  await words.getByText('Could not save custom words.').waitFor()
  // Focus moving to another control releases the row; the note stays with its word.
  await words.getByRole('textbox', { name: 'New custom word' }).focus()
  await scrollList('start')
  await remove(1).waitFor()
  await note(4999).waitFor({ state: 'detached' })
  shown = await live()
  assert.ok(shown.rows <= shown.bound, JSON.stringify(shown))
  await scrollList('end')
  await remove(4999).waitFor()
  assert.equal(await note(4999).inputValue(), 'kept after failure')

  // Palette discovery finds the page's settings without its list or pack reads.
  await page.getByRole('button', { name: /back to app/i }).click()
  await page.locator('.settings-screen').waitFor({ state: 'hidden' })
  await app.evaluate(() => {
    globalThis.packReads = 0
  })
  await clickMenu(app, 'Command palette')
  await search.fill('new custom word')
  await page.getByRole('option', { name: /^New custom word/ }).waitFor()
  assert.deepEqual(
    await page.evaluate(() => ({
      discovered: !!document.getElementById('dictionary-new-word'),
      rows: document.querySelectorAll('.dictionary-custom-words li').length,
      licenses: document.querySelectorAll('.license-row').length,
    })),
    { discovered: true, rows: 0, licenses: 0 },
  )
  assert.equal(await app.evaluate(() => globalThis.packReads), 0)
  await search.press('Enter')
  await palette.waitFor({ state: 'hidden' })
  await page.waitForFunction(
    () => document.activeElement?.id === 'dictionary-new-word',
  )
  await remove(0).waitFor()
  await waitForAsync(app, () => globalThis.packReads > 0)
})
