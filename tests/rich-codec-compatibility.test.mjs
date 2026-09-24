import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('rich codec attachments invalidate plain certificates and source outline assumptions', {
  timeout: 40000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-rich-codec-'))
  const folder = join(profile, 'installed-addons', 'codec-fixture')
  const file = join(profile, 'paragraph.md')
  const initial = '# title\n\nsteady words\n\nmiddle words\n\nhello'
  await mkdir(folder, { recursive: true })
  await writeFile(file, initial)
  await writeFile(
    join(folder, 'hibi-addon.json'),
    JSON.stringify({
      id: 'codec-fixture',
      name: 'Codec fixture',
      description: 'Mutable renderer codec fixture',
      kind: 'extension',
      apiVersion: 2,
      version: '1.0.0',
      authors: [{ displayName: 'Test' }],
      capabilities: ['rich'],
      entry: 'index.js',
    }),
  )
  await writeFile(
    join(folder, 'index.js'),
    `export default () => ({ start(context) {
      context.editor.registerRich({ id: 'codec', attach(editor) {
        const manager = editor.markdown;
        const remove = context.patches.instead(
          Object.getPrototypeOf(manager), 'renderNodeToMarkdown',
          (args, next, receiver) => {
            const result = next(...args);
            return receiver === manager && args[0]?.type === 'paragraph' &&
              result.length >= 6 && /^[A-Za-z ]+$/.test(result)
              ? '&#' + result.charCodeAt(0) + ';' + result.slice(1)
              : result;
          });
        window.paragraphCodecEditor = editor;
        return () => {
          remove();
          if (window.paragraphCodecEditor === editor)
            window.paragraphCodecEditor = null;
        };
      }});
    }});`,
  )
  await writeFile(
    join(folder, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['hibi-addon.json', 'index.js'],
      source: 'local',
    }),
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'codec-fixture': false, 'word-count': true }),
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
  await page
    .getByRole('textbox', { name: 'Document editor', exact: true })
    .waitFor()
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
  await clickMenu(app, 'Open…')
  await page.waitForFunction(() => {
    const editor = document.querySelector('.tiptap')?.editor
    return (
      editor?.isEditable && editor.state.doc.lastChild?.textContent === 'hello'
    )
  })
  await page.locator('[data-status-id="word-count.total"]').waitFor()

  // The audited word-count attachment must retain the native direct-edit path.
  await page.evaluate(() => {
    const editor = document.querySelector('.tiptap').editor
    const manager = editor.markdown
    const original = manager.renderNodeToMarkdown
    const descriptor = Object.getOwnPropertyDescriptor(
      manager,
      'renderNodeToMarkdown',
    )
    window.codecProbe = { paragraphs: 0, text: 0 }
    manager.renderNodeToMarkdown = function (node, ...args) {
      if (node.type === 'paragraph') window.codecProbe.paragraphs++
      if (node.type === 'text') window.codecProbe.text++
      return original.call(this, node, ...args)
    }
    window.stopCodecProbe = () => {
      if (descriptor)
        Object.defineProperty(manager, 'renderNodeToMarkdown', descriptor)
      else delete manager.renderNodeToMarkdown
    }
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    editor.view.focus()
  })
  await page.keyboard.insertText('s')
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    `${initial}s`,
  )
  const probe = await page.evaluate(() => {
    window.stopCodecProbe()
    return window.codecProbe
  })
  assert.equal(probe.paragraphs, 0)
  assert.ok(probe.text > 0)
  await pressShortcut(app, `${mod}+z`)
  await waitForAsync(
    page,
    async (initial) => (await window.hibi.getDocument()).markdown === initial,
    initial,
  )

  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  assert.equal(await page.locator('#addon-codec-fixture').isChecked(), false)
  await page.locator('#addon-codec-fixture').click()
  await page.waitForFunction(() => {
    const editor = document.querySelector('.tiptap')?.editor
    return (
      document.querySelector('#addon-codec-fixture')?.checked &&
      editor &&
      window.paragraphCodecEditor === editor
    )
  })
  await page.getByRole('button', { name: 'Back to app', exact: true }).click()
  await page.evaluate(() => {
    const editor = document.querySelector('.tiptap').editor
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    editor.view.focus()
  })
  await page.keyboard.insertText('s')
  // Every paragraph must use the new codec, including unchanged earlier blocks.
  const encoded =
    '# title\n\n&#115;teady words\n\n&#109;iddle words\n\n&#104;ellos'
  await waitForAsync(
    page,
    async (encoded) => (await window.hibi.getDocument()).markdown === encoded,
    encoded,
  )
  assert.equal(
    await page.evaluate(() => {
      const editor = document.querySelector('.tiptap').editor
      return editor.markdown.serialize(editor.state.doc.toJSON())
    }),
    encoded,
  )
  await clickMenu(app, 'Save')
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  assert.equal(await readFile(file, 'utf8'), encoded)
  // Native save completion precedes the renderer's busy/command cleanup.
  await page.waitForFunction(
    () =>
      document.querySelector('.app')?.getAttribute('aria-busy') === 'false' &&
      document.querySelector('.tiptap')?.editor?.isEditable,
  )
  await page
    .getByRole('textbox', { name: 'Document editor', exact: true })
    .focus()
  await pressShortcut(app, `${mod}+z`)
  await waitForAsync(
    page,
    async (initial) => (await window.hibi.getDocument()).markdown === initial,
    initial,
  )
  await pressShortcut(app, `${mod}+Shift+z`)
  await waitForAsync(
    page,
    async (encoded) => (await window.hibi.getDocument()).markdown === encoded,
    encoded,
  )

  await page.getByRole('button', { name: /^source view$/i }).click()
  await page
    .getByRole('textbox', { name: 'Markdown editor', exact: true })
    .waitFor()
  await page.getByRole('button', { name: /^toggle right sidebar$/i }).click()
  await page.getByRole('button', { name: /^right sidebar views$/i }).click()
  await page
    .getByRole('menuitem', { name: 'On this page', exact: true })
    .click()
  const outline = page.locator(
    '.outline-sidebar[data-side="right"][data-open="true"]',
  )
  await outline
    .getByText(/source outline is unavailable for the active addon syntax/i)
    .waitFor()
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  assert.equal(await page.locator('#addon-codec-fixture').isChecked(), true)
  await page.locator('#addon-codec-fixture').click()
  await page.waitForFunction(
    () => !document.querySelector('#addon-codec-fixture')?.checked,
  )
  await page.getByRole('button', { name: 'Back to app', exact: true }).click()
  await outline.getByRole('treeitem', { name: 'title', exact: true }).waitFor()
  await pressShortcut(app, `${mod}+Shift+[`)
  await page.waitForFunction(
    () => document.querySelector('.tiptap')?.editor?.isEditable,
  )
  assert.equal(await page.evaluate(() => window.paragraphCodecEditor), null)
  // Redo uses the native parser's entity behavior. The independent full codec,
  // rather than an assumed decoded spelling, is the oracle after removal.
  const afterDisable = await page.evaluate(() => {
    const editor = document.querySelector('.tiptap').editor
    const end = editor.state.doc.content.size - 1
    const candidate = editor.state.tr.insertText('x', end).doc
    const expected = editor.markdown.serialize(candidate.toJSON())
    editor.commands.setTextSelection(end)
    editor.view.focus()
    return expected
  })
  await page.keyboard.insertText('x')
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    afterDisable,
  )
})
