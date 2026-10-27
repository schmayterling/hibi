import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForAsync, waitForDocumentEditor } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

for (const engine of ['tiptap', 'codemirror'])
  test(`${engine}: Tab in code uses its indentation and leaves code when Tab does not indent`, {
    timeout: 60000,
  }, async (t) => {
    const profile = await mkdtemp(join(tmpdir(), 'hibi-tab-indent-'))
    const file = join(profile, 'code.md')
    const source =
      engine === 'codemirror'
        ? `\`\`\`\n  x\n${'word '.repeat(51).concat('\n').repeat(1024)}y\n\`\`\``
        : '```\n  x\ny\n```'
    await writeFile(file, source)
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
    await waitForDocumentEditor(app, page, {
      name: engine === 'codemirror' ? 'Markdown editor' : 'Document editor',
    })
    if (engine === 'codemirror') {
      await page.evaluate(() =>
        localStorage.setItem('hibi:formatted-engine', 'codemirror'),
      )
      await page.reload()
      await waitForDocumentEditor(app, page)
    }
    const editor = page.getByRole('textbox', {
      name: 'Document editor',
      exact: true,
    })
    assert.equal(
      await editor.evaluate((element) => element.matches('.cm-content')),
      engine === 'codemirror',
    )
    // Hidden windows have no focus; keys need a focused editor.
    const session = await page.context().newCDPSession(page)
    await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    const markdown = (text) =>
      waitForAsync(
        page,
        async (text) => (await window.hibi.getDocument()).markdown === text,
        text,
      )
    // The caret before the code's `y`, at the start of its line.
    const place = async () => {
      await editor.evaluate((element) => {
        if (element.matches('.cm-content')) {
          const view = element.cmTile.root.view
          view.dispatch({
            selection: { anchor: view.state.doc.toString().lastIndexOf('y') },
            scrollIntoView: true,
          })
          view.focus()
          return
        }
        const { editor } = element
        let at = 0
        editor.state.doc.descendants((node, position) => {
          if (node.type.name === 'codeBlock')
            at = position + 1 + node.textContent.lastIndexOf('y')
        })
        editor.commands.setTextSelection(at)
        editor.view.focus()
      })
      if (engine === 'codemirror')
        await waitForAsync(page, () =>
          [...document.querySelectorAll('.cm-line.hibi-lp-codeblock')].some(
            (line) => line.textContent.trim() === 'y',
          ),
        )
    }
    await t.test('code indents with its own unit', async () => {
      await place()
      await page.keyboard.press('Tab')
      await markdown(source.replace('\ny\n', '\n  y\n'))
      await page.keyboard.press('Tab')
      await markdown(source.replace('\ny\n', '\n    y\n'))
      // Shift-Tab takes off one unit of the code's indentation.
      await page.keyboard.press('Shift+Tab')
      await markdown(source.replace('\ny\n', '\n  y\n'))
      await page.keyboard.press('Shift+Tab')
      await markdown(source)
    })
    await t.test('without Tab indenting, Tab leaves code', async () => {
      await clickMenu(app, 'Settings')
      await page.getByRole('tab', { name: 'Editor', exact: true }).click()
      await page
        .getByRole('checkbox', { name: 'Tab key indents', exact: true })
        .setChecked(false)
      await page.getByRole('button', { name: /back to app/i }).click()
      await editor.waitFor()
      const before = (await page.evaluate(() => window.hibi.getDocument()))
        .markdown
      await place()
      await page.keyboard.press('Tab')
      await waitForAsync(page, () => {
        const editor = document.querySelector('[aria-label="Document editor"]')
        return !editor?.contains(document.activeElement)
      })
      assert.equal(
        (await page.evaluate(() => window.hibi.getDocument())).markdown,
        before,
      )
    })
  })
