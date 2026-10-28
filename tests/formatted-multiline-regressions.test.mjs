import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { MarkdownManager } from '@tiptap/markdown'
import { markdownConfiguration } from '../src/renderer/src/markdown.ts'
import { electron } from './electron.mjs'
import { selectFormattedEngine } from './formatted-engine.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

async function openFixture(
  app,
  page,
  folder,
  name,
  source,
  engine = 'codemirror',
) {
  const file = join(folder, `${name}.md`)
  await writeFile(file, source)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await clickMenu(app, 'Open…')
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).name === expected,
    `${name}.md`,
  )
  const selector =
    engine === 'tiptap'
      ? '.rich-pane .tiptap'
      : '.rich-pane .hibi-formatted .cm-content'
  const editor = page.locator(selector)
  await editor.waitFor()
  await page.waitForFunction(
    ({ source, selector, engine }) => {
      const element = document.querySelector(selector)
      if (engine === 'tiptap') return element?.editor?.getMarkdown() === source
      const view = element?.cmTile?.root?.view
      return (
        view && !view.state.readOnly && view.state.doc.toString() === source
      )
    },
    { source, selector, engine },
  )
  return editor
}

async function launch(t, engine = 'codemirror') {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-multiline-regressions-'))
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
  await selectFormattedEngine(app, page, engine)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  t.after(() => cdp.detach().catch(() => {}))
  return { app, page, folder }
}

async function typeAt(page, editor, item) {
  await editor.focus()
  await editor.evaluate((element, item) => {
    const view = element.cmTile.root.view
    view.dispatch({
      selection: { anchor: item.from, head: item.to ?? item.from },
    })
  }, item)
  if (item.all) await editor.press('ControlOrMeta+a')
  await page.keyboard.insertText(item.input)
  return editor.evaluate((element) =>
    element.cmTile.root.view.state.doc.toString(),
  )
}

test('native multiline input preserves formatting and containers in the app', {
  timeout: 120000,
}, async (t) => {
  const { app, page, folder } = await launch(t)
  const cases = [
    {
      name: 'format-start',
      source: '**abcd**',
      from: 2,
      input: '\ny',
      expected: '\n\n**yabcd**',
    },
    {
      name: 'setext',
      source: 'abcd\n====',
      from: 2,
      input: 'X\nY',
      expected: '# abX\n\nYcd\n====',
    },
    {
      name: 'task-end',
      source: '- [x] ab',
      from: 8,
      input: 'x\n\ny',
      expected: '- [x] abx\n\ny',
    },
    {
      name: 'task-middle',
      source: '- [x] abcd\n- [ ] tail',
      from: 8,
      input: 'x\n\ny',
      expected: '- [x] abx\n- [ ] \n- [ ] ycd\n- [ ] tail',
    },
    {
      name: 'quoted-width',
      source: '> 8. abcd\n> 9. tail\n>\n>    more',
      from: 7,
      input: 'x\ny',
      expected: '> 8. abx\n> 9. ycd\n> 10. tail\n>\n>     more',
    },
    {
      name: 'quoted-list',
      source: '- > 8. abcd\n  > 9. tail',
      from: 9,
      input: 'x\ny',
      expected: '- > 8. abx\n  > 9. ycd\n  > 10. tail',
    },
    {
      name: 'bold-select-all',
      source: '**abcd**',
      from: 0,
      to: 8,
      input: 'x\ny',
      expected: '**x**\n\n**y**',
    },
    {
      name: 'hidden-fence-cr',
      source: 'plain\n\n```\ncode\n```',
      from: 0,
      all: true,
      input: '# typed\ry',
      expected: '\\# typed\n\ny',
    },
    {
      name: 'quote-in-item',
      source: '- parent\n  > abcd\n- tail',
      from: 15,
      input: 'x\ny',
      expected: '- parent\n  > abx\n- ycd\n- tail',
    },
    {
      name: 'task-tabs',
      source: '- [x] abcd',
      from: 8,
      input: '\n\t\t',
      expected: '- [x] ab\n- [ ] &#9;\tcd',
    },
  ]
  for (const item of cases)
    await t.test(item.name, async () => {
      const editor = await openFixture(
        app,
        page,
        folder,
        item.name,
        item.source,
      )
      assert.equal(await typeAt(page, editor, item), item.expected)
      await waitForAsync(
        page,
        async (expected) =>
          (await window.hibi.getDocument()).markdown === expected,
        item.expected,
      )
      await pressShortcut(app, `${mod}+z`)
      await waitForAsync(
        page,
        async (expected) =>
          (await window.hibi.getDocument()).markdown === expected,
        item.source,
      )
    })
})

