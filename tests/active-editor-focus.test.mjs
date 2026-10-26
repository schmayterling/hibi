import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

for (const engine of ['tiptap', 'codemirror']) {
  for (const mode of ['normal', 'markdown']) {
    test(`${engine}: app actions restore the visible ${mode} editor`, {
      timeout: 60000,
    }, async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'hibi-active-editor-focus-'))
      const file = join(root, 'note.md')
      const text = 'alpha beta'
      await writeFile(file, text)
      const app = await electron.launch({
        args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`, file],
      })
      t.after(async () => {
        await app.evaluate(({ dialog }) => {
          dialog.showMessageBox = async () => ({ response: 1 })
        })
        await app.close()
        await rm(root, { recursive: true, force: true })
      })
      const page = await app.firstWindow()
      page.setDefaultTimeout(7000)
      await waitForDocumentEditor(app, page)
      await page.evaluate(
        ({ engine, mode }) => {
          localStorage.setItem('hibi:formatted-engine', engine)
          localStorage.setItem('default-view', mode)
        },
        { engine, mode },
      )
      await page.reload()
      await waitForDocumentEditor(app, page, {
        name: mode === 'markdown' ? 'Markdown editor' : 'Document editor',
      })
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
      const selector =
        mode === 'markdown'
          ? '.source-pane .cm-content'
          : engine === 'codemirror'
            ? '.rich-pane .cm-content'
            : '.rich-pane .tiptap'
      await page.locator(selector).focus()
      if (mode === 'markdown') {
        await page.locator(selector).evaluate((element) => {
          const view = element.cmTile.root.view
          view.dispatch({ selection: { anchor: 2, head: 4 } })
        })
      }
      const focused = () =>
        waitForAsync(
          page,
          (selector) =>
            document.activeElement === document.querySelector(selector),
          selector,
        )
      await clickMenu(app, 'Settings')
      await page.getByRole('button', { name: /^back to app$/i }).click()
      await focused()
      if (mode === 'markdown')
        assert.equal(await page.evaluate(() => getSelection().toString()), 'ph')
      const choose = async (label) => {
        await clickMenu(app, 'Command palette')
        await page
          .getByRole('combobox', { name: /search commands/i })
          .fill(label)
        await page.getByRole('option').first().click()
        await page
          .getByRole('combobox', { name: /search commands/i })
          .waitFor({ state: 'hidden' })
      }
      await choose('Enter zen mode')
      await waitForAsync(
        page,
        () => document.querySelector('.app').dataset.zen === 'true',
      )
      await focused()
      await page
        .getByRole('button', { name: 'Exit zen mode', exact: true })
        .click()
      await focused()
      await clickMenu(app, 'Command palette')
      await page.keyboard.press('Escape')
      await focused()
      await page.keyboard.insertText('x')
      await waitForAsync(
        page,
        async (original) =>
          (await window.hibi.getDocument()).markdown !== original,
        text,
      )
      await page.keyboard.press('ControlOrMeta+z')
      await waitForAsync(
        page,
        async (original) =>
          (await window.hibi.getDocument()).markdown === original,
        text,
      )
    })
  }
}
