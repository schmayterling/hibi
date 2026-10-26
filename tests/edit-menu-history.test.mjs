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
