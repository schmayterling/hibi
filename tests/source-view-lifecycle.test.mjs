import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { pressShortcut, replaceSourceText } from './keyboard.mjs'

test('source find keeps selected worker ranges through far scrolls, edits and reopening', {
  timeout: 60000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-source-phase-'))
  const file = join(profile, 'note.md')
  await writeFile(file, 'ab'.repeat(10000))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`, file],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await waitForDocumentEditor(app, page)
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  const source = page.getByRole('textbox', {
    name: 'Markdown editor',
    exact: true,
  })
  const input = page.getByRole('textbox', {
    name: 'Find in document',
    exact: true,
  })
  const open = () =>
    pressShortcut(app, process.platform === 'darwin' ? 'Meta+f' : 'Control+f')
  for (const [text, query, from, to, total] of [
    ['ab'.repeat(10000), 'aba', 16444, 16447, 5000],
    ['Σ'.repeat(20000), 'σς', 16444, 16446, 10000],
  ]) {
    await replaceSourceText(page, source, text)
    await source.focus()
    await open()
    await input.fill(query)
    await page.waitForFunction(
      (count) =>
        document.querySelector('.find-count')?.textContent === `1/${count}`,
      total,
    )
    await page.locator('.source-pane .cm-searchMatch-selected').waitFor()
    await page.evaluate(
      ({ from, to }) => {
        const view = document.querySelector('.source-pane .cm-content').cmTile
          .root.view
        view.dispatch({
          selection: { anchor: from, head: to },
          scrollIntoView: true,
        })
      },
      { from, to },
    )
    await page.waitForFunction(
      ({ from, to }) => {
        const content = document.querySelector('.source-pane .cm-content')
        const selection = content.cmTile.root.view.state.selection.main
        return (
          selection.from === from &&
          selection.to === to &&
          content.querySelector('.cm-searchMatch-selected') !== null
        )
      },
      { from, to },
    )
    await input.press('Escape')
    await open()
    await page.locator('.source-pane .cm-searchMatch-selected').waitFor()
    assert.equal(
      (await page.evaluate(() => window.hibi.getDocument())).markdown,
      text,
    )
    await input.press('Escape')
  }
})

test('source view applies saved gutters and active find after asynchronous construction', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-source-lifecycle-'))
  const file = join(profile, 'note.md')
  await writeFile(file, 'alpha\nbeta\nalpha\n')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`, file],
  })
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  await waitForDocumentEditor(app, page)
  await page.evaluate(() => localStorage.setItem('line-numbers', 'true'))
  await page.reload()
  await waitForDocumentEditor(app, page)
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+f' : 'Control+f',
  )
  await page
    .getByRole('textbox', { name: 'Find in document', exact: true })
    .fill('alpha')
  await page.waitForFunction(
    () => document.querySelector('.find-count')?.textContent === '1/2',
  )
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  await page.locator('.cm-lineNumbers').waitFor()
  await page.waitForFunction(
    () => document.querySelectorAll('.cm-searchMatch').length === 2,
  )
  assert.equal(await page.locator('.find-count').textContent(), '1/2')
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'alpha\nbeta\nalpha\n',
  )
})
