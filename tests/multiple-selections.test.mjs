import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  electron,
  openInDocumentEditor,
  waitForDocumentEditor,
} from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const note = 'alpha one\r\nbeta one\r\ngamma\r\n'

async function open(t, presentation) {
  const root = await mkdtemp(join(tmpdir(), 'hibi-multiple-selections-'))
  const file = join(root, 'note.md')
  await writeFile(file, note)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await openInDocumentEditor(app, page, () => pressShortcut(app, `${mod}+o`))
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    note,
  )
  if (presentation === 'source')
    await page.getByRole('button', { name: 'Source view', exact: true }).click()
  const content = `${presentation === 'source' ? '.source-pane' : '.rich-pane'} .cm-content`
  await page
    .locator(
      `.editor-panes[data-source-ready="true"] ${content}[contenteditable="true"]`,
    )
    .waitFor()
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  return { app, page, content, errors }
}

/** Places the caret, then waits until the editor has focus. */
async function caret(page, content, anchor) {
  await page.evaluate(
    ({ content, anchor }) => {
      const view = document.querySelector(content).cmTile.root.view
      view.focus()
      view.dispatch({ selection: { anchor } })
    },
    { content, anchor },
  )
  await waitForAsync(
    page,
    (content) => document.activeElement === document.querySelector(content),
    content,
  )
}

const ranges = (page, content) =>
  page.evaluate((content) => {
    const { selection } = document.querySelector(content).cmTile.root.view.state
    return selection.ranges.map(({ anchor, head }) => [anchor, head])
  }, content)

const markdown = (page) =>
  page.evaluate(async () => (await window.hibi.getDocument()).markdown)

const settled = (page, expected) =>
  waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    expected,
  )

for (const presentation of ['formatted', 'source'])
  test(`several cursors type, delete, break lines, paste and undo as one step in the ${presentation} view`, {
    timeout: 90000,
  }, async (t) => {
    const { page, content, errors } = await open(t, presentation)
    // Cursors at the ends of "alpha one" and "beta one".
    await caret(page, content, 9)
    await page.evaluate((content) => {
      const view = document.querySelector(content).cmTile.root.view
      const Selection = view.state.selection.constructor
      view.dispatch({
        selection: Selection.create([
          Selection.cursor(9),
          Selection.cursor(18),
        ]),
      })
    }, content)
    assert.deepEqual(await ranges(page, content), [
      [9, 9],
      [18, 18],
    ])
    // The other cursor is drawn beside the native one.
    await page.locator(`${content.split(' ')[0]} .hibi-other-cursor`).waitFor()

    await page.keyboard.type('!')
    await settled(page, 'alpha one!\r\nbeta one!\r\ngamma\r\n')
    await page.keyboard.press('Backspace')
    await settled(page, note)
    await page.keyboard.press('Enter')
    await settled(page, 'alpha one\r\n\r\nbeta one\r\n\r\ngamma\r\n')
    await page.keyboard.press('Backspace')
    await settled(page, note)

    // A paste goes in at every cursor; one undo takes it back.
    await page.evaluate((content) => {
      const data = new DataTransfer()
      data.setData('text/plain', '+')
      document.querySelector(content).dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      )
    }, content)
    await settled(page, 'alpha one+\r\nbeta one+\r\ngamma\r\n')
    await page.keyboard.press(`${mod}+z`)
    await settled(page, note)

    // Escape keeps the main cursor only.
    await page.keyboard.press('Escape')
    assert.equal((await ranges(page, content)).length, 1)

    // Mod-d adds the next occurrence of the selected word.
    await page.evaluate((content) => {
      const view = document.querySelector(content).cmTile.root.view
      view.dispatch({ selection: { anchor: 6, head: 9 } })
    }, content)
    await page.keyboard.press(`${mod}+d`)
    assert.deepEqual(await ranges(page, content), [
      [6, 9],
      [15, 18],
    ])
    await page.keyboard.type('two')
    await settled(page, 'alpha two\r\nbeta two\r\ngamma\r\n')

    // Alt-click adds a cursor; a plain or Mod-click does not.
    assert.deepEqual(
      await page.evaluate((content) => {
        const view = document.querySelector(content).cmTile.root.view
        const [adds] = view.state.facet(
          view.constructor.clickAddsSelectionRange,
        )
        return [{ altKey: true }, {}, { metaKey: true, ctrlKey: true }].map(
          (event) => !!adds(event),
        )
      }, content),
      [true, false, false],
    )
    // Mod-Alt-Down adds a cursor on the line drawn below.
    await caret(page, content, 0)
    await page.keyboard.press(`${mod}+Alt+ArrowDown`)
    const added = await ranges(page, content)
    assert.equal(added.length, 2)
    assert.ok(added[1][0] > 0)
    assert.deepEqual(errors, [])
  })
