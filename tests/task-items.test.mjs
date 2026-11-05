import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForFormattedEditor } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('typing a task marker creates a checkbox and saves unescaped Markdown', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-task-input-'))
  const file = join(profile, 'tasks.md')
  await writeFile(file, '')
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
  await waitForFormattedEditor(app, page)
  const rich = page.getByRole('textbox', {
    name: 'Document editor',
    exact: true,
  })
  await rich.click()
  await page.keyboard.type('- [ ] task')
  await rich.getByRole('checkbox').waitFor()
  assert.equal(await rich.getByRole('checkbox').isChecked(), false)

  assert.equal(
    await rich.getByRole('checkbox').getAttribute('aria-label'),
    'Task item checkbox for task',
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    '- [ ] task',
  )

  await clickMenu(app, 'Save')
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  assert.equal((await readFile(file, 'utf8')).trim(), '- [ ] task')
})

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
  await waitForFormattedEditor(app, page)
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
  {
    assert.deepEqual(
      await checkboxes.evaluateAll((inputs) =>
        inputs.map((input) => input.getAttribute('aria-label')),
      ),
      [
        'Task item checkbox for a',
        'Task item checkbox for empty task item',
        'Task item checkbox for empty task item',
        'Task item checkbox for empty task item',
      ],
    )
    const positions = await checkboxes.evaluateAll((inputs) =>
      inputs.map((input) => input.getBoundingClientRect().left),
    )
    assert.deepEqual(positions.slice(0, 3), [
      positions[0],
      positions[0],
      positions[0],
    ])
    assert.ok(
      positions[3] > positions[0],
      'the bullet contains its nested task',
    )
  }

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
    () => document.querySelector('.rich-pane .cm-content')?.isContentEditable,
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
    () => document.querySelector('.rich-pane .cm-content')?.isContentEditable,
  )

  await rich.evaluate((element) => {
    const view = element.cmTile.root.view
    view.dispatch({ selection: { anchor: view.state.doc.line(3).to } })
    view.focus()
  })
  await page.keyboard.press('Tab')
  assert.equal(await rich.getByRole('checkbox').count(), 4)

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
