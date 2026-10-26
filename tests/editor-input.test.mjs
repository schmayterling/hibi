import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  launchBenchmarkApp,
  switchToSource,
  waitForEditor,
} from '../scripts/benchmark-flows.mjs'
import {
  electron,
  showTestWindows,
  waitForDocumentEditor,
} from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { APP_STATE_TIMEOUT, waitForAsync } from './poll.mjs'

test('typing coalesces formatting checks without delaying document changes or undo', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-input-'))
  const app = await launchBenchmarkApp(profile)
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await waitForEditor(page)
  const result = await page.evaluate(async () => {
    const editor = document.querySelector('.tiptap').editor
    await new Promise(requestAnimationFrame)
    const visibleActions = document.querySelectorAll(
      '.editor-toolbar [data-toolbar-id^="format."]',
    ).length
    let checks = 0
    const can = editor.can.bind(editor)
    editor.can = (...args) => {
      checks++
      return can(...args)
    }
    for (const letter of 'hello') editor.commands.insertContent(letter)
    const immediate = { checks, text: editor.getText() }
    await new Promise(requestAnimationFrame)
    const inFrame = checks
    while (!checks) await new Promise(requestAnimationFrame)
    await new Promise(requestAnimationFrame)
    const afterFrame = checks
    const persisted = (await window.hibi.getDocument()).markdown
    editor.commands.undo()
    const undone = editor.getText()
    editor.commands.redo()
    return {
      immediate,
      inFrame,
      afterFrame,
      visibleActions,
      persisted,
      undone,
      redone: editor.getText(),
    }
  })
  assert.deepEqual(result.immediate, { checks: 0, text: 'hello' })
  assert.ok(result.visibleActions > 0)
  // One refresh for all five transactions, after the frame that showed them.
  assert.equal(result.inFrame, 0)
  assert.equal(result.afterFrame, result.visibleActions)
  assert.equal(result.persisted, 'hello')
  assert.equal(result.undone, '')
  assert.equal(result.redone, 'hello')
})

test('visual typing after a source visit defers the hidden source and toolbar checks', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-hidden-source-'))
  const app = await launchBenchmarkApp(profile)
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await waitForEditor(page)
  await switchToSource(app, page)
  await pressShortcut(
    app,
    `${process.platform === 'darwin' ? 'Meta' : 'Control'}+Shift+[`,
  )
  await page.waitForFunction(
    () =>
      document.querySelector('.editor-panes.mode-normal') &&
      document.querySelector('.source-pane .cm-content')?.closest('[inert]'),
  )
  await waitForEditor(page)
  const result = await page.evaluate(async () => {
    const editor = document.querySelector('.tiptap').editor
    const source = document.querySelector('.cm-content').cmTile.root.view
    editor.commands.focus('end')
    await new Promise(requestAnimationFrame)
    const visibleActions = document.querySelectorAll(
      '.editor-toolbar [data-toolbar-id^="format."]',
    ).length
    let updates = 0,
      checks = 0
    const update = source.update.bind(source)
    // Echoes change the document; focus and parser updates of the hidden view do not.
    source.update = (transactions) => {
      if (transactions.some((transaction) => transaction.docChanged)) updates++
      return update(transactions)
    }
    const can = editor.can.bind(editor)
    editor.can = (...args) => {
      checks++
      return can(...args)
    }
    for (const letter of 'hello') editor.commands.insertContent(letter)
    const immediate = { updates, checks, text: editor.getText() }
    while (!checks) await new Promise(requestAnimationFrame)
    await new Promise(requestAnimationFrame)
    return { immediate, afterFrame: { updates, checks }, visibleActions }
  })
  // One toolbar refresh after paint; the hidden source waits until shown.
  assert.deepEqual(result.immediate, { updates: 0, checks: 0, text: 'hello' })
  assert.deepEqual(result.afterFrame, {
    updates: 0,
    checks: result.visibleActions,
  })
  await switchToSource(app, page)
  const shown = await page.evaluate(async () => {
    const source = document.querySelector('.cm-content').cmTile.root.view
    return {
      text: source.state.doc.toString(),
      persisted: (await window.hibi.getDocument()).markdown,
    }
  })
  assert.deepEqual(shown, { text: 'hello', persisted: 'hello' })
})

