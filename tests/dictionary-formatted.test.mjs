import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu, pressShortcut, splitTab } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const fixture = (name) =>
  readFile(new URL(`./fixtures/dictionary/${name}`, import.meta.url), 'utf8')

/** Launch with the dictionary, autocomplete and the codemirror formatted view, and answer lookups from fixtures. */
async function launch(t, files) {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-dictionary-formatted-'))
  for (const [name, text] of Object.entries(files))
    await writeFile(join(profile, name), text)
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ dictionary: true, autocomplete: true }),
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
  page.setDefaultTimeout(10000)
  await waitForDocumentEditor(app, page)
  await page.evaluate(() =>
    localStorage.setItem('hibi:formatted-engine', 'codemirror'),
  )
  await page.reload()
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
    'https://api.datamuse.com/words?rel_syn=sad&max=24': '[{"word":"unhappy"}]',
  }
  // The network bridge answers from fixtures; tests never reach the services.
  await app.evaluate(({ ipcMain }, responses) => {
    ipcMain.removeHandler('host-network:get-text')
    ipcMain.handle('host-network:get-text', (_event, _owner, request) => {
      const text = responses[request.url]
      return text === undefined
        ? { ok: false, code: 'http-status', status: 404 }
        : { ok: true, value: { url: request.url, status: 200, text } }
    })
  }, responses)
  // Hidden windows have no focus; the editors' own focus needs emulating.
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const open = async (name) => {
    await app.evaluate(
      ({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [path],
        })
      },
      join(profile, name),
    )
    await clickMenu(app, 'Open…')
    await waitForAsync(
      page,
      async (name) => (await window.hibi.getDocument()).name === name,
      name,
    )
    await waitForDocumentEditor(app, page)
  }
  return { app, page, open }
}

const markdown = async (page) =>
  (await page.evaluate(() => window.hibi.getDocument())).markdown
const saved = (page, text) =>
  waitForAsync(
    page,
    async (text) => (await window.hibi.getDocument()).markdown === text,
    text,
  )
/** Put the caret of the formatted view in `root` at `offset` of its source. */
const caret = (page, offset, root = '.rich-pane') =>
  page.evaluate(
    ({ offset, root }) => {
      const view = document.querySelector(`${root} .cm-content`).cmTile.root
        .view
      view.focus()
      view.dispatch({ selection: { anchor: offset } })
    },
    { offset, root },
  )
const formattedFocused = (page) =>
  waitForAsync(page, () =>
    document.activeElement?.matches('.rich-pane .formatted-editor .cm-content'),
  )
const palette = async (app, page, name) => {
  await clickMenu(app, 'Command palette')
  await page.getByRole('combobox', { name: /search commands/i }).fill(name)
  await page.getByRole('option', { name: new RegExp(name) }).click()
}

