import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { countText } from '../src/addons/word-count/count.ts'
import { richText } from '../src/addons/word-count/formatted-text.ts'
import { defaultNoteSyntax } from '../src/shared/note-syntax.ts'
import {
  after,
  before,
  electron,
  waitForAsync,
  waitForDocumentEditor,
} from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const syntax = { ...defaultNoteSyntax, textExtras: true, alerts: true }
const prefix = '---\r\ntitle: Hidden metadata words\r\n---\r\n'
const body =
  '# Counts\r\n\r\nHello **world** &amp; 👩🏽‍💻.\r\n\r\n-# small words\r\n'
const source = prefix + body
const diagram =
  'before\n\n```mermaid\nflowchart LR\nA[Start] --> B[End]\n```\n\nafter'
const typeset = 'before\n\n```typst\n= Heading\nText here\n```\n\nafter'
const label = ({ words, characters }) =>
  `${words.toLocaleString()} ${words === 1 ? 'word' : 'words'} · ${characters.toLocaleString()} ${characters === 1 ? 'character' : 'characters'}`
const expected = (text) => label(countText(richText(text, syntax).slice(1)))
let app, page, folder
const errors = []
const status = () => page.locator('[data-status-id="word-count.total"]')
const sourceText = () =>
  page.evaluate(async () => (await window.hibi.getDocument()).markdown)
const counts = (text) =>
  page.waitForFunction(
    (text) =>
      document.querySelector('[data-status-id="word-count.total"]')
        ?.textContent === text,
    text,
  )

before(
  async () => {
    folder = await mkdtemp(join(tmpdir(), 'hibi-formatted-counts-'))
    await writeFile(
      join(folder, 'addons.json'),
      JSON.stringify({ 'word-count': true, dictionary: true, typst: true }),
    )
    await writeFile(join(folder, 'counts.md'), source)
    await writeFile(join(folder, 'tasks.md'), '- [ ] a\n- [ ]\tbuy milk')
    await writeFile(join(folder, 'diagram.md'), diagram)
    await writeFile(join(folder, 'typeset.md'), typeset)
    await writeFile(
      join(folder, 'other.md'),
      '# Other\n\nA different document.',
    )
    app = await electron.launch({
      args: [resolve('.'), '--user-data-dir=' + folder],
    })
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    page = await app.firstWindow()
    page.setDefaultTimeout(15000)
    page.on('pageerror', (error) => {
      errors.push(error.message)
      console.log('pageerror', error.stack)
    })
    await waitForDocumentEditor(app, page)
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  },
  { timeout: 90000 },
)
after(
  async () => {
    await app?.close()
    if (folder) await rm(folder, { recursive: true, force: true })
  },
  { timeout: 30000 },
)

async function engine(formatted) {
  await page.evaluate((formatted) => {
    if (formatted) localStorage.setItem('hibi:formatted-engine', 'codemirror')
    else localStorage.removeItem('hibi:formatted-engine')
  }, formatted)
  await page.reload()
  await waitForDocumentEditor(app, page)
}
async function open(name) {
  await app.evaluate(
    ({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      })
    },
    join(folder, name),
  )
  await pressShortcut(app, mod + '+o')
  await waitForAsync(
    page,
    async (name) => (await window.hibi.getDocument()).name === name,
    name,
  )
}
test('formatted counts match rich document totals and ignore selections', {
  timeout: 90000,
}, async () => {
  await engine(false)
  await open('counts.md')
  await counts(expected(body))
  const rich = await status().textContent()
  await engine(true)
  await page.locator('.rich-pane .cm-content').waitFor()
  await counts(rich)
  for (const selection of ['all', 'word', 'empty']) {
    await page.evaluate((selection) => {
      const view = document.querySelector('.rich-pane .cm-content').cmTile.root
        .view
      const from = view.state.doc.toString().indexOf('Hello')
      view.focus()
      view.dispatch({
        changes: { from: view.state.doc.length, insert: ' counted' },
        selection: {
          anchor: selection === 'word' ? from : 0,
          head:
            selection === 'all'
              ? view.state.doc.length + 8
              : selection === 'word'
                ? from + 5
                : 0,
        },
        userEvent: 'input.type',
      })
    }, selection)
    await counts(expected(`${body} counted`))
    assert.equal(await sourceText(), `${source} counted`)
    await pressShortcut(app, mod + '+z')
    await counts(rich)
    assert.equal(await sourceText(), source)
  }
})
test('source view counts literal text while split and normal views keep formatted totals', async () => {
  for (const formatted of [false, true]) {
    const name = `mode-${Number(formatted)}.md`
    await writeFile(join(folder, name), source)
    await engine(formatted)
    await open(name)
    await counts(expected(body))
    await page.getByRole('button', { name: /^side-by-side$/i }).click()
    await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
    const editor = page.getByRole('textbox', {
      name: 'Markdown editor',
      exact: true,
    })
    await editor.press('ControlOrMeta+End')
    await page.keyboard.insertText(' added')
    await waitForAsync(
      page,
      async (text) => (await window.hibi.getDocument()).markdown === text,
      source + ' added',
    )
    await counts(expected(body + ' added'))
    await pressShortcut(app, mod + '+Shift+]')
    await page.locator('.editor-panes.mode-markdown').waitFor()
    await counts(label(countText(source + ' added')))
    await pressShortcut(app, mod + '+Shift+[')
    await page.locator('.editor-panes.mode-normal').waitFor()
    await counts(expected(body + ' added'))
  }
})