test('multi-line text input reaches source view in one edit, without native paragraph steps', {
  timeout: 60000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-source-lines-'))
  const app = await launchBenchmarkApp(profile)
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await waitForEditor(page)
  await switchToSource(app, page)
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  await page.evaluate(() => {
    const probe = { added: 0, prevented: [], inputs: [] }
    window.sourceLineInput = probe
    new MutationObserver((records) => {
      for (const record of records) probe.added += record.addedNodes.length
    }).observe(document.querySelector('.cm-content'), {
      childList: true,
      subtree: true,
    })
    window.addEventListener('beforeinput', (event) =>
      probe.prevented.push(event.defaultPrevented),
    )
    window.addEventListener('input', (event) =>
      probe.inputs.push(event.inputType),
    )
  })
  const insert = async (text) => {
    await source.press('ControlOrMeta+a')
    await page.evaluate(() => {
      window.sourceLineInput.added = 0
      window.sourceLineInput.prevented = []
      window.sourceLineInput.inputs = []
    })
    await page.keyboard.insertText(text)
    await waitForAsync(
      page,
      async (text) => (await window.hibi.getDocument()).markdown === text,
      text,
    )
    return page.evaluate(async () => {
      await new Promise(requestAnimationFrame)
      const view = document.querySelector('.cm-content').cmTile.root.view
      return {
        ...window.sourceLineInput,
        text: view.state.doc.toString(),
        head: view.state.selection.main.head,
      }
    })
  }
  const paragraphs = (count) =>
    Array.from({ length: count }, (_, index) => `line ${index}`).join('\n\n')
  const small = await insert(paragraphs(100))
  const large = await insert(paragraphs(1000))
  const added = JSON.stringify({ small: small.added, large: large.added })
  for (const [result, text] of [
    [small, paragraphs(100)],
    [large, paragraphs(1000)],
  ]) {
    assert.deepEqual(result.prevented, [true], added)
    // The typing signal still arrives, as it would from the browser.
    assert.deepEqual(result.inputs, ['insertText'])
    assert.equal(result.text, text)
    assert.equal(result.head, text.length)
  }
  // The editor renders its viewport once instead of the browser adding a
  // block per line break, so the work no longer grows with the paragraphs.
  assert.ok(large.added < 1000 && large.added < small.added * 2, added)
  const plain = await insert('one line')
  assert.deepEqual([plain.prevented, plain.text], [[false], 'one line'])
})

test('source input handlers see multi-line text input with normalized line breaks', {
  timeout: 60000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-source-line-handler-'))
  const addon = join(profile, 'installed-addons', 'upper-input')
  await mkdir(addon, { recursive: true })
  await writeFile(
    join(addon, 'hibi-addon.json'),
    JSON.stringify({
      id: 'upper-input',
      name: 'Upper input',
      description: 'Consuming source input handler fixture',
      kind: 'extension',
      apiVersion: 2,
      version: '1.0.0',
      authors: [{ displayName: 'Test' }],
      capabilities: ['source'],
      entry: 'index.js',
    }),
  )
  await writeFile(
    join(addon, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['hibi-addon.json', 'index.js'],
      source: 'local',
    }),
  )
  await writeFile(
    join(addon, 'index.js'),
    `export default sdk => ({ start(context) {
      window.upperInput = []
      window.upperHandler = (view, from, to, text) => {
        if (!/[\\r\\n]/.test(text)) return false
        window.upperInput.push(text)
        view.dispatch({ changes: { from, to, insert: text.toUpperCase() },
          selection: { anchor: from + text.length } })
        return true
      }
      context.editor.registerSource({ id: 'upper', create: () =>
        sdk.codeMirror.view.EditorView.inputHandler.of(window.upperHandler) })
    }})`,
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'upper-input': true }),
  )
  const app = await launchBenchmarkApp(profile)
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await waitForEditor(page)
  await switchToSource(app, page)
  await page.waitForFunction(() => {
    const view = document.querySelector('.cm-content')?.cmTile.root.view
    return (
      view?.contentDOM.isContentEditable &&
      view.state
        .facet(view.constructor.inputHandler)
        .includes(window.upperHandler)
    )
  })
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  for (const [input, expected] of [
    ['a\r\nb', 'A\nB'],
    ['c\rd', 'C\nD'],
  ]) {
    await source.press('ControlOrMeta+a')
    await page.keyboard.insertText(input)
    await waitForAsync(
      page,
      async (expected) =>
        (await window.hibi.getDocument()).markdown === expected,
      expected,
    )
    const view = await page.evaluate(() => {
      const view = document.querySelector('.cm-content').cmTile.root.view
      return {
        text: view.state.doc.toString(),
        head: view.state.selection.main.head,
        seen: window.upperInput.at(-1),
      }
    })
    assert.deepEqual(view, {
      text: expected,
      head: 3,
      seen: expected.toLowerCase(),
    })
  }
})

