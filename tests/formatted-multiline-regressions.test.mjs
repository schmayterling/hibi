import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { getSchema } from '@tiptap/core'
import { MarkdownManager } from '@tiptap/markdown'
import { markdownConfiguration } from '../src/renderer/src/markdown.ts'
import { electron } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

function modelParser() {
  const { parser: marked, options, core, addons } = markdownConfiguration([])
  const extensions = [...core, ...addons]
  const manager = new MarkdownManager({
    extensions,
    marked,
    markedOptions: options,
  })
  const schema = getSchema(extensions)
  return (source) => schema.nodeFromJSON(manager.parse(source)).toJSON()
}

const snapshot = (page) =>
  page.evaluate(async () => {
    await window.hibi.flushDocumentChanges()
    const element = document.querySelector('[aria-label="Document editor"]')
    return {
      source: (await window.hibi.getDocument()).markdown,
      model: element.editor?.getJSON() ?? null,
    }
  })

async function assertHistory(app, page, before, typed) {
  for (const [shortcut, expected] of [
    [`${mod}+z`, before],
    [process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y', typed],
  ]) {
    await pressShortcut(app, shortcut)
    await waitForAsync(
      page,
      async (expected) => {
        await window.hibi.flushDocumentChanges()
        return (await window.hibi.getDocument()).markdown === expected.source
      },
      expected,
    )
    assert.deepEqual(await snapshot(page), expected)
  }
}

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
  timeout: 60000,
}, async (t) => {
  const spaces = ' '.repeat(257)
  const source = `**a${spaces}b**`
  const expected = `**a${spaces.slice(1)}&#32;**\n\n**yb**`
  const nativeSource = `**a**${spaces}\n\n**yb**`
  const parse = modelParser()
  let nativeModel
  {
    await t.test('codemirror', async (t) => {
      const { app, page, folder } = await launch(t, 'codemirror')
      const editor = await openFixture(
        app,
        page,
        folder,
        'long-formatted-spaces',
        source,
        'codemirror',
      )
      await editor.focus()
      await editor.evaluate(
        (element, { engine, length }) => {
          if (engine === 'codemirror') {
            element.cmTile.root.view.dispatch({
              selection: { anchor: length + 3 },
            })
            return
          }
          element.editor.commands.setTextSelection(length + 2)
          element.editor.view.focus()
        },
        { engine: 'codemirror', length: spaces.length },
      )
      const before = await snapshot(page)
      assert.equal(before.source, source)

      await page.keyboard.insertText('\ny')
      const typed = await snapshot(page)
      assert.equal(typed.source, expected)
      assert.deepEqual(parse(typed.source), nativeModel)
      await t.test(
        'exact source and model after undo and redo',
        {
          todo: false,
        },
        () => assertHistory(app, page, before, typed),
      )
    })
  }
})

