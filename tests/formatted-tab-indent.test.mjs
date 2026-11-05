import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  electron,
  waitForAsync,
  waitForDocumentEditor,
  waitForFormattedEditor,
} from './electron.mjs'
import { frozenOracle } from './frozen-oracle.mjs'
import { clickMenu } from './keyboard.mjs'

// Whether the removed rich view read the formatted view's Tab result as the
// model its own Tab made, recorded before its removal.
const richRead = frozenOracle('formatted-tab-indent-rich')

test('Tab in code uses its indentation and leaves code when Tab does not indent', {
  timeout: 60000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-tab-indent-'))
  const file = join(profile, 'code.md')
  const source = `\`\`\`\n  x\n${'word '.repeat(51).concat('\n').repeat(1024)}y\n\`\`\``
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
  // The default CodeMirror view opens even the large note in Normal view.
  await waitForDocumentEditor(app, page)

  const editor = page.getByRole('textbox', {
    name: 'Document editor',
    exact: true,
  })
  assert.equal(
    await editor.evaluate((element) => element.matches('.cm-content')),
    true,
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
      const view = element.cmTile.root.view
      view.dispatch({
        selection: { anchor: view.state.doc.toString().lastIndexOf('y') },
        scrollIntoView: true,
      })
      view.focus()
    })
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
  await t.test('code in a first list item indents its own lines', async () => {
    const replace = (text, caret) =>
      editor.evaluate(
        (element, [text, caret]) => {
          const view = element.cmTile.root.view
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: text },
            selection: { anchor: caret },
          })
          view.focus()
        },
        [text, caret],
      )
    // The item cannot nest; its code has no indented line of its own.
    const list = '- item\n\n  ```\n  x\n  y\n  ```'
    await replace(list, list.lastIndexOf('y'))
    await markdown(list)
    await page.keyboard.press('Tab')
    await markdown(list.replace('  y', '  \ty'))
    // Leading tabs under a bullet read as spaces, as in the rich editor.
    for (const code of [
      '- item\n\n  ~~~\n  x\n  \ty\n  ~~~',
      '- item\n\n  ~~~\n\tx\n\ty\n  ~~~',
    ]) {
      await replace(code, code.indexOf('x') + 1)
      await markdown(code)
      await page.keyboard.press('Tab')
      await markdown(code.replace('x', 'x  '))
      await page.keyboard.press('ControlOrMeta+z')
      await markdown(code)
    }
    await replace(source, 0)
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

test('quoted code uses the native indentation unit with exact formatted history', {
  timeout: 120000,
}, async (t) => {
  const cases = [
    [
      'quote bullet',
      '> - item\n>\n>   ```\n>   foo|\n>   \tbar\n>   ```',
      '  ',
    ],
    ['item quote', '- > ```\n  > foo|\n  > \tbar\n  > ```', '\t'],
    ['bare quote', '>~~~\n>foo|\n> \tbar\n>~~~', '\t'],
    ['nested quote', '> > ```js\n> > foo|\n> > \tbar\n> > ```', '\t'],
    ['partial structural tab', '> ```\n>foo|\n>\tbar\n> ```', '  '],
    ['body after indentation', '> ```\n>foo|\n>     \tbar\n> ```', '    '],
    [
      'nested alert',
      '> > [!NOTE]\n> > ```\n> > foo|\n> > \tbar\n> > ```',
      '\t',
    ],
    [
      'ordered alert',
      '> 1. > [!NOTE]\n>    > ```\n>    > foo|\n>    > \tbar\n>    > ```',
      '\t',
    ],
    ['ordered fence', '> 1. ```\n>    foo|\n>    \tbar\n>    ```', '\t'],
    [
      'partial alert',
      '> > > [!NOTE]\n> > > ```\n> > >foo|\n> > >\tbar\n> > > ```',
      '  ',
    ],
  ]
  const folder = await mkdtemp(join(tmpdir(), 'hibi-quote-code-indent-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await waitForFormattedEditor(app, page)
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setFocusEmulationEnabled', {
    enabled: true,
  })
  t.after(() => session.detach().catch(() => {}))
  const snapshot = () =>
    page.evaluate(async () => {
      await window.hibi.flushDocumentChanges()
      return { source: (await window.hibi.getDocument()).markdown }
    })
  for (const [name, doc, unit] of cases)
    await t.test(name, async () => {
      const source = doc.replace('|', '')
      const from = doc.indexOf('|')
      const file = join(folder, `${name}.md`)
      await writeFile(file, source)
      await app.evaluate(({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [file],
        })
      }, file)
      await clickMenu(app, 'Open…')
      await waitForAsync(
        page,
        async (name) => (await window.hibi.getDocument()).name === name,
        `${name}.md`,
      )
      const editor = page.getByRole('textbox', {
        name: 'Document editor',
        exact: true,
      })
      await editor.waitFor()
      await page.waitForFunction((source) => {
        const element = document.querySelector('[aria-label="Document editor"]')
        const view = element?.cmTile?.root?.view
        return (
          view && !view.state.readOnly && view.state.doc.toString() === source
        )
      }, source)
      await editor.evaluate((element, from) => {
        element.cmTile.root.view.dispatch({ selection: { anchor: from } })
        element.focus()
      }, from)
      const before = await snapshot()
      assert.equal(before.source, source)

      await page.keyboard.press('Tab')
      const typed = await snapshot()
      assert.notEqual(typed.source, source, 'Tab must perform a native edit')

      assert.equal(
        typed.source,
        source.slice(0, from) + unit + source.slice(from),
      )
      assert.equal(richRead({ name, source: typed.source }), true)
      await page.keyboard.press('ControlOrMeta+z')
      await waitForAsync(
        page,
        async (source) => (await window.hibi.getDocument()).markdown === source,
        source,
      )
      assert.deepEqual(await snapshot(), before)
      await page.keyboard.press(
        process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y',
      )
      await waitForAsync(
        page,
        async (source) => (await window.hibi.getDocument()).markdown === source,
        typed.source,
      )
      assert.deepEqual(await snapshot(), typed)
    })
})
