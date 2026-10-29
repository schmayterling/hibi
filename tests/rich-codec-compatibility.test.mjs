import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { selectFormattedEngine } from './formatted-engine.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('rich codec attachments invalidate plain certificates but not the source outline', {
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
  await page.locator('.settings-screen').waitFor({ state: 'hidden' })
  await page.waitForFunction(() => {
    const surface = document.querySelector('.editor-surface')
    return (
      surface &&
      !surface.inert &&
      surface.querySelector('.tiptap')?.editor?.isEditable
    )
  })
  await page.evaluate(() => {
    const editor = document.querySelector('.tiptap').editor
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    editor.view.focus()
  })
  await page.keyboard.insertText('s')
  // The codec still serializes every block; the source proof keeps untouched bytes.
  const encoded =
    '# title\n\n&#115;teady words\n\n&#109;iddle words\n\n&#104;ellos'
  const changed = initial.replace('hello', '&#104;ellos')
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    changed,
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
  assert.equal(await readFile(file, 'utf8'), changed)
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
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    changed,
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
  // Rich attachments cannot change how the source is parsed.
  await outline.getByRole('treeitem', { name: 'title', exact: true }).waitFor()
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
  // Removing the codec still leaves untouched source intact on later edits.
  await page.evaluate(() => {
    const editor = document.querySelector('.tiptap').editor
    const end = editor.state.doc.content.size - 1
    editor.commands.setTextSelection(end)
    editor.view.focus()
  })
  await page.keyboard.insertText('x')
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    `${changed}x`,
  )
})

test('codemirror: legacy rich codecs stay inert while native edits and source safeguards remain', {
  timeout: 45000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-cm-rich-codec-'))
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
      window.codecLifecycle = { attached: 0, detached: 0 };
      context.editor.registerRich({ id: 'codec', attach(editor) {
        window.codecLifecycle.attached++;
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
          window.codecLifecycle.detached++;
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

  const rich = await selectFormattedEngine(app, page, 'codemirror')
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
  await clickMenu(app, 'Open…')
  await rich.locator('.cm-line', { hasText: /^hello$/ }).waitFor()
  await page.locator('[data-status-id="word-count.total"]').waitFor()
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const expected = (text) =>
    waitForAsync(
      page,
      async (text) => (await window.hibi.getDocument()).markdown === text,
      text,
    )
  const end = () =>
    rich.evaluate((element) => {
      const view = element.cmTile.root.view
      view.dispatch({ selection: { anchor: view.state.doc.length } })
      view.focus()
    })
  await end()
  await page.keyboard.insertText('s')
  await expected(`${initial}s`)
  await pressShortcut(app, `${mod}+z`)
  await expected(initial)
  const before = await page.evaluate(() => window.hibi.getDocument())
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  assert.equal(await page.locator('#addon-codec-fixture').isChecked(), false)
  await page.locator('#addon-codec-fixture').click()
  await page.waitForFunction(
    () =>
      document.querySelector('#addon-codec-fixture')?.checked &&
      window.codecLifecycle,
  )
  await page.getByRole('button', { name: 'Back to app', exact: true }).click()
  await page.waitForFunction(
    () => document.querySelector('.rich-pane .cm-content')?.isContentEditable,
  )
  // API v1/v2 rich addons do not execute in the formatted engine.
  assert.deepEqual(await page.evaluate(() => window.codecLifecycle), {
    attached: 0,
    detached: 0,
  })
  assert.equal(
    await page.evaluate(() => window.paragraphCodecEditor),
    undefined,
  )
  assert.equal(await page.locator('.tiptap').count(), 0)
  const enabled = await page.evaluate(() => window.hibi.getDocument())
  assert.equal(enabled.markdown, initial)
  assert.equal(enabled.contentVersion, before.contentVersion)
  await end()
  await page.keyboard.insertText('s')
  const changed = `${initial}s`
  await expected(changed)
  assert.equal(
    await rich.locator('.cm-line', { hasText: /^hellos$/ }).count(),
    1,
  )
  await clickMenu(app, 'Save')
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  assert.equal(await readFile(file, 'utf8'), changed)
  await page.waitForFunction(
    () => document.querySelector('.rich-pane .cm-content')?.isContentEditable,
  )
  await rich.focus()
  await pressShortcut(app, `${mod}+z`)
  await expected(initial)
  await pressShortcut(app, `${mod}+Shift+z`)
  await expected(changed)

  await t.test(
    'the inert codec has an explicit compatibility notice',
    async () => {
      const matches =
        /codec fixture.*(?:legacy|formatted|incompatible|unsupported)|(?:legacy|formatted|incompatible|unsupported).*codec fixture/i
      const messages = [
        ...(await page.getByRole('alert').allTextContents()),
        ...(await page.getByRole('status').allTextContents()),
      ]
      t.diagnostic(JSON.stringify({ stage: 'compatibility notice', messages }))
      assert.ok(
        messages.some((message) => matches.test(message)),
        'API v2 rich addon needs an explicit notice that its formatted feature is inactive.',
      )
    },
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
  t.diagnostic(
    JSON.stringify({
      stage: 'inert codec outline',
      text: await outline.innerText(),
    }),
  )
  await t.test(
    'source outline keeps its headings while the inert codec is on',
    async () => {
      await outline
        .getByRole('treeitem', { name: 'title', exact: true })
        .waitFor()
    },
  )
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
    () => document.querySelector('.rich-pane .cm-content')?.isContentEditable,
  )
  await end()
  await page.keyboard.insertText('x')
  await expected(`${changed}x`)
  assert.equal(
    await rich.evaluate(
      (element) => element.cmTile.root.view.state.selection.main.head,
    ),
    changed.length + 1,
  )
  await cdp.detach()
})
