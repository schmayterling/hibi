import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { pressShortcut, splitTab } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

for (const formatted of [false, true]) {
  test(`${formatted ? 'codemirror' : 'prosemirror'}: closing find returns focus to its own source pane`, {
    timeout: 60000,
  }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'hibi-find-pane-'))
    const files = [join(root, 'right.md'), join(root, 'left.md')]
    const texts = [
      'right needle\n\nright needle\n',
      'left needle\n\nleft needle\n',
    ]
    for (let i = 0; i < files.length; i++) await writeFile(files[i], texts[i])
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
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    if (formatted) {
      await page.evaluate(() =>
        localStorage.setItem('hibi:formatted-engine', 'codemirror'),
      )
      await page.reload()
      await waitForDocumentEditor(app, page)
    }
    const opened = []
    for (let i = 0; i < files.length; i++) {
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [path],
        })
      }, files[i])
      await pressShortcut(app, `${mod}+o`)
      await waitForAsync(
        page,
        async (text) => (await window.hibi.getDocument()).markdown === text,
        texts[i],
      )
      opened.push(await page.evaluate(() => window.hibi.getDocument()))
      await waitForDocumentEditor(app, page)
    }
    await splitTab(app, page, opened[0].tabId)
    for (const side of ['left', 'right']) {
      const pane = page.locator(`.editor-page[data-side="${side}"]`)
      await pane.locator('.rich-pane .tiptap, .rich-pane .cm-content').focus()
      await page
        .getByRole('button', { name: 'Source view', exact: true })
        .click()
      await pane
        .locator(
          '.editor-panes[data-source-ready="true"] .source-pane .cm-content',
        )
        .waitFor()
    }
    for (const side of ['right', 'left']) {
      const pane = page.locator(`.editor-page[data-side="${side}"]`)
      const source = pane.locator('.source-pane .cm-content')
      await source.focus()
      await pressShortcut(app, `${mod}+f`)
      const input = pane.getByRole('textbox', {
        name: 'Find in document',
        exact: true,
      })
      await input.fill('needle')
      await waitForAsync(
        page,
        (side) =>
          document.querySelector(
            `.editor-page[data-side="${side}"] .find-count`,
          )?.textContent === '1/2',
        side,
      )
      await input.press('Escape')
      await pane.locator('.find-bar').waitFor({ state: 'hidden' })
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      )
      const actual = await page.evaluate(() => ({
        side: document.activeElement
          ?.closest('.editor-page')
          ?.getAttribute('data-side'),
        label: document.activeElement?.getAttribute('aria-label'),
      }))
      assert.deepEqual(actual, { side, label: 'Markdown editor' })
      assert.equal(
        await source.evaluate((element) => document.activeElement === element),
        true,
      )
    }
    for (let i = 0; i < files.length; i++)
      assert.equal(await readFile(files[i], 'utf8'), texts[i])
  })
}
