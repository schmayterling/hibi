import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('Markdown source loading and schema recreation leave the hidden rich document empty', {
  timeout: 40000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-source-markdown-'))
  const first = join(profile, 'first.md'),
    second = join(profile, 'second.md')
  const original =
    '# source heading\r\n\r\n' + 'ordinary words '.repeat(2000) + 'ending'
  const other = '# second heading\n\nuntouched content'
  await writeFile(first, original)
  await writeFile(second, other)
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'word-count': true }),
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
  page.setDefaultTimeout(7000)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  const rich = page.getByRole('textbox', {
    name: 'Document editor',
    exact: true,
  })
  const source = page.getByRole('textbox', {
    name: 'Markdown editor',
    exact: true,
  })
  await rich.waitFor()
  await page.evaluate(() => localStorage.setItem('default-view', 'markdown'))
  await page.reload()
  await source.waitFor()
  const emptyRich = async () => {
    await page.waitForFunction(() => {
      const editor = document.querySelector('.tiptap')?.editor
      return editor && !editor.isEditable && editor.state.doc.textContent === ''
    })
  }
  const expectSource = (text) =>
    waitForAsync(
      page,
      async (text) => (await window.hibi.getDocument()).markdown === text,
      text,
    )
  const open = async (file, text) => {
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      })
    }, file)
    await clickMenu(app, 'Open…')
    await expectSource(text)
  }
  const readyAfterSave = () =>
    page.waitForFunction(
      () =>
        document.querySelector('.app')?.getAttribute('aria-busy') === 'false',
    )
  await emptyRich()
  await open(first, original)
  await emptyRich()
  await page.waitForFunction(() => {
    const content = document.querySelector('.cm-content')
    return (
      content?.isContentEditable &&
      content.textContent.includes('# source heading')
    )
  })
  await source.focus()
  await source.press(
    process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End',
  )
  await page.keyboard.insertText('s')
  await expectSource(`${original}s`)
  await emptyRich()
  await clickMenu(app, 'Save')
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  await readyAfterSave()
  assert.equal(await readFile(first, 'utf8'), `${original}s`)
  await page.waitForFunction(
    () => document.querySelector('.cm-content')?.isContentEditable,
  )
  await source.focus()
  await pressShortcut(app, `${mod}+z`)
  await expectSource(original)
  await pressShortcut(app, `${mod}+Shift+z`)
  await expectSource(`${original}s`)
  await emptyRich()
  await pressShortcut(app, `${mod}+Shift+[`)
  await page.waitForFunction(() => {
    const editor = document.querySelector('.tiptap')?.editor
    return (
      editor?.isEditable &&
      editor.state.doc.lastChild?.textContent.endsWith('endings')
    )
  })
  await expectSource(`${original}s`)

  // A normal-created instance must not lend its source stamp to a later empty
  // instance when only projection registration changes and no edit intervenes.
  await open(second, other)
  await page.waitForFunction(
    () =>
      document.querySelector('.tiptap')?.editor?.state.doc.lastChild
        ?.textContent === 'untouched content',
  )
  const beforeRecreation = await page.evaluate(() => window.hibi.getDocument())
  await pressShortcut(app, `${mod}+Shift+]`)
  await source.waitFor()
  await page.evaluate(() => {
    window.previousRichEditor = document.querySelector('.tiptap').editor
  })
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  assert.equal(await page.locator('#addon-frontmatter').isChecked(), true)
  await page.locator('#addon-frontmatter').click()
  await page.waitForFunction(() => {
    const editor = document.querySelector('.tiptap')?.editor
    return (
      !document.querySelector('#addon-frontmatter')?.checked &&
      editor &&
      editor !== window.previousRichEditor &&
      editor.state.doc.textContent === ''
    )
  })
  await emptyRich()
  const recreated = await page.evaluate(() => window.hibi.getDocument())
  assert.equal(recreated.markdown, other)
  assert.equal(recreated.contentVersion, beforeRecreation.contentVersion)
  await page.getByRole('button', { name: 'Back to app', exact: true }).click()
  await page
    .getByRole('button', { name: /^side-by-side$/i, exact: true })
    .click()
  await page.waitForFunction(() => {
    const editor = document.querySelector('.tiptap')?.editor
    return (
      editor?.isEditable === false &&
      editor.state.doc.lastChild?.textContent === 'untouched content'
    )
  })
  await expectSource(other)
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).contentVersion,
    beforeRecreation.contentVersion,
  )
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await page.waitForFunction(
    () => document.querySelector('.tiptap')?.editor?.isEditable,
  )
  await rich.evaluate((element) => {
    const editor = element.editor
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    editor.view.focus()
  })
  await page.keyboard.insertText('x')
  await expectSource(`${other}x`)
  await clickMenu(app, 'Save')
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  await readyAfterSave()
  assert.equal(await readFile(second, 'utf8'), `${other}x`)
  await page.waitForFunction(
    () => document.querySelector('.tiptap')?.editor?.isEditable,
  )
  await rich.focus()
  await pressShortcut(app, `${mod}+z`)
  await expectSource(other)
  await page
    .getByRole('button', { name: /^side-by-side$/i, exact: true })
    .click()
  await page.waitForFunction(() => {
    const editor = document.querySelector('.tiptap')?.editor
    return (
      editor?.isEditable === false &&
      editor.state.doc.lastChild?.textContent === 'untouched content'
    )
  })
})