test('tab-separated tasks count their text in both formatted engines', {
  timeout: 90000,
}, async () => {
  for (const formatted of [false, true]) {
    await engine(formatted)
    await open('tasks.md')
    await counts(label({ words: 3, characters: 13 }))
    assert.equal(await sourceText(), '- [ ] a\n- [ ]\tbuy milk')
    assert.equal(
      await page
        .locator(
          formatted
            ? '.rich-pane .hibi-lp-task'
            : '.rich-pane .tiptap input[type="checkbox"]',
        )
        .count(),
      2,
    )
  }
})

test('edits and undo retain exact source and rapid document switches keep their own totals', {
  timeout: 90000,
}, async () => {
  await engine(true)
  await open('counts.md')
  await counts(expected(body))
  await page.evaluate(() => {
    const view = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    const from = view.state.doc.toString().indexOf('Hello')
    view.focus()
    view.dispatch({
      changes: { from, insert: 'new ' },
      selection: { anchor: from + 4 },
      userEvent: 'input.type',
    })
  })
  await counts(expected(body.replace('Hello', 'new Hello')))
  assert.equal(await sourceText(), source.replace('Hello', 'new Hello'))
  await pressShortcut(app, mod + '+z')
  await counts(expected(body))
  assert.equal(await sourceText(), source)
  await open('other.md')
  await counts(expected('# Other\n\nA different document.'))
  await open('counts.md')
  await counts(expected(body))
  assert.equal(await sourceText(), source)
})
for (const [language, name, text] of [
  ['mermaid', 'diagram.md', diagram],
  ['typst', 'typeset.md', typeset],
])
  test(`${language} formatted counts match native opaque blocks through toggles and undo`, {
    timeout: 90000,
  }, async () => {
    await engine(false)
    await open(name)
    await page.locator(`.rich-pane .tiptap .${language}-block`).waitFor()
    await counts(label(countText('before\n\nafter')))
    const native = await status().textContent()
    await engine(true)
    await page.locator(`.rich-pane .${language}-block`).waitFor()
    await counts(native)
    await page.evaluate(
      (word) => {
        const view = document.querySelector('.rich-pane .cm-content').cmTile
          .root.view
        const from = view.state.doc.toString().indexOf(word)
        view.focus()
        view.dispatch({
          changes: { from, insert: 'extra ' },
          selection: { anchor: from + 6 },
          userEvent: 'input.type',
        })
      },
      language === 'mermaid' ? 'Start' : 'Text',
    )
    assert.equal(
      await sourceText(),
      text.replace(
        language === 'mermaid' ? 'Start' : 'Text',
        language === 'mermaid' ? 'extra Start' : 'extra Text',
      ),
    )
    await counts(native)
    await pressShortcut(app, mod + '+z')
    assert.equal(await sourceText(), text)
    await counts(native)
    const closing = text.lastIndexOf('```') + 3
    const tabbed = text.slice(0, closing) + '\t' + text.slice(closing)
    const tabCount =
      language === 'mermaid' ? label(countText('before\n')) : native
    await page.evaluate((from) => {
      const view = document.querySelector('.rich-pane .cm-content').cmTile.root
        .view
      view.focus()
      view.dispatch({
        changes: { from, insert: '\t' },
        userEvent: 'input.type',
      })
    }, closing)
    await counts(tabCount)
    assert.equal(await sourceText(), tabbed)
    await pressShortcut(app, mod + '+z')
    await counts(native)
    assert.equal(await sourceText(), text)
    await pressShortcut(app, mod + '+Shift+z')
    await counts(tabCount)
    assert.equal(await sourceText(), tabbed)
    await pressShortcut(app, mod + '+z')
    await counts(native)
    assert.equal(await sourceText(), text)
    for (const [tab, selector, visible] of [
      ['Addon Manager', `#addon-${language}`, expected(text)],
      [
        'Syntax',
        `input[id="syntax-${language}.blocks"]`,
        label(countText(text.replaceAll('\n\n', '\n'))),
      ],
    ]) {
      for (const enabled of [false, true]) {
        await clickMenu(app, 'Settings')
        await page.getByRole('tab', { name: tab, exact: true }).click()
        await page.locator(selector).click()
        await page
          .getByRole('button', { name: 'Back to app', exact: true })
          .click()
        await counts(enabled ? native : visible)
        assert.equal(await sourceText(), text)
        if (!enabled) {
          await engine(false)
          await counts(visible)
          await engine(true)
          await counts(visible)
        }
      }
    }
    await open('counts.md')
    await counts(expected(body))
  })

test('disable and enable remove and restore formatted counts without changing source', {
  timeout: 90000,
}, async () => {
  for (const enabled of [false, true]) {
    await clickMenu(app, 'Settings')
    await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
    await page.locator('#addon-word-count').click()
    await page.waitForFunction(
      (enabled) =>
        document.querySelector('#addon-word-count').checked === enabled,
      enabled,
    )
    await page.getByRole('button', { name: 'Back to app', exact: true }).click()
    if (enabled) await counts(expected(body))
    else assert.equal(await status().count(), 0)
    assert.equal(await sourceText(), source)
  }
  assert.deepEqual(errors, [])
})