test('formatting toolbar states match each action check across selections, typing and history', {
  timeout: 60000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-toolbar-states-'))
  const file = join(profile, 'states.md')
  await writeFile(
    file,
    [
      '# Title',
      'plain **bold** *italic* ~~strike~~ `code` [link](https://example.com) end',
      '- one\n- two\n  - nested',
      '1. first\n2. second',
      '- [ ] task\n- [x] done',
      '> quote',
      '```js\nconst x = 1\n```',
      '| a | b |\n| - | - |\n| cell | 2 |',
      '',
    ].join('\n\n'),
  )
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
  await waitForDocumentEditor(app, page)
  await page.evaluate(() => {
    // The same capability and active checks FormattingToolbar runs for each rich action.
    const list = (editor) =>
      editor.isActive('taskList') ? 'taskItem' : 'listItem'
    const actions = [
      ['undo', (c) => c.undo()],
      ['redo', (c) => c.redo()],
      ['bold', (c) => c.toggleBold(), 'bold'],
      ['italic', (c) => c.toggleItalic(), 'italic'],
      ['strike', (c) => c.toggleStrike(), 'strike'],
      ['inline-code', (c) => c.toggleCode(), 'code'],
      ['subscript', (c) => c.toggleMark('subscript'), 'subscript'],
      ['subtext', (c) => c.setNode('subtext'), 'subtext'],
      ['paragraph', (c) => c.setParagraph(), 'paragraph'],
      ...[1, 2, 3, 4, 5, 6].map((level) => [
        `heading-${level}`,
        (c) => c.toggleHeading({ level }),
        'heading',
        { level },
      ]),
      ['bullet-list', (c) => c.toggleBulletList(), 'bulletList'],
      ['numbered-list', (c) => c.toggleOrderedList(), 'orderedList'],
      ['checklist', (c) => c.toggleTaskList(), 'taskList'],
      ['indent', (c, editor) => c.sinkListItem(list(editor))],
      ['outdent', (c, editor) => c.liftListItem(list(editor))],
      ['quote', (c) => c.toggleBlockquote(), 'blockquote'],
      ['code-block', (c) => c.toggleCodeBlock(), 'codeBlock'],
      ['divider', (c) => c.setHorizontalRule()],
      ['hard-break', (c) => c.setHardBreak()],
      ['link', (c) => c.setLink({ href: 'https://example.com' }), 'link'],
      ['unlink', (c) => c.unsetLink()],
      ['image', (c) => c.setImage({ src: 'image.png' })],
      [
        'table',
        (c) => c.insertTable({ rows: 3, cols: 2, withHeaderRow: true }),
      ],
      ...[
        ['row-before', (c) => c.addRowBefore()],
        ['row-after', (c) => c.addRowAfter()],
        ['row-delete', (c) => c.deleteRow()],
        ['column-before', (c) => c.addColumnBefore()],
        ['column-after', (c) => c.addColumnAfter()],
        ['column-delete', (c) => c.deleteColumn()],
        ['table-delete', (c) => c.deleteTable()],
      ].map(([id, rich]) => [id, rich, undefined, undefined, true]),
    ]
    window.__toolbarStates = () => {
      const editor = document.querySelector('.tiptap').editor
      const inTable = editor.isActive('table')
      const expected = {}
      for (const [id, rich, active, attrs, table] of actions) {
        if (table && !inTable) continue
        let allowed
        try {
          allowed = rich(editor.can().chain(), editor).run()
        } catch {
          allowed = false
        }
        expected[id] = {
          pressed: active ? String(editor.isActive(active, attrs)) : null,
          disabled: !editor.isEditable || !allowed,
        }
      }
      const actual = {}
      for (const button of document.querySelectorAll(
        '.editor-toolbar [data-toolbar-id^="format."]',
      ))
        actual[button.dataset.toolbarId.slice('format.'.length)] = {
          pressed:
            button.getAttribute('aria-pressed') ??
            button.getAttribute('aria-checked'),
          disabled: button.disabled,
        }
      return { expected, actual }
    }
  })
  const states = () => page.evaluate(() => window.__toolbarStates())
  const settled = async (label) => {
    try {
      await page.waitForFunction(
        () => {
          const { expected, actual } = window.__toolbarStates()
          return (
            Object.keys(actual).length === Object.keys(expected).length &&
            Object.entries(expected).every(
              ([id, state]) =>
                actual[id]?.pressed === state.pressed &&
                actual[id]?.disabled === state.disabled,
            )
          )
        },
        undefined,
        { timeout: APP_STATE_TIMEOUT },
      )
    } catch {
      const { expected, actual } = await states()
      assert.deepEqual(actual, expected, label)
    }
    return (await states()).actual
  }
  const select = (text, offset = 1, length = 0) =>
    page.evaluate(
      ({ text, offset, length }) => {
        const editor = document.querySelector('.tiptap').editor
        let from = null
        editor.state.doc.descendants((node, position) => {
          if (from === null && node.isText && node.text.includes(text))
            from = position + node.text.indexOf(text) + offset
          return from === null
        })
        editor.commands.setTextSelection({ from, to: from + length })
      },
      { text, offset, length },
    )
  const cases = {}
  for (const [label, text, offset, length] of [
    ['heading', 'Title'],
    ['plain text', 'plain'],
    ['bold text', 'bold'],
    ['italic selection', 'italic', 0, 6],
    ['mixed selection', 'plain', 0, 14],
    ['inline code', 'code'],
    ['link', 'link'],
    ['first list item', 'one'],
    ['second list item', 'two'],
    ['nested list item', 'nested'],
    ['numbered list', 'second'],
    ['checklist', 'task'],
    ['quote', 'quote'],
    ['code block', 'const'],
    ['table cell', 'cell'],
  ]) {
    await select(text, offset, length)
    cases[label] = await settled(label)
  }
  await page.evaluate(() =>
    document.querySelector('.tiptap').editor.commands.selectAll(),
  )
  cases['whole document'] = await settled('whole document')
  assert.equal(cases.heading['heading-1'].pressed, 'true')
  assert.equal(cases['bold text'].bold.pressed, 'true')
  assert.equal(cases['plain text'].bold.pressed, 'false')
  assert.equal(cases['code block']['code-block'].pressed, 'true')
  assert.equal(cases['code block'].bold.disabled, true)
  assert.equal(cases['first list item'].indent.disabled, true)
  assert.equal(cases['second list item'].indent.disabled, false)
  assert.equal(cases['nested list item'].outdent.disabled, false)
  assert.equal(cases['table cell']['row-after'].disabled, false)
  assert.equal(cases['plain text']['row-after'], undefined)

  await select('end', 3)
  await page.evaluate(() =>
    document.querySelector('.tiptap').editor.commands.toggleBold(),
  )
  assert.equal((await settled('stored bold mark')).bold.pressed, 'true')
  await page.evaluate(() => document.querySelector('.tiptap').focus())
  await page.keyboard.type(' typed')
  const typed = await settled('after typing')
  assert.equal(typed.undo.disabled, false)
  assert.equal(typed.bold.pressed, 'true')
  await page.evaluate(() =>
    document.querySelector('.tiptap').editor.commands.undo(),
  )
  assert.equal((await settled('after undo')).redo.disabled, false)
  await page.evaluate(() =>
    document.querySelector('.tiptap').editor.commands.redo(),
  )
  assert.equal((await settled('after redo')).redo.disabled, true)

  await select('plain')
  assert.equal((await settled('before toolbar click')).bold.pressed, 'false')
  // A click before the toolbar refreshes still formats the live selection.
  const shown = await page.evaluate(() => {
    const editor = document.querySelector('.tiptap').editor
    let from = null
    editor.state.doc.descendants((node, position) => {
      if (from === null && node.isText && node.text === 'bold') from = position
      return from === null
    })
    editor.commands.setTextSelection({ from, to: from + 4 })
    const button = document.querySelector(
      '.editor-toolbar [data-toolbar-id="format.bold"]',
    )
    const pressed = button.getAttribute('aria-pressed')
    button.click()
    return pressed
  })
  assert.equal(shown, 'false')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('plain bold *italic*'),
  )
  assert.equal((await settled('after toolbar click')).bold.pressed, 'false')
})

