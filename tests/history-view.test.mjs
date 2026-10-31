import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForAsync, waitForFormattedEditor } from './electron.mjs'
import {
  clickMenu,
  pressShortcut,
  redoKey,
  replaceRichText,
} from './keyboard.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const texts = {
  original: 'the original text of this note',
  first: 'first version of the draft, written in full.',
  second: 'second version, which undo will replace later.',
  third: 'third version, typed after undoing the second.',
}

test('the history view restores a point as a step undo takes back, and goes to an undone branch', {
  timeout: 60000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-history-view-'))
  const file = join(profile, 'note.md')
  await writeFile(file, texts.original)
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
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
  const page = await app.firstWindow()
  page.setDefaultTimeout(8000)
  await waitForFormattedEditor(app, page)
  const editor = page.getByRole('textbox', { name: /document editor/i })
  const shows = (text) =>
    waitForAsync(
      page,
      async (text) => (await window.hibi.getDocument()).markdown === text,
      text,
    )
  await pressShortcut(app, `${mod}+o`)
  await shows(texts.original)
  await page.waitForFunction(
    (text) =>
      document.querySelector('[aria-label="Document editor"]')?.textContent ===
      text,
    texts.original,
  )
  for (const text of [texts.first, texts.second]) {
    await replaceRichText(page, editor, text)
    await shows(text)
  }
  await editor.focus()
  await pressShortcut(app, `${mod}+z`)
  await shows(texts.first)
  await replaceRichText(page, editor, texts.third)
  await shows(texts.third)
  const openHistory = async () => {
    await clickMenu(app, 'Command palette')
    await page
      .getByRole('combobox', { name: /search commands/i })
      .fill('history')
    await page
      .getByRole('option')
      .filter({ hasText: /^history/i })
      .first()
      .click()
    const dialog = page.getByRole('dialog', { name: /^history$/i })
    await dialog.waitFor()
    return dialog
  }

  // Points: the text undo replaced is one, and restoring it is a new step.
  let history = await openHistory()
  const points = history.getByRole('listbox', { name: /points to return to/i })
  await points.focus()
  await page.keyboard.press('End')
  assert.equal(
    await points.getAttribute('aria-activedescendant'),
    await points.getByRole('option').last().getAttribute('id'),
  )
  await points
    .getByRole('option')
    .filter({ hasText: /before undo/i })
    .click()
  await page.waitForFunction(
    (text) =>
      document.querySelector(
        '[aria-label="changes from the current text" i] ins',
      )?.textContent === text,
    texts.second,
  )
  await history.getByRole('button', { name: /^restore$/i }).click()
  await history.waitFor({ state: 'hidden' })
  await shows(texts.second)
  await editor.focus()
  await pressShortcut(app, `${mod}+z`)
  await shows(texts.third)
  await page.keyboard.press(redoKey)
  await shows(texts.second)

  // All steps: the undone branch sits a level in, and going to it lets undo
  // and redo go on from there.
  history = await openHistory()
  await history.getByRole('button', { name: /^all steps$/i }).click()
  const tree = history.getByRole('tree', { name: /all undo steps/i })
  const items = tree.getByRole('treeitem')
  assert.equal(await items.count(), 5)
  assert.deepEqual(
    await items.evaluateAll((items) =>
      items.map((item) => [
        item.getAttribute('aria-level'),
        item.getAttribute('aria-current'),
      ]),
    ),
    [
      ['1', null],
      ['2', null],
      ['3', null],
      ['2', null],
      ['2', 'true'],
    ],
  )
  await items.nth(2).click()
  await history.getByRole('button', { name: /^go to step$/i }).click()
  await history.waitFor({ state: 'hidden' })
  await shows(texts.second)
  await editor.focus()
  await pressShortcut(app, `${mod}+z`)
  await shows(texts.first)
  await page.keyboard.press(redoKey)
  await shows(texts.second)
})
