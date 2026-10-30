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

/** Launch with the dictionary, autocomplete and the `engine` formatted view, and answer lookups from fixtures. */
async function launch(t, files, engine = 'codemirror') {
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
  if (engine === 'codemirror') {
    await page.evaluate(() =>
      localStorage.setItem('hibi:formatted-engine', 'codemirror'),
    )
    await page.reload()
    await waitForDocumentEditor(app, page)
  }
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
    await waitForDocumentEditor(app, page)
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
  await waitForDocumentEditor(app, page)
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

/** Put the rich editor's caret `offset` characters into the first `text` of a paragraph. */
const richCaret = (page, text, offset) =>
  page.evaluate(
    ({ text, offset }) => {
      const editor = document.querySelector('.rich-pane .tiptap').editor
      let at = null
      editor.state.doc.descendants((node, pos) => {
        if (at !== null) return false
        if (!node.isTextblock) return true
        const index = node.textContent.indexOf(text)
        if (index >= 0) at = pos + 1 + index + offset
        return false
      })
      editor.commands.focus()
      editor.commands.setTextSelection(at)
    },
    { text, offset },
  )

/** Look up the caret word's synonyms and choose `choice`. */
async function chooseSynonym(app, page, word, choice) {
  await pressShortcut(app, 'Shift+F7')
  const dialog = page.getByRole('dialog', { name: `Synonyms for “${word}”` })
  await dialog.getByRole('button', { name: choice, exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
}

const linkNote = `Link [Happy](https://happy.example) here

Reference [Happy][ref] here

Code \`happy\` and tag #happy here

[ref]: https://x.example
`

for (const engine of ['tiptap', 'codemirror'])
  test(`in the ${engine} formatted view, a replaced word in a link's text keeps the link's destination`, {
    timeout: 90000,
  }, async (t) => {
    const { app, page, open } = await launch(
      t,
      { 'links.md': linkNote },
      engine,
    )
    await open('links.md')
    const cases = [
      ['[Happy](', 'Link Happy', 'Happy', '[Glad]('],
      ['[Happy][ref]', 'Reference Happy', 'Happy', '[Glad][ref]'],
      ['`happy`', 'Code happy', 'happy', '`glad`'],
      ['#happy', 'tag #happy', 'happy', '#glad'],
    ]
    for (const [source, rich, word, replaced] of cases) {
      if (engine === 'codemirror')
        await caret(page, linkNote.indexOf(source) + 3)
      else await richCaret(page, rich, rich.length - 2)
      await chooseSynonym(app, page, word, 'glad')
      await saved(page, linkNote.replace(source, replaced))
      if (engine === 'codemirror') await pressShortcut(app, `${mod}+z`)
      else
        await page.evaluate(() =>
          document.querySelector('.rich-pane .tiptap').editor.commands.undo(),
        )
      await saved(page, linkNote)
    }
  })

test('in the formatted view a wikilink keeps its target, and destinations, labels and embeds offer no word', {
  timeout: 90000,
}, async (t) => {
  const note = `Link [Happy](https://happy.example "happy title") here

Reference [x][happy] and [Happy][] and [Happy] here

Wiki [[Happy]] and [[Note|Happy]] and [[Happy|Note]] here

Embed ![[Happy.png]] here

Autolink <https://happy.example> and https://happy.example here

Footnote [^Happy] here

[^Happy]: Happy note

| Wiki | Cell |
| - | - |
| [[Happy]] | x |

[happy]: https://happy.example
`
  const { app, page, open } = await launch(t, { 'wiki.md': note })
  await open('wiki.md')
  await page
    .locator('.rich-pane .cm-line', { hasText: 'Wiki' })
    .first()
    .waitFor()
  // A wikilink without an alias keeps its target and shows the new word as
  // its alias, as the rich view writes it; in a table the alias pipe is
  // escaped. A footnote's text changes in place.
  for (const [source, offset, replaced] of [
    ['[[Happy]] and', 3, '[[Happy|Glad]] and'],
    ['[[Note|Happy]]', 8, '[[Note|Glad]]'],
    ['| [[Happy]] |', 5, '| [[Happy\\|Glad]] |'],
    ['[^Happy]: Happy note', 12, '[^Happy]: Glad note'],
  ]) {
    await caret(page, note.indexOf(source) + offset)
    await chooseSynonym(app, page, 'Happy', 'glad')
    await saved(page, note.replace(source, replaced))
    await pressShortcut(app, `${mod}+z`)
    await saved(page, note)
  }
  // Text the formatted view shows as a link's destination, title or label, a
  // footnote's label, an alias's target, an embed, or a URL is not a word to
  // look up.
  await page.evaluate(() => {
    window.noWordNotices = 0
    new MutationObserver((records) => {
      for (const { addedNodes } of records)
        for (const node of addedNodes)
          if (node instanceof Element)
            for (const toast of [node, ...node.querySelectorAll('.toast')])
              if (
                toast.matches('.toast') &&
                toast.textContent.includes(
                  'Place the cursor in a word or select one word.',
                )
              )
                window.noWordNotices++
    }).observe(document.body, { childList: true, subtree: true })
  })
  const definition = note.indexOf('[happy]: ')
  for (const at of [
    note.indexOf('happy.example "') + 2,
    note.indexOf('happy title') + 2,
    note.indexOf('[x][happy]') + 5,
    note.indexOf('[Happy][]') + 3,
    note.indexOf('[Happy] here') + 3,
    note.indexOf('[[Happy|Note]]') + 3,
    note.indexOf('![[Happy.png]]') + 5,
    note.indexOf('<https://happy.example>') + 10,
    note.indexOf('and https://happy.example') + 14,
    note.indexOf('[^Happy] here') + 4,
    note.indexOf('[^Happy]:') + 4,
    definition + 3,
    note.indexOf('happy.example', definition) + 2,
  ]) {
    const notices = await page.evaluate(() => window.noWordNotices)
    await caret(page, at)
    await pressShortcut(app, 'Shift+F7')
    await waitForAsync(
      page,
      (notices) => window.noWordNotices > notices,
      notices,
    )
    // A reference can show link actions without opening a dictionary dialog.
    assert.equal(
      await page.getByRole('dialog', { name: /^Synonyms for / }).count(),
      0,
      `offset ${at}`,
    )
    assert.equal(await markdown(page), note)
  }
})

test('in the formatted view a right-click offers the dictionary for the pressed word', {
  timeout: 60000,
}, async (t) => {
  const note = 'I am Happy today\n\nThe zorp is here'
  const { page, open } = await launch(t, { 'note.md': note })
  await open('note.md')
  const formatted = page.locator('.rich-pane .formatted-editor .cm-content')
  await page
    .locator('.rich-pane .cm-line', { hasText: 'I am Happy today' })
    .waitFor()
  // The caret is elsewhere until the press puts it in the word.
  await caret(page, note.length)
  const word = await formatted.evaluate(
    (element, at) => element.cmTile.root.view.coordsAtPos(at),
    note.indexOf('Happy') + 2,
  )
  await page.mouse.click(word.left, (word.top + word.bottom) / 2, {
    button: 'right',
  })
  const define = page
    .getByRole('menu', { name: 'Editor actions' })
    .getByRole('menuitem', { name: /^Define word/ })
  await define.waitFor()
  // The menu stays open after the page has moved its caret.
  await new Promise((resolve) => setTimeout(resolve, 300))
  await define.click({ timeout: 1000 })
  await page
    .getByRole('dialog', { name: 'Define “Happy”' })
    .getByText('Music makes me feel happy.')
    .waitFor()
})

test('in the formatted view a press in a selection keeps it for the dictionary', {
  timeout: 60000,
}, async (t) => {
  const note = 'I am Happy today\n\nThe zorp is here'
  const { page, open } = await launch(t, { 'note.md': note })
  await open('note.md')
  const formatted = page.locator('.rich-pane .formatted-editor .cm-content')
  await page
    .locator('.rich-pane .cm-line', { hasText: 'I am Happy today' })
    .waitFor()
  const from = note.indexOf('Happy')
  const selection = { anchor: from, head: from + 'Happy'.length }
  const select = () =>
    formatted.evaluate((element, selection) => {
      const view = element.cmTile.root.view
      view.focus()
      view.dispatch({ selection })
    }, selection)
  const selected = () =>
    formatted.evaluate((element) => {
      const { anchor, head } = element.cmTile.root.view.state.selection.main
      return { anchor, head }
    })
  const word = await formatted.evaluate(
    (element, at) => element.cmTile.root.view.coordsAtPos(at),
    from + 2,
  )
  const define = page
    .getByRole('menu', { name: 'Editor actions' })
    .getByRole('menuitem', { name: /^Define word/ })
  const presses = [
    () =>
      page.mouse.click(word.left, (word.top + word.bottom) / 2, {
        button: 'right',
      }),
  ]
  // macOS opens the menu on a Control+click too.
  if (process.platform === 'darwin')
    presses.push(async () => {
      await page.keyboard.down('Control')
      await page.mouse.click(word.left, (word.top + word.bottom) / 2)
      await page.keyboard.up('Control')
    })
  for (const press of presses) {
    await select()
    await press()
    await define.waitFor()
    // The menu and the selection stay after the press is released.
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.deepEqual(await selected(), selection)
    assert.equal(await define.isVisible(), true)
    await page.keyboard.press('Escape')
    await define.waitFor({ state: 'hidden' })
  }
})
