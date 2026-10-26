import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

for (const action of ['backspace', 'cut', 'cut shortcut', 'type in empty']) {
  test(`formatted view keeps focus through ${action} and undo`, {
    timeout: 60000,
  }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'hibi-empty-focus-'))
    const text =
      action === 'type in empty' ? '' : '# Note\n\n**a🌿b** & literal\n'
    const file = join(root, 'note.md')
    await writeFile(file, text)
    const app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
    })
    t.after(async () => {
      await app.close()
      await rm(root, { recursive: true, force: true })
    })
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    const page = await app.firstWindow()
    await waitForDocumentEditor(app, page)
    await page.evaluate(() =>
      localStorage.setItem('hibi:formatted-engine', 'codemirror'),
    )
    await page.reload()
    await waitForDocumentEditor(app, page)
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      })
    }, file)
    await pressShortcut(app, `${mod}+o`)
    await waitForAsync(
      page,
      async (expected) =>
        (await window.hibi.getDocument()).markdown === expected,
      text,
    )
    await page
      .locator('.editor-panes[data-source-ready="true"] .rich-pane .cm-content')
      .waitFor()
    await page.evaluate(() => {
      const content = document.querySelector('.rich-pane .cm-content')
      const view = content.cmTile.root.view
      view.focus()
      view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } })
      window.emptyFocusView = view
    })
    if (action === 'cut')
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.cut(),
      )
    else if (action === 'cut shortcut') await page.keyboard.press(`${mod}+x`)
    else if (action === 'type in empty') await page.keyboard.insertText('x')
    else await pressShortcut(app, 'Backspace')
    const expected = action === 'type in empty' ? 'x' : ''
    await waitForAsync(
      page,
      async (expected) =>
        (await window.hibi.getDocument()).markdown === expected,
      expected,
    )
    const settled = async () => {
      await page
        .locator(
          '.editor-panes[data-source-ready="true"] .rich-pane .cm-content',
        )
        .waitFor()
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      )
      return page.evaluate(() => {
        const content = document.querySelector('.rich-pane .cm-content')
        const view = content.cmTile.root.view
        return {
          focused: document.activeElement === content,
          same: window.emptyFocusView === view,
          connected: view.dom.isConnected,
        }
      })
    }
    assert.deepEqual(await settled(), {
      focused: true,
      same: true,
      connected: true,
    })
    // Undo must work without explicitly focusing the editor again.
    await pressShortcut(app, `${mod}+z`)
    await waitForAsync(
      page,
      async (expected) =>
        (await window.hibi.getDocument()).markdown === expected,
      text,
    )
    assert.deepEqual(await settled(), {
      focused: true,
      same: true,
      connected: true,
    })
  })
}