test('blank paragraphs and typed spaces survive tab switches without nonbreaking spaces', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-space-input-'))
  const file = join(profile, 'spaces.md')
  await writeFile(file, '')
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
  await waitForDocumentEditor(app, page)
  await page.waitForFunction(
    () => document.querySelector('.tiptap')?.isContentEditable,
  )
  const rich = page.getByRole('textbox', { name: 'Document editor' })
  await rich.click()
  await page.keyboard.type('first')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('second')
  await page.keyboard.press('Space')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.endsWith('second '),
  )
  const typed = await page.evaluate(() => window.hibi.getDocument())
  assert.equal(typed.markdown, 'first\n\n\n\nsecond ')
  assert.doesNotMatch(typed.markdown, /&nbsp;|\u00a0/)
  await clickMenu(app, 'New')
  await page.waitForFunction(
    () => document.querySelector('.tiptap')?.textContent === '',
  )
  await page.getByRole('tab', { name: 'spaces.md', exact: true }).click()
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId === id,
    typed.tabId,
  )
  await page.waitForFunction(
    () => document.querySelector('.tiptap')?.textContent === 'firstsecond ',
  )
  const restored = await page.evaluate(() => window.hibi.getDocument())
  assert.equal(restored.tabId, typed.tabId)
  assert.equal(restored.markdown, typed.markdown)
  assert.doesNotMatch(restored.markdown, /&nbsp;|\u00a0/)
  await page.evaluate(() => window.hibi.saveDocument(false))
  assert.equal(await readFile(file, 'utf8'), typed.markdown)
})

