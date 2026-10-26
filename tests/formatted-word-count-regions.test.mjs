import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { countText } from '../src/addons/word-count/count.ts'
import { richText } from '../src/addons/word-count/formatted-text.ts'
import { defaultNoteSyntax } from '../src/shared/note-syntax.ts'
import { electron, waitForAsync, waitForDocumentEditor } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

const syntax = {
  ...defaultNoteSyntax,
  math: true,
  textExtras: true,
  alerts: true,
}
const label = ({ words, characters }) =>
  `${words} ${words === 1 ? 'word' : 'words'} · ${characters} ${characters === 1 ? 'character' : 'characters'}`
test('math regions and leading empty paragraphs match native rich counts after edits and undo', {
  timeout: 180000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-count-regions-'))
  await writeFile(
    join(folder, 'addons.json'),
    JSON.stringify({ 'word-count': true, math: true }),
  )
  const fixtures = ['before\n\n$$\nx\n\ny\n$$\n\nafter', '\n\nb']
  for (const [index, source] of fixtures.entries())
    await writeFile(join(folder, `${index}.md`), source)
  const app = await electron.launch({
    args: [resolve('.'), '--user-data-dir=' + folder],
  })
  t.after(async () => {
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  await waitForDocumentEditor(app, page)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const counts = (text) =>
    page.waitForFunction(
      (text) =>
        document.querySelector('[data-status-id="word-count.total"]')
          ?.textContent === text,
      text,
    )
  for (const [index, source] of fixtures.entries()) {
    await page.evaluate(() => localStorage.removeItem('hibi:formatted-engine'))
    await page.reload()
    await waitForDocumentEditor(app, page)
    await app.evaluate(
      ({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [path],
        })
      },
      join(folder, `${index}.md`),
    )
    await clickMenu(app, 'Open…')
    await waitForAsync(
      page,
      async (name) => (await window.hibi.getDocument()).name === name,
      `${index}.md`,
    )
    const want = label(countText(richText(source, syntax).slice(1)))
    await counts(want)
    await page.evaluate(() =>
      localStorage.setItem('hibi:formatted-engine', 'codemirror'),
    )
    await page.reload()
    await waitForDocumentEditor(app, page)
    await counts(want)
    await page.evaluate(() => {
      const view = document.querySelector('.rich-pane .cm-content').cmTile.root
        .view
      view.focus()
      view.dispatch({
        changes: { from: view.state.doc.length, insert: ' more' },
        userEvent: 'input.type',
      })
    })
    await counts(label(countText(richText(source + ' more', syntax).slice(1))))
    await page
      .locator('.rich-pane .cm-content')
      .press((process.platform === 'darwin' ? 'Meta' : 'Control') + '+z')
    await counts(want)
    assert.equal(
      await page.evaluate(
        async () => (await window.hibi.getDocument()).markdown,
      ),
      source,
    )
  }
  assert.deepEqual(errors, [])
})
