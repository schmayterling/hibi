import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForAsync, waitForDocumentEditor } from './electron.mjs'
import { clickMenu, replaceRichText } from './keyboard.mjs'

test('edit menu undo then redo restores text in the rich view, the source view and a plain field', {
  timeout: 90000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-edit-history-'))
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
  const rich = page.getByRole('textbox', { name: /document editor/i })
  await rich.waitFor()
  await page.getByRole('button', { name: /dismiss this screen/i }).click()
  await waitForDocumentEditor(app, page)

  // Test windows are hidden, so pass the window the native menu would: role
  // items run the browser's own command, other items their click.
  const menu = (label) =>
    app.evaluate(({ BrowserWindow, Menu }, label) => {
      const [window] = BrowserWindow.getAllWindows()
      const item = Menu.getApplicationMenu()
        .items.find((item) => item.label === 'Edit')
        .submenu.items.find((item) => item.label === label)
      if (item.role) window.webContents[item.role]()
      else item.click(undefined, window, window.webContents)
    }, label)
  /** Undo the last edit from the menu, then redo it until the text is back. */
  async function undoRedo(field = false) {
    // The note's markdown, or the focused field's value.
    const edited = await page.evaluate(
      async (field) =>
        field
          ? document.activeElement.value
          : (await window.hibi.getDocument()).markdown,
      field,
    )
    await menu('Undo')
    await waitForAsync(
      page,
      async ([field, edited]) =>
        (field
          ? document.activeElement.value
          : (await window.hibi.getDocument()).markdown) !== edited,
      [field, edited],
    )
    await menu('Redo')
    await waitForAsync(
      page,
      async ([field, edited]) =>
        (field
          ? document.activeElement.value
          : (await window.hibi.getDocument()).markdown) === edited,
      [field, edited],
    )
  }

  await replaceRichText(page, rich, 'rich text')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('rich text'),
  )
  await undoRedo()

  await page
    .getByRole('button', { name: /^source view$/i, exact: true })
    .click()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  await page.getByRole('textbox', { name: /markdown editor/i }).focus()
  await page.keyboard.insertText(' and source')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('and source'),
  )
  await undoRedo()

  // Plain fields keep the browser's own undo and redo.
  await clickMenu(app, 'Command palette')
  await page.keyboard.insertText('settings')
  await undoRedo(true)
})

/** A fresh app with an empty note in the rich view. */
async function launch(t) {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-edit-history-'))
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
  const rich = page.getByRole('textbox', { name: /document editor/i })
  await rich.waitFor()
  await page.getByRole('button', { name: /dismiss this screen/i }).click()
  await waitForDocumentEditor(app, page)
  const menu = (label) =>
    app.evaluate(({ BrowserWindow, Menu }, label) => {
      const [window] = BrowserWindow.getAllWindows()
      const item = Menu.getApplicationMenu()
        .items.find((item) => item.label === 'Edit')
        .submenu.items.find((item) => item.label === label)
      if (item.role) window.webContents[item.role]()
      else item.click(undefined, window, window.webContents)
    }, label)
  const markdown = () =>
    page.evaluate(async () => (await window.hibi.getDocument()).markdown)
  // Let menu history reach the page and land.
  const settle = () =>
    page.evaluate(async () => {
      for (let frame = 0; frame < 4; frame++)
        await new Promise((resolve) => requestAnimationFrame(resolve))
    })
  /** Type in the rich view and undo it from the menu; returns the text after the undo. */
  async function typeAndUndo() {
    await replaceRichText(page, rich, 'rich text')
    await waitForAsync(page, async () =>
      (await window.hibi.getDocument()).markdown.includes('rich text'),
    )
    const edited = await markdown()
    await menu('Undo')
    await waitForAsync(
      page,
      async (edited) => (await window.hibi.getDocument()).markdown !== edited,
      edited,
    )
    return markdown()
  }
  return { app, page, rich, menu, markdown, settle, typeAndUndo }
}

test("the edit menu keeps electron's own items beside undo and redo", {
  timeout: 60000,
}, async (t) => {
  const { app } = await launch(t)
  const [items, native] = await app.evaluate(({ Menu }) => {
    const shape = (items) =>
      items
        .filter(({ label }) => label !== 'Undo' && label !== 'Redo')
        .map(({ label, role, type, submenu }) => ({
          label,
          role,
          type,
          submenu: submenu && shape(submenu.items),
        }))
    return [
      Menu.getApplicationMenu().items.find(({ label }) => label === 'Edit')
        .submenu.items,
      Menu.buildFromTemplate([{ role: 'editMenu' }]).items[0].submenu.items,
    ].map(shape)
  })
  assert.deepEqual(items, native)
})

test('edit menu redo leaves a read-only editor alone, as its shortcut does', {
  timeout: 60000,
}, async (t) => {
  const { rich, menu, markdown, settle, typeAndUndo } = await launch(t)
  const undone = await typeAndUndo()
  await rich.evaluate((element) => {
    element.editor.view.focus()
    element.editor.setEditable(false)
  })
  await menu('Redo')
  await settle()
  assert.equal(await markdown(), undone)
})

test('edit menu redo in docked devtools leaves the note alone', {
  timeout: 60000,
}, async (t) => {
  const { app, menu, markdown, settle, typeAndUndo } = await launch(t)
  const undone = await typeAndUndo()
  await app.evaluate(async ({ BrowserWindow }) => {
    const [window] = BrowserWindow.getAllWindows()
    await new Promise((resolve) => {
      window.webContents.once('devtools-opened', resolve)
      window.webContents.openDevTools({ mode: 'right', activate: false })
    })
    await window.webContents.devToolsWebContents.executeJavaScript(
      "const field = document.createElement('input'); document.body.append(field); field.focus(); void 0",
    )
    // Opening devtools without activation does not guarantee native focus.
    // Control routing while calling the real devtools history method.
    const tools = window.webContents.devToolsWebContents
    globalThis.devtoolsRedoCalls = 0
    const redo = tools.redo.bind(tools)
    tools.redo = () => {
      globalThis.devtoolsRedoCalls++
      redo()
    }
    window.webContents.isDevToolsFocused = () => true
  })
  await menu('Redo')
  assert.equal(await app.evaluate(() => globalThis.devtoolsRedoCalls), 1)
  await settle()
  assert.equal(await markdown(), undone)
})