for (const spaces of [1, 2]) {
  test(`typing a letter after ${spaces} trailing spaces keeps regular spaces`, {
    timeout: 30000,
  }, async (t) => {
    const profile = await mkdtemp(join(tmpdir(), 'hibi-trailing-space-'))
    const app = await launchBenchmarkApp(profile)
    t.after(async () => {
      await app.close()
      await rm(profile, { recursive: true, force: true })
    })
    const page = await app.firstWindow()
    const whitespaceWarnings = []
    page.on('console', (message) => {
      if (/white-space/.test(message.text()))
        whitespaceWarnings.push(message.text())
    })
    await waitForEditor(page)
    const rich = page.getByRole('textbox', { name: 'Document editor' })
    assert.equal(
      await rich.evaluate((element) => getComputedStyle(element).whiteSpace),
      'pre-wrap',
    )
    await rich.click()
    await page.keyboard.type('hi')
    for (let index = 0; index < spaces; index++)
      await page.keyboard.press('Space')
    await page.keyboard.type('x')
    const expected = `hi${' '.repeat(spaces)}x`
    await waitForAsync(
      page,
      async (text) => (await window.hibi.getDocument()).markdown === text,
      expected,
    )
    const { markdown } = await page.evaluate(() => window.hibi.getDocument())
    assert.equal(markdown, expected)
    assert.doesNotMatch(markdown, /&nbsp;|\u00a0/)
    assert.equal(await rich.textContent(), expected)
    assert.deepEqual(whitespaceWarnings, [])
    await rich.evaluate((element) => element.editor.commands.undo())
    await waitForAsync(
      page,
      async () => (await window.hibi.getDocument()).markdown === '',
    )
  })
}

