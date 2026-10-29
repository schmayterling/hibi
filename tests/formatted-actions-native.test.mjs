import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { Editor } from '@tiptap/core'
import { Strike } from '@tiptap/extension-strike'
import { TaskItem } from '@tiptap/extension-task-item'
import { TaskList } from '@tiptap/extension-task-list'
import { Markdown } from '@tiptap/markdown'
import { NativeTableKit } from '../src/addons/markdown/table-tokenizer.ts'
import { Subscript, Subtext } from '../src/addons/text-extras/nodes.ts'
import { richText } from '../src/addons/word-count/formatted-text.ts'
import { markdownConfiguration } from '../src/renderer/src/markdown.ts'
import { sameRichSourceDocument } from '../src/renderer/src/rich-source-preservation.ts'
import { parseRow } from '../src/shared/markdown-table-source.ts'
import { defaultNoteSyntax } from '../src/shared/note-syntax.ts'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { selectFormattedEngine } from './formatted-engine.mjs'
import { clickMenu, pressShortcut, withHeldClock } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const cases = [
  ...['bold', 'italic', 'strike', 'subscript', 'inline-code'].map((action) => ({
    name: `cell ${action}`,
    source: '| a | b |\n| --- | --- |\n| cell | 2 |',
    text: 'cell',
    offset: 1,
    action,
    cell: true,
  })),
  {
    name: 'mixed bold range',
    source: 'plain **bold** tail',
    text: 'plain',
    offset: 0,
    end: 'bold',
    endOffset: 4,
    action: 'bold',
  },
  {
    name: 'mixed code range',
    source: 'plain **bold** tail',
    text: 'plain',
    offset: 0,
    end: 'bold',
    endOffset: 4,
    action: 'inline-code',
  },
  {
    name: 'link beside bold',
    source: 'a **bold** z',
    text: 'bold',
    offset: 1,
    action: 'link',
  },
  {
    name: 'edit existing link',
    source: 'a [link](https://old.example) z',
    text: 'link',
    offset: 1,
    action: 'link',
  },
  {
    name: 'split bold divider',
    source: 'a **bold** z',
    text: 'bold',
    offset: 2,
    action: 'divider',
  },
  {
    name: 'split bold line break',
    source: 'a **bold** z',
    text: 'bold',
    offset: 2,
    action: 'hard-break',
  },
  {
    name: 'split heading table',
    source: '## alpha',
    text: 'alpha',
    offset: 2,
    action: 'table',
  },
  {
    name: 'split quote divider',
    source: '> alpha',
    text: 'alpha',
    offset: 2,
    action: 'divider',
  },
  {
    name: 'quote heading range',
    source: '> alpha\n>\n> beta',
    text: 'alpha',
    offset: 1,
    end: 'beta',
    endOffset: 2,
    action: 'heading-2',
  },
  {
    name: 'selected blocks code',
    source: '## alpha\n\nplain **bold**',
    all: true,
    action: 'code-block',
  },
  {
    name: 'selected blocks code physical key',
    source: '## alpha\n\nplain **bold**',
    all: true,
    action: 'code-block',
    physical: true,
  },
  {
    name: 'selected blocks code physical menu selection',
    source: '## alpha\n\nplain **bold**',
    all: true,
    selectionMenu: true,
    action: 'code-block',
    physical: true,
  },
  {
    name: 'selected text blocks code physical key',
    source: 'alpha\n\nplain bold',
    text: 'alpha',
    offset: 0,
    end: 'bold',
    endOffset: 4,
    action: 'code-block',
    physical: true,
  },
  {
    name: 'selected blocks code physical key after format history',
    source: '## alpha\n\nplain **bold**',
    all: true,
    action: 'code-block',
    physical: true,
    historyBeforeTyping: true,
  },
  {
    name: 'selected blocks code physical key after history',
    source: '## alpha\n\nplain **bold**',
    all: true,
    action: 'code-block',
    physical: true,
    repeatAfterHistory: true,
  },
  {
    name: 'selected blocks code physical key after new caret',
    source: '## alpha\n\nplain **bold**',
    all: true,
    action: 'code-block',
    physical: true,
    clearSelection: true,
  },
  {
    name: 'code to heading',
    source: '```js\nalpha\n```',
    text: 'alpha',
    offset: 2,
    action: 'heading-2',
  },
  {
    name: 'renumber and join',
    source: '- one\n- two\n  - nested\n\n1. next',
    text: 'two',
    offset: 1,
    action: 'numbered-list',
  },
  {
    name: 'nest item and children',
    source: '- one\n- two\n  - nested',
    text: 'two',
    offset: 1,
    action: 'indent',
  },
  {
    name: 'lift nested item',
    source: '- one\n  - nested\n- last',
    text: 'nested',
    offset: 2,
    action: 'outdent',
  },
  {
    name: 'convert tasks',
    source: '- one\n- two\n  - nested',
    text: 'two',
    offset: 1,
    action: 'checklist',
  },
  {
    name: 'empty heading pending source characterization',
    source: '',
    empty: true,
    action: 'heading-2',
    pendingHeading: true,
  },
  { name: 'empty code', source: '', empty: true, action: 'code-block' },
  {
    name: 'lift selected quote block',
    source: '> alpha\n>\n> beta\n>\n> gamma',
    text: 'beta',
    offset: 2,
    action: 'quote',
  },
  {
    name: 'canonical numbered indent',
    source: '1. one\n2. two',
    text: 'two',
    offset: 1,
    action: 'indent',
  },
  {
    name: 'canonical wide italic span',
    nextCharacter: true,
    source: '**take** rest',
    text: 'take',
    offset: 0,
    end: 'rest',
    endOffset: 4,
    action: 'italic',
  },
  {
    name: 'genuine select-all may replace noncanonical source',
    nextCharacter: true,
    source: '__take__ rest',
    all: true,
    action: 'italic',
  },
  ...[
    ['right', 'take *keep*', 'take', 0, 'keep', 0, 5],
    ['left', '*keep* take', 'take', -1, 'take', 4, 11],
  ].map(([side, source, text, offset, end, endOffset, sourceHead]) => ({
    name: `canonical touching italic ${side}`,
    source,
    text,
    offset,
    end,
    endOffset,
    sourceHead,
    action: 'italic',
  })),
  ...['**', '*'].map((mark) => ({
    name: `canonical selected link inside ${mark.length === 2 ? 'bold' : 'italic'}`,
    source: `${mark}take${mark} and ${mark}keep${mark}`,
    text: 'take',
    offset: 0,
    end: 'take',
    endOffset: 4,
    action: 'link',
  })),
  // These raw-source transactions are rejected by the production native guard.
  // Their intended formatted result is checked separately in formatted-toolbar-state.
  ...[
    {
      name: 'wide underscore',
      source: '__take__ rest',
      text: 'take',
      offset: 0,
      end: 'rest',
      endOffset: 4,
      action: 'italic',
      intended: '***take** rest*',
    },
    {
      name: 'link inside underscore',
      source: '__take__ and __keep__',
      text: 'take',
      offset: 0,
      end: 'take',
      endOffset: 4,
      action: 'link',
      intended: '[**take**](https://example.com) and __keep__',
    },
    {
      name: 'link inside italic underscore',
      source: '_take_ and _keep_',
      text: 'take',
      offset: 0,
      end: 'take',
      endOffset: 4,
      action: 'link',
      intended: '[*take*](https://example.com) and _keep_',
    },
    {
      name: 'right touching underscore',
      source: 'take _keep_',
      text: 'take',
      offset: 0,
      end: 'keep',
      endOffset: 0,
      action: 'italic',
      intended: '*take keep*',
    },
    {
      name: 'left touching underscore',
      source: '_keep_ take',
      text: 'take',
      offset: -1,
      end: 'take',
      endOffset: 4,
      action: 'italic',
      intended: '*keep take*',
    },
  ].map((item) => ({
    ...item,
    name: `native guard rejects ${item.name}`,
    nativeGuard: true,
  })),
  {
    name: 'unicode crlf block',
    source: '> α😀 beta\r\n>\r\n> tail',
    text: 'α😀 beta',
    offset: 3,
    action: 'heading-2',
  },
]
// Only the added typing proof ignores outer table padding and delimiter width.
// Cell contents, alignment, all other source, and each engine's exact history remain checked.
const cellSpelling = (source) =>
  source
    .split('\n')
    .map((line) =>
      /^\s*\|.*\|\s*$/.test(line)
        ? '|' +
          parseRow(line)
            .cells.map(({ from, to }) => {
              const text = line.slice(from, to)
              return /^:?-+:?$/.test(text) ? text.replace(/-+/g, '---') : text
            })
            .join('|') +
          '|'
        : line,
    )
    .join('\n')