test('the native editor nests later lines typed in the middle of a task', {
  timeout: 30000,
}, async (t) => {
  const { app, page, folder } = await launch(t, 'tiptap')
  const source = '- [x] abcd\n- [ ] tail'
  const expected = '- [x] abx\n- [ ] \n  - ycd\n- [ ] tail'
  const editor = await openFixture(
    app,
    page,
    folder,
    'native-task-middle',
    source,
    'tiptap',
  )
  const selected = await editor.evaluate((element) => {
    const editor = element.editor
    let position = null
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'abcd') position = pos + 2
    })
    if (position == null) return false
    const handlers = editor.options.editorProps.handleDOMEvents
    editor.setOptions({
      editorProps: {
        ...editor.options.editorProps,
        handleDOMEvents: { ...handlers, beforeinput: () => false },
      },
    })
    editor.commands.setTextSelection(position)
    editor.view.focus()
    return true
  })
  assert.equal(selected, true)
  await page.keyboard.insertText('x\n\ny')
  await page.waitForFunction(
    (expected) =>
      document.querySelector('.rich-pane .tiptap')?.editor?.getMarkdown() ===
      expected,
    expected,
  )
  assert.equal(
    await editor.evaluate((element) => element.editor.getMarkdown()),
    expected,
  )
})

test('native multiline input after a long formatted space run keeps paragraph boundaries', {
  timeout: 30000,
  todo: 'formatted gap input-space-001: multiline input after a long formatted space run keeps paragraph boundaries',
}, async (t) => {
  const { app, page, folder } = await launch(t)
  const spaces = ' '.repeat(257)
  const source = `**a${spaces}b**`
  const editor = await openFixture(
    app,
    page,
    folder,
    'long-formatted-spaces',
    source,
  )
  const actual = await typeAt(page, editor, {
    from: 3 + spaces.length,
    input: '\ny',
  })
  assert.equal(actual, `**a**${spaces}\n\n**yb**`)
})

test('select-all code input matches the native model with exact formatted undo and redo', {
  timeout: 60000,
}, async (t) => {
  const source = '```\nabcd\n```\n\nend'
  const input = '```\nX'
  let nativeModel
  for (const engine of ['tiptap', 'codemirror'])
    await t.test(engine, async (t) => {
      const { app, page, folder } = await launch(t, engine)
      const editor = await openFixture(
        app,
        page,
        folder,
        'code-fence',
        source,
        engine,
      )
      const snapshot = () =>
        page.evaluate(async () => {
          await window.hibi.flushDocumentChanges()
          const element = document.querySelector(
            '[aria-label="Document editor"]',
          )
          return {
            source: (await window.hibi.getDocument()).markdown,
            model: element.editor?.getJSON() ?? null,
          }
        })
      await editor.focus()
      if (engine === 'tiptap')
        await editor.evaluate((element) => {
          element.editor.commands.selectAll()
          element.editor.view.focus()
        })
      const before = await snapshot()
      assert.equal(before.source, source)
      await editor.press('ControlOrMeta+a')
      await page.keyboard.insertText(input)
      const typed = await snapshot()
      if (engine === 'tiptap') {
        nativeModel = typed.model
        assert.equal(nativeModel.content.length, 1)
        assert.equal(nativeModel.content[0].type, 'codeBlock')
        assert.equal(nativeModel.content[0].content[0].text, input)
        return
      }
      const {
        parser: marked,
        options,
        core,
        addons,
      } = markdownConfiguration([])
      const manager = new MarkdownManager({
        extensions: [...core, ...addons],
        marked,
        markedOptions: options,
      })
      assert.deepEqual(
        JSON.parse(JSON.stringify(manager.parse(typed.source))),
        nativeModel,
      )
      assert.equal(typed.source, '````\n```\nX\n````')
      for (const [shortcut, expected] of [
        [`${mod}+z`, before],
        [process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y', typed],
      ]) {
        await pressShortcut(app, shortcut)
        await waitForAsync(
          page,
          async (expected) => {
            await window.hibi.flushDocumentChanges()
            const element = document.querySelector(
              '[aria-label="Document editor"]',
            )
            return (
              (await window.hibi.getDocument()).markdown === expected.source &&
              JSON.stringify(element.editor?.getJSON() ?? null) ===
                JSON.stringify(expected.model)
            )
          },
          expected,
        )
        assert.deepEqual(await snapshot(), expected)
      }
    })
})
