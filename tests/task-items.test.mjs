import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('populated and empty task markers render as checkboxes and preserve CRLF source', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-task-items-'))
  const file = join(profile, 'tasks.md')
  const markdown = '- [ ] a\r\n- [ ]\r\n- [ ]\r\n- bullet\r\n  - [x]\r\n'
  await writeFile(file, markdown)
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
  page.setDefaultTimeout(7000)
  await waitForDocumentEditor(app, page)
  const rich = page.getByRole('textbox', {
    name: 'Document editor',
    exact: true,
  })
  const checkboxes = rich.getByRole('checkbox')
  await checkboxes.nth(3).waitFor()
  assert.equal(await checkboxes.count(), 4)
  assert.equal(await checkboxes.nth(0).isChecked(), false)
  assert.equal(await checkboxes.nth(1).isChecked(), false)
  assert.equal(await checkboxes.nth(2).isChecked(), false)
  assert.equal(await checkboxes.nth(3).isChecked(), true)
  assert.equal(
    await rich.locator(':scope > ul[data-type="taskList"]').count(),
    1,
  )
  assert.equal(
    await rich.locator(':scope > ul[data-type="taskList"] > li').count(),
    3,
  )
  assert.deepEqual(
    await checkboxes.evaluateAll((inputs) =>
      inputs.map((input) => input.closest('li').querySelector('p').textContent),
    ),
    ['a', '', '', ''],
  )
  assert.equal(await rich.locator('li li').getByRole('checkbox').count(), 1)

  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await page
    .getByRole('textbox', { name: 'Markdown editor', exact: true })
    .waitFor()
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    markdown,
  )
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await checkboxes.nth(3).waitFor()
  await clickMenu(app, 'Save')
  assert.equal(await readFile(file, 'utf8'), markdown)

  await waitForAsync(
    page,
    () => document.querySelector('.tiptap')?.editor.isEditable,
  )
  await checkboxes.nth(1).check()
  const edited = markdown.replace('- [ ]\r\n', '- [x]\r\n')
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    edited,
  )
  await clickMenu(app, 'Save')
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  assert.equal(await readFile(file, 'utf8'), edited)

  await waitForAsync(
    page,
    () => document.querySelector('.tiptap')?.editor.isEditable,
  )
  await rich.evaluate((element) => {
    const editor = element.editor
    const paragraph = element.querySelectorAll(
      ':scope > ul[data-type="taskList"] > li > div > p',
    )[2]
    editor.commands.setTextSelection(editor.view.posAtDOM(paragraph, 0))
    editor.view.focus()
  })
  await waitForAsync(page, () => {
    const element = document.querySelector('.tiptap')
    const editor = element.editor
    const paragraph = element.querySelectorAll(
      ':scope > ul[data-type="taskList"] > li > div > p',
    )[2]
    return editor.state.selection.from === editor.view.posAtDOM(paragraph, 0)
  })
  await page.keyboard.press('Tab')
  await rich
    .locator('ul[data-type="taskList"] ul[data-type="taskList"]')
    .waitFor()
  assert.equal(
    await rich.locator(':scope > ul[data-type="taskList"] > li').count(),
    2,
  )
  const indented = edited.replace('- [ ]\r\n- bullet', '  - [ ]\r\n- bullet')
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    indented,
  )
  await clickMenu(app, 'Save')
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  assert.equal(await readFile(file, 'utf8'), indented)
})
