import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  launchBenchmarkApp,
  waitForEditor,
} from '../scripts/benchmark-flows.mjs'
import { electron } from './electron.mjs'
import { waitForAsync } from './poll.mjs'

test('typing coalesces formatting checks without delaying document changes or undo', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-input-'))
  const app = await launchBenchmarkApp(profile)
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await waitForEditor(page)
  const result = await page.evaluate(async () => {
    const editor = document.querySelector('.tiptap').editor
    await new Promise(requestAnimationFrame)
    const visibleActions = document.querySelectorAll(
      '.editor-toolbar [data-toolbar-id^="format."]',
    ).length
    let checks = 0
    const can = editor.can.bind(editor)
    editor.can = (...args) => {
      checks++
      return can(...args)
    }
    for (const letter of 'hello') editor.commands.insertContent(letter)
    const immediate = { checks, text: editor.getText() }
    await new Promise(requestAnimationFrame)
    const afterFrame = checks
    const persisted = (await window.hibi.getDocument()).markdown
    editor.commands.undo()
    const undone = editor.getText()
    editor.commands.redo()
    return {
      immediate,
      afterFrame,
      visibleActions,
      persisted,
      undone,
      redone: editor.getText(),
    }
  })
  assert.deepEqual(result.immediate, { checks: 0, text: 'hello' })
  assert.ok(result.visibleActions > 0)
  assert.equal(result.afterFrame, result.visibleActions)
  assert.equal(result.persisted, 'hello')
  assert.equal(result.undone, '')
  assert.equal(result.redone, 'hello')
})

test('long documents with HTML and reference syntax stay visually editable through save and undo', {
  timeout: 60000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-unrestricted-rich-'))
  const file = join(profile, 'long.md')
  const original = [
    '# Editable document',
    '<div>HTML content</div>',
    '[reference][target]\n\n[target]: https://example.com',
    ...Array(200).fill('alpha beta '.repeat(500)),
  ].join('\n\n')
  assert.ok(original.length > 1000000)
  await writeFile(file, original)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`, file],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  const editable = () =>
    page.waitForFunction(
      () => document.querySelector('.tiptap')?.isContentEditable,
    )
  await editable()
  const opened = (await page.evaluate(() => window.hibi.getDocument())).markdown
  assert.match(opened, /^# Editable document/)
  assert.match(opened, /HTML content/)
  assert.match(opened, /reference/)
  assert.ok(opened.length > 1000000)
  await page.locator('.tiptap').evaluate((element) => {
    element.editor.commands.setTextSelection(1)
    element.editor.view.focus()
  })
  await page.keyboard.insertText('edited ')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.startsWith('# edited '),
  )
  const edited = (await page.evaluate(() => window.hibi.getDocument())).markdown
  assert.ok(edited.includes('alpha beta'))
  await page.locator('.tiptap').evaluate((element) => {
    element.editor.commands.undo()
  })
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    opened,
  )
  await editable()
  await page.locator('.tiptap').evaluate((element) => {
    element.editor.commands.redo()
  })
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    edited,
  )
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await page
    .getByRole('textbox', { name: 'Markdown editor', exact: true })
    .waitFor()
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await editable()
  await page.evaluate(() => window.hibi.saveDocument(false))
  assert.equal(await readFile(file, 'utf8'), edited)
  await page.reload()
  await editable()
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    edited,
  )
})
