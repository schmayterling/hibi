import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { selectFormattedEngine } from './formatted-engine.mjs'
import { pressShortcut, replaceRichText } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

for (const engine of ['tiptap', 'codemirror']) {
  test(`${engine}: native replacement, selection and history survive source switching`, {
    timeout: 45000,
  }, async (t) => {
    const profile = await mkdtemp(join(tmpdir(), 'hibi-engine-input-'))
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
    const rich = await selectFormattedEngine(app, page, engine)
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    const saved = async (text) => {
      try {
        await waitForAsync(
          page,
          async (text) => (await window.hibi.getDocument()).markdown === text,
          text,
        )
      } catch (error) {
        t.diagnostic(
          JSON.stringify(
            await page.evaluate(
              async (expected) => ({
                expected,
                actual: (await window.hibi.getDocument()).markdown,
                focused: document.activeElement?.getAttribute('aria-label'),
              }),
              text,
            ),
          ),
        )
        throw error
      }
    }
    const settleSelection = () =>
      page.evaluate(async () => {
        await new Promise(requestAnimationFrame)
        await new Promise(requestAnimationFrame)
      })
    await rich.focus()
    await settleSelection()
    await replaceRichText(page, rich, 'before chosen after 😀')
    await saved('before chosen after 😀')
    await settleSelection()
    await rich.press('Home')
    for (let i = 0; i < 7; i++) await page.keyboard.press('ArrowRight')
    for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowRight')
    assert.equal(await page.evaluate(() => getSelection().toString()), 'chosen')
    await page.keyboard.insertText('日本語')
    await saved('before 日本語 after 😀')
    await pressShortcut(app, `${mod}+z`)
    await saved('before chosen after 😀')
    await pressShortcut(
      app,
      process.platform === 'win32' ? 'Control+y' : `${mod}+Shift+z`,
    )
    await saved('before 日本語 after 😀')
    await page.getByRole('button', { name: 'Source view', exact: true }).click()
    await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
    const source = page.getByRole('textbox', {
      name: 'Markdown editor',
      exact: true,
    })
    assert.equal(
      (await source.locator('.cm-line').allTextContents()).join('\n'),
      'before 日本語 after 😀',
    )
    await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
    await waitForDocumentEditor(app, page)
    await saved('before 日本語 after 😀')
    await replaceRichText(page, rich, '')
    await saved('')
    await pressShortcut(app, `${mod}+z`)
    await saved('before 日本語 after 😀')
    await cdp.detach()
  })
}