test('in the formatted view the dictionary looks up the caret word, replaces it in one undo step, adds words, and completes them', {
  timeout: 90000,
}, async (t) => {
  const note = 'I am Happy today\n\nVery **happy** indeed\n\nThe zorp is here'
  const { app, page, open } = await launch(t, { 'note.md': note })
  await open('note.md')
  const formatted = page.locator('.rich-pane .formatted-editor .cm-content')
  await page
    .locator('.rich-pane .cm-line', { hasText: 'I am Happy today' })
    .waitFor()
  assert.equal(await page.locator('.rich-pane .tiptap').count(), 0)

  // Define word from the palette.
  await caret(page, 'I am Ha'.length)
  await palette(app, page, 'Define word')
  const define = page.getByRole('dialog', { name: 'Define “Happy”' })
  await define.getByText('Music makes me feel happy.').waitFor()
  await page.keyboard.press('Escape')
  await define.waitFor({ state: 'detached' })
  await formattedFocused(page)
  assert.equal(await markdown(page), note)

  // Find synonyms from the editor's actions menu replaces the word, keeping
  // its case, and undo takes it back in one step.
  await formatted.press('Shift+F10')
  await page
    .getByRole('menu', { name: 'Editor actions' })
    .getByRole('menuitem', { name: /^Find synonyms/ })
    .click()
  const synonyms = page.getByRole('dialog', { name: 'Synonyms for “Happy”' })
  await synonyms.getByRole('button', { name: 'glad', exact: true }).click()
  await synonyms.waitFor({ state: 'detached' })
  await saved(page, note.replace('I am Happy', 'I am Glad'))
  await formattedFocused(page)
  await pressShortcut(app, `${mod}+z`)
  await saved(page, note)

  // A word inside formatting is replaced inside its markers.
  await caret(page, note.indexOf('happy**') + 2)
  await pressShortcut(app, 'Shift+F7')
  const lower = page.getByRole('dialog', { name: 'Synonyms for “happy”' })
  await lower.getByRole('button', { name: 'glad', exact: true }).click()
  await saved(page, note.replace('**happy**', '**glad**'))
  await pressShortcut(app, `${mod}+z`)
  await saved(page, note)

  // Editing while the dialog is open cancels the choice with a notice.
  await caret(page, 'I am Ha'.length)
  await pressShortcut(app, 'Shift+F7')
  await synonyms.getByRole('button', { name: 'glad', exact: true }).waitFor()
  await page.evaluate(() => {
    const view = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    view.dispatch({ changes: { from: 0, insert: 'Oh, ' } })
  })
  await synonyms.getByRole('button', { name: 'glad', exact: true }).click()
  await page
    .locator('.toast')
    .filter({ hasText: 'The document changed. Look up the word again.' })
    .waitFor()
  assert.equal(await markdown(page), `Oh, ${note}`)
  await pressShortcut(app, `${mod}+z`)
  await saved(page, note)

  // The side view follows the caret in the formatted view.
  await palette(app, page, 'Open dictionary side view')
  const side = page.getByRole('complementary', { name: 'Dictionary' })
  await caret(page, note.indexOf('zorp') + 2)
  await side.getByRole('heading', { name: 'zorp', exact: true }).waitFor()

  // A word added from the formatted view is completed there as yours.
  await caret(page, note.indexOf('zorp') + 2)
  await palette(app, page, 'Add word to dictionary')
  await page
    .locator('.toast')
    .filter({ hasText: 'Added “zorp” to your dictionary.' })
    .waitFor()
  await caret(page, note.length)
  await page.keyboard.type(' zor')
  const completions = page.locator('.rich-pane .cm-tooltip-autocomplete')
  await completions
    .getByRole('option', { name: /^zorp/ })
    .filter({ hasText: 'Your word' })
    .waitFor()
  // Keys reach a list CodeMirror opened a moment ago only after its
  // interaction delay; press them as if it had been open for a while.
  const press = async (key) => {
    await page.evaluate(() => {
      const now = Date.now
      Date.now = () => now() + 60000
      window.restoreNow = () => {
        Date.now = now
      }
    })
    try {
      await page.keyboard.press(key)
    } finally {
      await page.evaluate(() => window.restoreNow())
    }
  }
  await press('ArrowDown')
  await completions.getByRole('option', { selected: true }).waitFor()
  await press('Enter')
  await saved(page, `${note} zorp`)
})

test('the dictionary replaces the word in the formatted split pane it was invoked from', {
  timeout: 90000,
}, async (t) => {
  const { app, page, open } = await launch(t, {
    'left.md': 'Happy',
    'right.md': 'Sad',
  })
  await open('left.md')
  await open('right.md')
  const rightId = await page
    .getByRole('tab', { name: 'right.md' })
    .evaluate((tab) => tab.closest('[data-tab-key]').dataset.tabKey)
  await page.getByRole('tab', { name: 'left.md' }).click()
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).name === 'left.md',
  )
  await splitTab(app, page, rightId)
  const pane = (side) =>
    `.editor-page[data-side="${side}"] .rich-pane .formatted-editor`
  for (const side of ['left', 'right'])
    await page
      .locator(`${pane(side)} .cm-line`)
      .first()
      .waitFor()
  // Both carets sit at the same offset, so only the view tells them apart.
  for (const side of ['right', 'left']) {
    await page.locator(`${pane(side)} .cm-content`).click()
    await caret(page, 3, pane(side))
  }
  await page.locator(`${pane('left')} .cm-content`).press('Shift+F10')
  await page
    .getByRole('menu', { name: 'Editor actions' })
    .getByRole('menuitem', { name: /^Find synonyms/ })
    .click()
  const synonyms = page.getByRole('dialog', { name: 'Synonyms for “Happy”' })
  await synonyms.getByRole('button', { name: 'glad', exact: true }).click()
  await synonyms.waitFor({ state: 'detached' })
  await waitForAsync(
    page,
    (left) =>
      document.querySelector(`${left} .cm-content`)?.textContent === 'Glad',
    pane('left'),
  )
  assert.equal(
    await page.locator(`${pane('right')} .cm-content`).textContent(),
    'Sad',
  )
  // The right pane's lookup replaces its own word.
  await page.locator(`${pane('right')} .cm-content`).click()
  await caret(page, 3, pane('right'))
  await pressShortcut(app, 'Shift+F7')
  const sad = page.getByRole('dialog', { name: 'Synonyms for “Sad”' })
  await sad.getByRole('button', { name: 'unhappy', exact: true }).click()
  await waitForAsync(
    page,
    (right) =>
      document.querySelector(`${right} .cm-content`)?.textContent === 'Unhappy',
    pane('right'),
  )
  assert.equal(
    await page.locator(`${pane('left')} .cm-content`).textContent(),
    'Glad',
  )
})