const native = new Map()
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const configuration = markdownConfiguration([
  {
    id: 'github',
    markedOptions: { gfm: true },
    richExtensions: [
      Strike,
      NativeTableKit.configure({ table: { resizable: false } }),
      TaskList,
      TaskItem.configure({ nested: true }),
    ],
  },
  { id: 'text-extras', richExtensions: [Subscript, Subtext] },
])

async function snapshot(page) {
  const result = await page.evaluate(async () => {
    await window.hibi.flushDocumentChanges()
    const documentState = await window.hibi.getDocument()
    const root = document.querySelector(
      '.rich-pane [aria-label="Document editor"]',
    )
    const clean = (fragment) => {
      for (const node of fragment.querySelectorAll?.(
        '.hibi-lp-marker, .cm-placeholder, [aria-hidden="true"], label',
      ) ?? [])
        node.remove()
      return fragment.textContent ?? ''
    }
    const selection = getSelection()
    const at = (node, offset) => {
      const element =
        node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement
      let block = element?.closest('.cm-line, p, h1, h2, h3, h4, h5, h6, pre')
      if (
        node === root ||
        (block?.matches('.cm-line') &&
          !root.querySelector(
            '.hibi-lp-gap, .hibi-lp-heading, .hibi-lp-list-item, .hibi-lp-task, .hibi-lp-codeblock, table',
          ))
      )
        block = root
      if (!block || !node || !root.contains(node)) return null
      const before = document.createRange(),
        after = document.createRange()
      before.selectNodeContents(block)
      before.setEnd(node, offset)
      after.selectNodeContents(block)
      after.setStart(node, offset)
      return [clean(before.cloneContents()), clean(after.cloneContents())]
    }
    const styles = []
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode,
        parent = node.parentElement
      if (
        !node.data ||
        parent.closest(
          '.hibi-lp-marker, .cm-placeholder, [aria-hidden="true"], label',
        ) ||
        !parent.getClientRects().length
      )
        continue
      const css = getComputedStyle(parent)
      const value = {
        text: node.data,
        bold: Number(css.fontWeight) >= 600,
        italic: css.fontStyle === 'italic',
        strike: css.textDecorationLine.includes('line-through'),
        subscript: css.verticalAlign === 'sub',
        code: /mono/i.test(css.fontFamily),
      }
      const last = styles.at(-1)
      if (
        last &&
        Object.keys(value).every(
          (key) => key === 'text' || value[key] === last[key],
        )
      )
        last.text += value.text
      else styles.push(value)
    }
    const text = clean(root.cloneNode(true)),
      selected = selection?.rangeCount
        ? clean(selection.getRangeAt(0).cloneContents())
        : ''
    const all = !selection?.isCollapsed && selected === text
    return {
      source: documentState.markdown,
      version: documentState.contentVersion,
      selectionDebug: root.editor
        ? root.editor.state.selection.toJSON()
        : {
            model: root.cmTile.root.view.state.selection.toJSON(),
            length: root.cmTile.root.view.state.doc.length,
            domAnchor:
              selection?.anchorNode &&
              root.cmTile.root.view.posAtDOM(
                selection.anchorNode,
                selection.anchorOffset,
              ),
            domHead:
              selection?.focusNode &&
              root.cmTile.root.view.posAtDOM(
                selection.focusNode,
                selection.focusOffset,
              ),
            selected,
          },
      model: root.editor?.state.doc.toJSON() ?? null,
      headingLevels: [
        ...root.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]'),
      ].map((node) =>
        Number(node.getAttribute('aria-level') ?? node.tagName.slice(1)),
      ),
      text,
      caret: {
        anchor: all
          ? ['', text]
          : at(selection?.anchorNode, selection?.anchorOffset ?? 0),
        head: all
          ? [text, '']
          : at(selection?.focusNode, selection?.focusOffset ?? 0),
        empty: selection?.isCollapsed,
      },
      styles,
      count:
        document.querySelector('[data-status-id="word-count.total"]')
          ?.textContent ?? null,
      inputs: window.actionInputs.slice(),
    }
  })
  const label = await page.evaluate(
    (text) => {
      let words = 0,
        characters = 0
      for (const part of new Intl.Segmenter(undefined, {
        granularity: 'word',
      }).segment(text))
        if (part.isWordLike) words++
      for (const _part of new Intl.Segmenter(undefined, {
        granularity: 'grapheme',
      }).segment(text))
        characters++
      return `${words.toLocaleString()} ${words === 1 ? 'word' : 'words'} · ${characters.toLocaleString()} ${characters === 1 ? 'character' : 'characters'}`
    },
    richText(result.source, {
      ...defaultNoteSyntax,
      textExtras: true,
      alerts: true,
    }).slice(1),
  )
  try {
    await page.waitForFunction(
      (label) =>
        document.querySelector('[data-status-id="word-count.total"]')
          ?.textContent === label,
      label,
    )
  } catch (error) {
    error.message += JSON.stringify({
      result,
      expectedCount: label,
      actualCount: await page
        .locator('[data-status-id="word-count.total"]')
        .textContent(),
    })
    throw error
  }
  result.count = label
  return result
}