test('select-all code input matches the native model with exact formatted undo and redo', {
  timeout: 60000,
}, async (t) => {
  const source = '```\nabcd\n```\n\nend'
  const input = '```\nX'
  let nativeModel
  {
    await t.test('codemirror', async (t) => {
      const { app, page, folder } = await launch(t, 'codemirror')
      const editor = await openFixture(
        app,
        page,
        folder,
        'code-fence',
        source,
        'codemirror',
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

      const before = await snapshot()
      assert.equal(before.source, source)
      await editor.press('ControlOrMeta+a')
      await page.keyboard.insertText(input)
      const typed = await snapshot()

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
  }
})

test('multiline selection edges match untouched native marks with exact formatted history', {
  timeout: 120000,
}, async (t) => {
  const cases = [
    {
      name: 'both edges',
      source: '`a` mid `b`',
      from: 2,
      to: 9,
      nativeFrom: 2,
      nativeTo: 7,
      expected: '`a`\\`x\\`\n\n\\`y\\``b`',
    },
    {
      name: 'start edge',
      source: '`a` mid `b`',
      from: 2,
      to: 6,
      nativeFrom: 2,
      nativeTo: 5,
      expected: '`a`\\`x\\`\n\n\\`y\\`d `b`',
    },
    {
      name: 'end edge',
      source: '`a` mid `b`',
      from: 4,
      to: 9,
      nativeFrom: 3,
      nativeTo: 7,
      expected: '`a` \\`x\\`\n\n\\`y\\``b`',
    },
    {
      name: 'nested edges',
      source: '**`a`** mid **`b`**',
      from: 4,
      to: 15,
      nativeFrom: 2,
      nativeTo: 7,
      expected: '**`a`**\\`x\\`\n\n\\`y\\`**`b`**',
      plain: '**`a`**&#120;\n\n&#121;**`b`**',
    },
    {
      name: 'shared bold',
      source: '**`a` mid `b`**',
      from: 4,
      to: 11,
      nativeFrom: 2,
      nativeTo: 7,
      expected: '**`a`\\`x\\`**\n\n**\\`y\\``b`**',
    },
    {
      name: 'full selection',
      source: '`a` mid `b`',
      from: 0,
      to: 11,
      nativeFrom: 1,
      nativeTo: 8,
      expected: '`` `x` ``\n\n\\`y\\`',
    },
  ]
  const parse = modelParser()
  const native = new Map()
  {
    await t.test('codemirror', async (t) => {
      const { app, page, folder } = await launch(t, 'codemirror')
      for (const item of cases)
        for (const backward of [false, true])
          for (const ticks of [true, false]) {
            const name =
              item.name +
              '-' +
              (backward ? 'backward' : 'forward') +
              '-' +
              (ticks ? 'backticks' : 'plain')
            await t.test(name, async () => {
              const editor = await openFixture(
                app,
                page,
                folder,
                name,
                item.source,
                'codemirror',
              )
              await editor.focus()
              await editor.evaluate(
                (element, { engine, item, backward }) => {
                  const from = engine === 'tiptap' ? item.nativeFrom : item.from
                  const to = engine === 'tiptap' ? item.nativeTo : item.to
                  const anchor = backward ? to : from
                  const head = backward ? from : to
                  if (engine === 'codemirror')
                    element.cmTile.root.view.dispatch({
                      selection: { anchor, head },
                    })
                  else {
                    const editor = element.editor
                    editor.view.dispatch(
                      editor.state.tr.setSelection(
                        editor.state.selection.constructor.create(
                          editor.state.doc,
                          anchor,
                          head,
                        ),
                      ),
                    )
                    editor.view.focus()
                  }
                },
                { engine: 'codemirror', item, backward },
              )
              const before = await snapshot(page)
              assert.equal(before.source, item.source)

              const expected = ticks
                ? item.expected
                : (item.plain ??
                  (item.name === 'full selection'
                    ? '`x`\n\ny'
                    : item.expected
                        .replaceAll('\\`x\\`', 'x')
                        .replaceAll('\\`y\\`', 'y')))
              await page.keyboard.insertText(ticks ? '`x`\n`y`' : 'x\ny')
              const typed = await snapshot(page)
              assert.notEqual(
                typed.source,
                before.source,
                'native control must perform an edit',
              )

              assert.equal(typed.source, expected)
              assert.ok(native.has(name), 'native control must pass first')
              assert.deepEqual(parse(typed.source), native.get(name))
              await assertHistory(app, page, before, typed)
            })
          }
    })
  }
})

test('raw marker multiline ranges preserve unselected source and exact history', {
  timeout: 120000,
}, async (t) => {
  const source = '**`a`** mid **`b`**'
  const ranges = [
    [2, 3],
    [4, 5],
    [14, 15],
    [16, 17],
    [1, 3],
    [4, 6],
    [13, 15],
    [16, 18],
  ]
  const { app, page, folder } = await launch(t)
  for (const [from, to] of ranges)
    for (const backward of [false, true])
      for (const input of ['x\ny', '`x`\n`y`'])
        await t.test(`${from}..${to}, ${backward}, ${input}`, async () => {
          const name = `raw-markers-${from}-${to}-${backward}-${input.includes('`')}`
          const editor = await openFixture(app, page, folder, name, source)
          await editor.focus()
          const selected = await editor.evaluate(
            (element, { from, to, backward }) => {
              const view = element.cmTile.root.view
              view.dispatch({
                selection: backward
                  ? { anchor: to, head: from }
                  : { anchor: from, head: to },
              })
              const { anchor, head } = view.state.selection.main
              return { anchor, head }
            },
            { from, to, backward },
          )
          assert.deepEqual(
            selected,
            backward ? { anchor: to, head: from } : { anchor: from, head: to },
          )
          const before = await snapshot(page)
          await page.keyboard.insertText(input)
          const typed = await snapshot(page)
          assert.equal(
            typed.source,
            source.slice(0, from) + input + source.slice(to),
          )
          await assertHistory(app, page, before, typed)
        })
})

test('inline code multiline input matches the native model with exact source and history', {
  timeout: 120000,
}, async (t) => {
  const cases = [
    {
      name: 'later-backticks',
      source: '`abcd`',
      text: 'abcd',
      offset: 2,
      from: 3,
      input: 'x\n`y`',
      expected: '`abx`\n\n`` `y`cd ``',
    },
    {
      name: 'first-backticks',
      source: '`abcd`',
      text: 'abcd',
      offset: 2,
      from: 3,
      input: '`x`\ny',
      expected: '`` ab`x` ``\n\n`ycd`',
    },
    {
      name: 'padded-code',
      source: '`` `abcd` ``',
      text: '`abcd`',
      offset: 3,
      from: 6,
      input: 'x\n`y`',
      expected: '`` `abx ``\n\n`` `y`cd` ``',
    },
    {
      name: 'different-runs',
      source: '``a`b``',
      text: 'a`b',
      offset: 2,
      from: 4,
      input: '`x`\n``y``',
      expected: '``` a``x` ```\n\n` ``y``b `',
    },
    {
      name: 'code-end',
      source: '`abcd`',
      text: 'abcd',
      offset: 4,
      from: 5,
      input: '`x`\ny',
      expected: '`` abcd`x` ``\n\ny',
    },
    {
      name: 'code-start',
      source: '`abcd`',
      text: 'abcd',
      offset: 0,
      from: 1,
      input: '`x`\ny',
      expected: '`` `x` ``\n\n`yabcd`',
    },
    {
      name: 'bold-code',
      source: '**`abcd`**',
      text: 'abcd',
      offset: 2,
      from: 5,
      input: 'x\n`y`',
      expected: '**`abx`**\n\n**`` `y`cd ``**',
    },
    {
      name: 'list-code',
      source: '- `abcd`\n- tail',
      text: 'abcd',
      offset: 2,
      from: 5,
      input: 'x\n`y`',
      expected: '- `abx`\n- `` `y`cd ``\n- tail',
    },
    {
      name: 'code-spaces',
      source: '`a  b`',
      text: 'a  b',
      offset: 3,
      from: 4,
      input: '\n`y`',
      expected: '`a  `\n\n`` `y`b ``',
      native: '`a`  \n\n`` `y`b ``',
    },
  ]
  const parse = modelParser()
  const native = new Map()
  {
    await t.test('codemirror', async (t) => {
      const { app, page, folder } = await launch(t, 'codemirror')
      for (const item of cases)
        await t.test(item.name, async (t) => {
          const editor = await openFixture(
            app,
            page,
            folder,
            item.name,
            item.source,
            'codemirror',
          )
          await editor.focus()
          await editor.evaluate(
            (element, { engine, item }) => {
              if (engine === 'codemirror') {
                element.cmTile.root.view.dispatch({
                  selection: { anchor: item.from },
                })
                return
              }
              let position
              element.editor.state.doc.descendants((node, pos) => {
                if (node.isText && node.text === item.text)
                  position = pos + item.offset
              })
              if (position == null)
                throw new Error('Native code text was not found.')
              element.editor.commands.setTextSelection(position)
              element.editor.view.focus()
            },
            { engine: 'codemirror', item },
          )
          const before = await snapshot(page)
          assert.equal(before.source, item.source)

          await page.keyboard.insertText(item.input)
          const typed = await snapshot(page)
          assert.equal(typed.source, item.expected)
          assert.deepEqual(parse(typed.source), native.get(item.name))
          await t.test(
            'exact source and model after undo and redo',
            {
              todo: false,
            },
            () => assertHistory(app, page, before, typed),
          )
        })
    })
  }
})
