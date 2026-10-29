import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { selectFormattedEngine } from './formatted-engine.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
const hash = (value) => createHash('sha256').update(value).digest('hex')

test('blank-tail Enter preserves exact source bytes through typing, undo, redo and save', {
  timeout: 120000,
}, async (t) => {
  // .scratch is untracked, so a fresh checkout has none.
  await mkdir('.scratch', { recursive: true })
  const folder = await mkdtemp(resolve('.scratch/blank-tail-native-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  let cdp
  t.after(async () => {
    await cdp?.detach()
    await app.close()
  })
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  const page = await app.firstWindow()
  await selectFormattedEngine(app, page, 'codemirror')
  cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const editor = page.getByRole('textbox', {
    name: 'Document editor',
    exact: true,
  })
  const current = () =>
    page.evaluate(async () => {
      await window.hibi.flushDocumentChanges()
      return (await window.hibi.getDocument()).markdown
    })
  const prefix = `first\n\n${'old tail\n\n'.repeat(20000)}`
  const mixed = ' \t\n'.repeat(1366)
  const cases = [
    { name: 'lf-caret', eol: '\n', selected: '', tail: mixed, breaks: 2 },
    {
      name: 'lf-forward',
      eol: '\n',
      selected: '\n\nsecond',
      tail: '\n' + mixed,
      breaks: 2,
    },
    {
      name: 'crlf-backward',
      eol: '\r\n',
      selected: '\n\nsecond',
      tail: '\n' + mixed,
      backward: true,
      breaks: 2,
    },
    {
      name: 'crlf-unicode',
      eol: '\r\n',
      selected: '',
      tail: ' \t\u00a0\ufeff\u2003\n'.repeat(1000),
      breaks: 2,
    },
    {
      name: 'lf-nonblank',
      eol: '\n',
      selected: '',
      tail: mixed + 'last',
      breaks: 1,
    },
  ]
  const rows = []
  for (const item of cases)
    await t.test(item.name, async () => {
      const raw = (value) => value.replace(/\n/g, item.eol)
      const source = raw(prefix + item.selected + item.tail)
      const entered = raw(prefix + '\n'.repeat(item.breaks) + item.tail)
      const expected = raw(prefix + '\n'.repeat(item.breaks) + 'z' + item.tail)
      const file = join(folder, item.name + '.md')
      await writeFile(file, source)
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
        item.name + '.md',
      )
      await waitForDocumentEditor(app, page)
      await page.waitForFunction(
        (source) =>
          document
            .querySelector('[aria-label="Document editor"]')
            ?.cmTile?.root.view.state.doc.toString() === source,
        prefix + item.selected + item.tail,
      )
      const from = prefix.length,
        to = from + item.selected.length
      await editor.evaluate(
        (element, selection) => {
          const view = element.cmTile.root.view
          view.focus()
          view.dispatch({ selection })
        },
        item.backward ? { anchor: to, head: from } : { anchor: from, head: to },
      )
      await page.keyboard.press('Enter')
      assert.equal(
        await current(),
        entered,
        'Enter changes only the selected source',
      )
      await page.keyboard.insertText('z')
      assert.equal(await current(), expected, 'typed source')
      await pressShortcut(app, modifier + '+z')
      assert.equal(await current(), entered, 'undo typing')
      await pressShortcut(app, modifier + '+z')
      assert.equal(await current(), source, 'undo Enter')
      await pressShortcut(app, modifier + '+Shift+z')
      assert.equal(await current(), entered, 'redo Enter')
      await pressShortcut(app, modifier + '+Shift+z')
      assert.equal(await current(), expected, 'redo typing')
      await page.evaluate(() => window.hibi.saveDocument(false))
      await waitForAsync(
        page,
        async () => !(await window.hibi.getDocument()).dirty,
      )
      const saved = await readFile(file)
      assert.deepEqual(saved, Buffer.from(expected), 'exact saved bytes')
      rows.push({
        name: item.name,
        original: hash(source),
        saved: hash(saved),
        bytes: saved.length,
        undoSteps: 2,
      })
    })
  await writeFile(join(folder, 'proof.json'), JSON.stringify(rows, null, 2))
})