for (const engine of ['tiptap', 'codemirror'])
  test(`${engine}: toolbar actions preserve native formatting, caret and history`, {
    timeout: 180000,
  }, async (t) => {
    const profile = await mkdtemp(join(tmpdir(), 'hibi-formatting-actions-'))
    await writeFile(
      join(profile, 'addons.json'),
      JSON.stringify({ 'word-count': true, 'text-extras': true }),
    )
    const app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${profile}`],
    })
    let cdp, oracle
    t.after(async () => {
      oracle?.destroy()
      await cdp?.detach()
      await app.close()
      await rm(profile, { recursive: true, force: true })
    })
    const page = await app.firstWindow()
    page.setDefaultTimeout(7000)
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await selectFormattedEngine(app, page, engine)
    const rich = page.getByRole('textbox', {
      name: 'Document editor',
      exact: true,
    })
    cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    oracle = new Editor({
      element: null,
      extensions: [
        ...configuration.core,
        Markdown.configure({
          marked: configuration.parser,
          markedOptions: configuration.options,
        }),
        ...configuration.addons,
      ],
      content: 'seed',
      contentType: 'markdown',
    })
    const history = async (expected, redo = false) => {
      await pressShortcut(
        app,
        redo
          ? process.platform === 'win32'
            ? 'Control+y'
            : `${mod}+Shift+z`
          : `${mod}+z`,
      )
      await waitForAsync(
        page,
        async (source) => {
          await window.hibi.flushDocumentChanges()
          return (await window.hibi.getDocument()).markdown === source
        },
        expected,
      )
      const restored = await snapshot(page)
      assert.equal(restored.source, expected)
      return restored
    }
    for (const item of cases.filter(
      (item) => !item.nativeGuard || engine === 'tiptap',
    ))
      await t.test(item.name, async () => {
        const file = join(profile, `${item.name}.md`)
        let source = item.source
        if (item.cell) {
          oracle.commands.setContent(source, {
            contentType: 'markdown',
            emitUpdate: false,
          })
          source = oracle.getMarkdown()
        }
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
          `${item.name}.md`,
        )
        await waitForDocumentEditor(app, page)
        await rich.focus()
        await rich.evaluate(
          (root, { item, engine }) => {
            window.actionInputs = []
            window.formattingGuard = null
            root.oninput = (event) =>
              window.actionInputs.push({
                type: event.inputType,
                data: event.data,
              })
            if (engine === 'tiptap') {
              const editor = root.editor
              const position = (word, offset) => {
                let found
                editor.state.doc.descendants((node, pos) => {
                  if (
                    found === undefined &&
                    node.isText &&
                    node.text.includes(word)
                  )
                    found = pos + node.text.indexOf(word) + offset
                })
                if (found === undefined)
                  throw new Error(`missing native text: ${word}`)
                return found
              }
              if (item.all && !item.selectionMenu) editor.commands.selectAll()
              else if (item.empty || item.selectionMenu)
                editor.commands.setTextSelection(1)
              else
                editor.commands.setTextSelection({
                  from: position(item.text, item.offset),
                  to: item.end
                    ? position(item.end, item.endOffset)
                    : position(item.text, item.offset),
                })
            } else {
              const view = root.cmTile.root.view,
                source = view.state.doc.toString()
              view.dispatch({
                selection:
                  item.all && !item.selectionMenu
                    ? { anchor: 0, head: source.length }
                    : item.empty || item.selectionMenu
                      ? { anchor: 0 }
                      : {
                          anchor: source.indexOf(item.text) + item.offset,
                          head:
                            item.sourceHead ??
                            (item.end
                              ? source.indexOf(item.end) + item.endOffset
                              : source.indexOf(item.text) + item.offset),
                        },
                scrollIntoView: true,
              })
            }
          },
          { item, engine },
        )
        if (item.all && !item.selectionMenu)
          await page.keyboard.press(`${mod}+a`)
        if (item.selectionMenu) {
          await rich.evaluate((element) =>
            element.editor
              ? element.editor.view.focus()
              : element.cmTile.root.view.focus(),
          )
          await app.evaluate(({ BrowserWindow, Menu }) => {
            const window = BrowserWindow.getAllWindows()[0]
            const item = Menu.getApplicationMenu()
              .items.find((item) => item.label === 'Edit')
              .submenu.items.find(
                (item) => item.role?.toLowerCase() === 'selectall',
              )
            if (!item) throw new Error('missing select all menu')
            window.webContents.selectAll()
          })
          await page.waitForFunction(() => {
            const root = document.querySelector(
              '.rich-pane [aria-label="Document editor"]',
            )
            return root.editor
              ? !root.editor.state.selection.empty
              : !root.cmTile.root.view.state.selection.main.empty
          })
        }
        if (item.cell && engine === 'codemirror') {
          await page.locator('td').filter({ hasText: 'cell' }).click()
          const cell = page.getByRole('textbox', {
            name: 'Table cell',
            exact: true,
          })
          await cell.waitFor()
          await cell.evaluate((element) => {
            const view = element.cmTile.root.view
            view.dispatch({
              selection: {
                anchor: view.state.doc.toString().indexOf('cell') + 1,
              },
            })
            view.focus()
          })
        }
        if (engine === 'tiptap') {
          await rich.evaluate((element) => element.editor.view.focus())
          await page.waitForFunction(() => {
            const editor = document.querySelector(
                '.rich-pane [aria-label="Document editor"]',
              ).editor,
              selection = getSelection()
            return (
              selection?.focusNode &&
              editor.view.posAtDOM(
                selection.focusNode,
                selection.focusOffset,
              ) === editor.state.selection.head &&
              editor.view.posAtDOM(
                selection.anchorNode,
                selection.anchorOffset,
              ) === editor.state.selection.anchor
            )
          })
          if (item.cell)
            assert.equal(
              (await page.evaluate(() => window.hibi.getDocument())).markdown,
              await rich.evaluate((element) => element.editor.getMarkdown()),
            )
        }
        const before = await snapshot(page)
        if (item.nativeGuard)
          await rich.evaluate((element) => {
            const editor = element.editor
            window.formattingGuard = { attempted: [], accepted: [] }
            if (!editor.formattingGuardWrapped) {
              const dispatch = editor.view.dispatch.bind(editor.view)
              editor.view.dispatch = (transaction) => {
                if (transaction.docChanged && window.formattingGuard)
                  window.formattingGuard.attempted.push({
                    model: transaction.doc.toJSON(),
                    selection: transaction.selection.toJSON(),
                  })
                return dispatch(transaction)
              }
              editor.on('transaction', ({ transaction }) => {
                if (transaction.docChanged && window.formattingGuard)
                  window.formattingGuard.accepted.push(editor.getJSON())
              })
              editor.formattingGuardWrapped = true
            }
          })
        const button = page.locator(
          `.editor-toolbar [data-toolbar-id="format.${item.action}"]`,
        )
        if (await button.isVisible()) await button.click()
        else
          await button.evaluate((button) => {
            if (button.disabled) throw new Error('unavailable format action')
            button.click()
          })
        if (item.action === 'link') {
          await page
            .getByLabel('Link destination', { exact: true })
            .fill('https://example.com')
          await page
            .getByRole('button', { name: 'Insert', exact: true })
            .click()
          await page
            .getByRole('dialog', { name: 'Insert link', exact: true })
            .waitFor({ state: 'hidden' })
        }
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        )
        const focus = async () => {
          const cell = page.getByRole('textbox', {
            name: 'Table cell',
            exact: true,
          })
          if (await cell.count()) await cell.focus()
          else if (engine === 'tiptap')
            await rich.evaluate((element) => element.editor.view.focus())
          else await rich.focus()
        }
        await focus()
        const action = await snapshot(page)
        t.diagnostic(
          JSON.stringify({
            engine,
            name: item.name,
            phase: 'action',
            before: before.source,
            ...action,
          }),
        )
        if (item.nativeGuard) {
          assert.equal(engine, 'tiptap')
          await page.waitForFunction(() =>
            document
              .querySelector('.rich-pane .document-notice')
              ?.textContent.includes('This edit would rewrite other Markdown.'),
          )
          const guard = await rich.evaluate(() => ({
            ...structuredClone(window.formattingGuard),
            notices: Array.from(
              document.querySelectorAll('.rich-pane .document-notice'),
            ).map((node) => node.textContent),
          }))
          t.diagnostic(
            JSON.stringify({ name: item.name, before, action, guard }),
          )
          assert.equal(before.source, item.source)
          assert.equal(before.version, 0)
          assert.equal(before.selectionDebug.type, 'text')
          assert.deepEqual(guard.attempted, [
            {
              model: JSON.parse(
                JSON.stringify(
                  oracle.schema
                    .nodeFromJSON(oracle.markdown.parse(item.intended))
                    .toJSON(),
                ),
              ),
              selection: before.selectionDebug,
            },
          ])
          assert.notDeepEqual(guard.attempted[0].model, before.model)
          assert.deepEqual(guard.accepted, [])
          assert.deepEqual(guard.notices, [
            'Edit could not be appliedThis edit would rewrite other Markdown. Use Source view for this document.',
          ])
          for (const key of [
            'source',
            'version',
            'model',
            'selectionDebug',
            'styles',
            'text',
            'count',
            'caret',
          ])
            assert.deepEqual(action[key], before[key], key)
          assert.deepEqual(action.inputs, [])
          return
        }
        if (item.pendingHeading) {
          assert.deepEqual(action.headingLevels, [2])
          if (engine === 'tiptap') {
            assert.equal(action.source, '')
            assert.equal(action.version, 0)
          }
        }
        if (engine === 'tiptap') native.set(item.name, { action })
        else {
          const expected = native.get(item.name).action
          if (!item.pendingHeading) assert.equal(action.source, expected.source)
          assert.deepEqual(action.headingLevels, expected.headingLevels)
          const model = oracle.schema.nodeFromJSON(
            oracle.markdown.parse(action.source),
          )
          assert.ok(
            sameRichSourceDocument(
              model,
              oracle.schema.nodeFromJSON(expected.model),
              true,
            ),
            JSON.stringify({
              actual: model.toJSON(),
              expected: expected.model,
            }),
          )
          assert.equal(action.text, expected.text)
          assert.deepEqual(action.styles, expected.styles)
          assert.deepEqual(action.caret, expected.caret)
          assert.equal(action.count, expected.count)
        }
        assert.equal(
          action.version - before.version,
          action.source === before.source ? 0 : 1,
        )
        assert.deepEqual(action.inputs, [])
        if (item.historyBeforeTyping) {
          const undone = await history(before.source)
          assert.equal(undone.caret.empty, false)
          const redone = await history(action.source, true)
          assert.deepEqual(redone.caret, action.caret)
          if (engine === 'tiptap')
            assert.equal(redone.selectionDebug.type, 'all')
        }
        if (engine === 'tiptap') {
          // Isolate the next typing edit while retaining the live selection and pending marks.
          await rich.evaluate((element) => {
            const editor = element.editor,
              selection = editor.state.selection,
              marks = editor.state.storedMarks
            if (selection.toJSON().type === 'all') {
              let first
              editor.state.doc.descendants((node, pos) => {
                if (first === undefined && node.isTextblock) first = pos + 1
              })
              editor.commands.setTextSelection(first)
            } else editor.commands.selectAll()
            editor.view.dispatch(
              editor.state.tr.setSelection(selection).setStoredMarks(marks),
            )
            editor.view.focus()
          })
          assert.deepEqual((await snapshot(page)).caret, action.caret)
        }
        if (item.clearSelection) {
          await rich.evaluate((element, engine) => {
            if (engine === 'tiptap') {
              let at
              element.editor.state.doc.descendants((node, pos) => {
                if (
                  at === undefined &&
                  node.isText &&
                  node.text.includes('alpha')
                )
                  at = pos + node.text.indexOf('alpha') + 1
              })
              element.editor.commands.setTextSelection(at)
              element.editor.view.focus()
            } else {
              const view = element.cmTile.root.view
              view.dispatch({
                selection: {
                  anchor: view.state.doc.toString().indexOf('alpha') + 1,
                },
              })
              view.focus()
            }
          }, engine)
        }
        await focus()
        const typingVersion = (await snapshot(page)).version
        const typedText =
          item.nextCharacter || item.cell || item.action === 'table'
            ? 'ZQ'
            : 'Z'
        // One undo step, however slow the machine.
        await withHeldClock(page, async () => {
          if (item.physical) await page.keyboard.type(typedText)
          else
            for (const character of typedText)
              await page.keyboard.insertText(character)
        })
        await waitForAsync(page, () => {
          const root = document.querySelector(
            '.rich-pane [aria-label="Document editor"]',
          )
          return root.editor
            ? root.editor.state.doc.textContent.includes('Z')
            : root.cmTile.root.view.state.doc.toString().includes('Z')
        })
        const typed = await snapshot(page)
        t.diagnostic(
          JSON.stringify({ engine, name: item.name, phase: 'typed', ...typed }),
        )
        if (engine === 'tiptap') native.get(item.name).typed = typed
        else {
          const expected = native.get(item.name).typed
          assert.equal(
            item.cell || item.action === 'table'
              ? cellSpelling(typed.source)
              : typed.source,
            item.cell || item.action === 'table'
              ? cellSpelling(expected.source)
              : expected.source,
          )
          const model = oracle.schema.nodeFromJSON(
            oracle.markdown.parse(typed.source),
          )
          assert.ok(
            sameRichSourceDocument(
              model,
              oracle.schema.nodeFromJSON(expected.model),
              true,
            ),
          )
          assert.deepEqual(typed.caret, expected.caret)
          assert.equal(typed.text, expected.text)
          assert.deepEqual(typed.styles, expected.styles)
          assert.equal(typed.count, expected.count)
        }
        assert.equal(typed.version, typingVersion + typedText.length)
        assert.deepEqual(
          typed.inputs,
          item.physical &&
            !item.clearSelection &&
            (engine === 'tiptap' || (item.all && !item.selectionMenu))
            ? []
            : Array.from(typedText, (data) => ({ type: 'insertText', data })),
        )
        const undone = await history(action.source)
        if (item.repeatAfterHistory) {
          t.diagnostic(
            JSON.stringify({
              engine,
              name: item.name,
              phase: 'undo-typed',
              ...undone,
            }),
          )
          if (engine === 'tiptap') native.get(item.name).undone = undone
          else
            assert.deepEqual(undone.caret, native.get(item.name).undone.caret)
        }
        await history(typed.source, true)
        if (action.source !== before.source) {
          await history(action.source)
          await history(before.source)
          await history(action.source, true)
        }
        if (item.repeatAfterHistory) {
          await focus()
          const restored = await snapshot(page)
          t.diagnostic(
            JSON.stringify({
              engine,
              name: item.name,
              phase: 'restored',
              ...restored,
            }),
          )
          if (engine === 'tiptap') native.get(item.name).restored = restored
          else
            assert.deepEqual(
              restored.caret,
              native.get(item.name).restored.caret,
            )
          await page.keyboard.type('Q')
          const retyped = await snapshot(page)
          t.diagnostic(
            JSON.stringify({
              engine,
              name: item.name,
              phase: 'retyped',
              ...retyped,
            }),
          )
          if (engine === 'tiptap') native.get(item.name).retyped = retyped
          else {
            const expected = native.get(item.name).retyped
            assert.equal(retyped.source, expected.source)
            assert.ok(
              sameRichSourceDocument(
                oracle.schema.nodeFromJSON(
                  oracle.markdown.parse(retyped.source),
                ),
                oracle.schema.nodeFromJSON(expected.model),
                true,
              ),
            )
            assert.deepEqual(retyped.caret, expected.caret)
            assert.deepEqual(retyped.styles, expected.styles)
            assert.equal(retyped.text, expected.text)
            assert.equal(retyped.count, expected.count)
            assert.deepEqual(retyped.inputs, expected.inputs)
          }
          assert.equal(retyped.version, restored.version + 1)
          await history(restored.source)
          await history(retyped.source, true)
        }
      })
  })