test('long documents with HTML and reference syntax stay visually editable through save and undo', {
  timeout: 60000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-unrestricted-rich-'))
  const file = join(profile, 'long.md')
  const original = [
    '# Editable document',
    '<div>HTML content</div>',
    '[reference][target]\n\n[target]: https://example.com',
    ...Array(200).fill('alpha beta '.repeat(500)),
  ].join('\n\n')
  assert.ok(original.length > 1000000)
  await writeFile(file, original)
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
  page.setDefaultTimeout(15000)
  const editable = () =>
    page.waitForFunction(
      () => document.querySelector('.tiptap')?.isContentEditable,
    )
  await editable()
  const opened = (await page.evaluate(() => window.hibi.getDocument())).markdown
  assert.match(opened, /^# Editable document/)
  assert.match(opened, /HTML content/)
  assert.match(opened, /reference/)
  assert.ok(opened.length > 1000000)
  await page
    .waitForFunction(() => {
      const editor = document.querySelector('.tiptap')
      const panel = editor?.closest('.editor-page')
      return (
        editor?.isContentEditable &&
        editor.textContent?.startsWith('Editable document') &&
        panel?.getAttribute('aria-busy') === 'false' &&
        !panel.hasAttribute('inert')
      )
    })
    .catch(async (error) => {
      const state = await page.evaluate(() => {
        const editor = document.querySelector('.tiptap')
        const panel = editor?.closest('.editor-page')
        return {
          text: editor?.textContent?.slice(0, 80),
          editable: editor?.isContentEditable,
          busy: panel?.getAttribute('aria-busy'),
          inert: panel?.hasAttribute('inert'),
        }
      })
      assert.fail(
        `long document never became editable: ${error.message}\n${JSON.stringify(state)}`,
      )
    })
  if (showTestWindows)
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setFocusable(true)
      window.show()
      window.focus()
    })
  await page.locator('.tiptap').evaluate((element) => {
    element.editor.commands.setTextSelection(1)
    element.editor.view.focus()
  })
  await page
    .waitForFunction(
      (needsWindowFocus) =>
        (!needsWindowFocus || document.hasFocus()) &&
        document.activeElement?.classList.contains('tiptap'),
      showTestWindows,
      { timeout: 5000 },
    )
    .catch(async (error) => {
      const state = await page.evaluate(() => ({
        focused: document.hasFocus(),
        active: document.activeElement?.outerHTML.slice(0, 160),
      }))
      assert.fail(
        `long document editor never received focus: ${error.message}\n${JSON.stringify(state)}`,
      )
    })
  await page.keyboard.insertText('edited ')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.startsWith(
      '# edited Editable document',
    ),
  )
  const edited = (await page.evaluate(() => window.hibi.getDocument())).markdown
  assert.ok(edited.includes('alpha beta'))
  await page.locator('.tiptap').evaluate((element) => {
    element.editor.commands.undo()
  })
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    opened,
  )
  await editable()
  await page.locator('.tiptap').evaluate((element) => {
    element.editor.commands.redo()
  })
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    edited,
  )
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await page
    .getByRole('textbox', { name: 'Markdown editor', exact: true })
    .waitFor()
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await editable()
  await page.evaluate(() => window.hibi.saveDocument(false))
  assert.equal(await readFile(file, 'utf8'), edited)
  await page.reload()
  await editable()
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    edited,
  )
})
