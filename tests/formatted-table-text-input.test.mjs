// Actual DOM range routing for the combined formatting/table integration proof.
export const formattingDOMCases = [
  {
    name: 'paragraph into active cell',
    anchor: { text: 'plain', offset: 1, cell: false },
    head: { text: 'cell', offset: 2, cell: true },
    selected: 'lainaabbce',
    action: 'bold',
  },
  {
    name: 'body cell into active sibling cell',
    anchor: { text: 'cell', offset: 1, cell: true },
    head: { text: 'tail', offset: 2, cell: true },
    selected: 'ellta',
    action: 'italic',
  },
]

export async function selectFormattingDOMRange(
  page,
  rich,
  engine,
  item,
  source,
  reverse = false,
) {
  await rich.focus()
  if (engine === 'codemirror') {
    // Only enter the cell here. The nonempty range below must come from DOM selection.
    await rich.evaluate(
      (element, at) =>
        element.cmTile.root.view.dispatch({
          selection: { anchor: at },
          scrollIntoView: true,
        }),
      source.indexOf(item.head.text) + item.head.offset,
    )
    await page
      .getByRole('textbox', { name: 'Table cell', exact: true })
      .waitFor()
    await page.waitForFunction(
      () =>
        document.activeElement?.getAttribute('aria-label') === 'Table cell' &&
        document.activeElement.isContentEditable,
    )
  } else {
    await rich.evaluate((element) => element.editor.view.focus())
    const synced = await rich.evaluate(async (element) => {
      await window.hibi.flushDocumentChanges()
      return (
        (await window.hibi.getDocument()).markdown ===
        element.editor.getMarkdown()
      )
    })
    if (!synced) throw new Error('native source is not current')
  }
  const selected = await rich.evaluate(
    (element, { item, engine, reverse }) => {
      const active =
        engine === 'codemirror'
          ? element.querySelector('.hibi-lp-cell-editor .cm-content')
          : element
      const find = (root, point) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        while (walker.nextNode()) {
          const node = walker.currentNode
          if (
            node.parentElement.closest('.hibi-lp-marker, [aria-hidden="true"]')
          )
            continue
          if (
            node.data.trim() === point.text &&
            !!node.parentElement.closest('th, td') === point.cell
          )
            return {
              node,
              offset: node.data.indexOf(point.text) + point.offset,
            }
        }
        return null
      }
      const start = find(element, item.anchor),
        end = active && find(active, item.head)
      if (!start || !end) return false
      const a = reverse ? end : start,
        b = reverse ? start : end
      getSelection().setBaseAndExtent(a.node, a.offset, b.node, b.offset)
      // A pointer pick moves focus out of the cell editor, and the view reads
      // it in that turn. A reverse pick here leaves the editor focused with
      // the anchor in it, so a measure before the page reports the pick
      // would let the editor draw its caret over it.
      if (engine === 'codemirror')
        document.dispatchEvent(new Event('selectionchange'))
      return true
    },
    { item, engine, reverse },
  )
  if (!selected) throw new Error('rendered range endpoints are missing')
  const start = source.indexOf(item.anchor.text) + item.anchor.offset,
    end = source.indexOf(item.head.text) + item.head.offset
  await page.waitForFunction(
    ({ engine, anchor, head, selected }) => {
      const element = document.querySelector(
          '.rich-pane [aria-label="Document editor"]',
        ),
        dom = getSelection()
      if (
        !element ||
        !dom?.anchorNode ||
        !dom.focusNode ||
        !element.contains(dom.anchorNode) ||
        !element.contains(dom.focusNode) ||
        dom.toString().replace(/\s/g, '') !== selected
      )
        return false
      if (engine === 'codemirror') {
        const range = element.cmTile.root.view.state.selection.main
        return range.anchor === anchor && range.head === head
      }
      const editor = element.editor
      return (
        editor.state.selection.toJSON().type === 'text' &&
        editor.state.selection.anchor ===
          editor.view.posAtDOM(dom.anchorNode, dom.anchorOffset) &&
        editor.state.selection.head ===
          editor.view.posAtDOM(dom.focusNode, dom.focusOffset)
      )
    },
    {
      engine,
      anchor: reverse ? end : start,
      head: reverse ? start : end,
      selected: item.selected,
    },
  )
}

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
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
import { parseRow } from '../src/shared/markdown-table-source.ts'
import { defaultNoteSyntax } from '../src/shared/note-syntax.ts'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { selectFormattedEngine } from './formatted-engine.mjs'
import { clickMenu } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const cases = formattingDOMCases.flatMap((item) =>
  [false, true].map((reverse) => ({
    ...item,
    name: `dom ${item.name} ${reverse ? 'reverse' : 'forward'}`,
    source: 'plain\n\n| aa | bb |\n| --- | --- |\n| cell | tail |',
    domPick: true,
    reverse,
    canonical: true,
    tableRange: true,
    nextCharacter: true,
  })),
)
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
      countText: root.editor?.getText({ blockSeparator: '\n' }) ?? null,
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
    // Both engines count the canonical source, as a fresh reload shows it.
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
  test(engine + ': raw partial DOM range replacement and per-event history', {
    timeout: 180000,
  }, async (t) => {
    const profile = await mkdtemp(join(tmpdir(), 'hibi-raw-dom-paired-'))
    await writeFile(
      join(profile, 'addons.json'),
      JSON.stringify({ 'word-count': true, 'text-extras': true }),
    )
    const app = await electron.launch({
      args: [resolve('.'), '--user-data-dir=' + profile],
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
    const settle = () =>
      page.evaluate(async () => {
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        )
        await window.hibi.flushDocumentChanges()
      })
    const open = async (file, content) => {
      await writeFile(file, content)
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
        basename(file),
      )
      await waitForDocumentEditor(app, page)
      await waitForAsync(
        page,
        async (content) => {
          await window.hibi.flushDocumentChanges()
          return (await window.hibi.getDocument()).markdown === content
        },
        content,
      )
      // A raw focus of CodeMirror's content puts Chromium's caret at its
      // start, which CodeMirror reverts only for 200 ms; its view draws its
      // own selection as it takes focus.
      if (engine === 'codemirror')
        await rich.evaluate((element) => element.cmTile.root.view.focus())
      else await rich.focus()
      await rich.evaluate(() => {
        window.actionInputs = []
        if (!window.rawDOMInputsInstalled) {
          document.addEventListener(
            'input',
            (event) => {
              const root = document.querySelector(
                '.rich-pane [aria-label="Document editor"]',
              )
              if (root?.contains(event.target))
                window.actionInputs.push({
                  type: event.inputType,
                  data: event.data,
                })
            },
            true,
          )
          window.rawDOMInputsInstalled = true
        }
      })
    }
    const menuHistory = async (label) => {
      await app.evaluate(
        ({ BrowserWindow, Menu }, { label, url }) => {
          const window = BrowserWindow.getAllWindows().find(
            (window) => window.webContents.getURL() === url,
          )
          if (!window) throw new Error('document window is missing')
          const item = Menu.getApplicationMenu()
            .items.find((item) => item.label === 'Edit')
            .submenu.items.find((item) => item.label === label)
          if (!item?.enabled) throw new Error('history menu item unavailable')
          item.click(item, window, window.webContents)
        },
        { label, url: page.url() },
      )
      await settle()
    }
    for (const item of cases)
      await t.test(item.name, async () => {
        oracle.commands.setContent(item.source, {
          contentType: 'markdown',
          emitUpdate: false,
        })
        const source = oracle.getMarkdown()
        await open(join(profile, item.name + '.md'), source)
        const before = await snapshot(page)
        await selectFormattingDOMRange(
          page,
          rich,
          engine,
          item,
          source,
          item.reverse,
        )
        const selected = await snapshot(page)
        assert.equal(selected.source, before.source)
        assert.equal(selected.version, before.version)
        assert.equal(selected.caret.empty, false)
        const button = page.locator(
          '.editor-toolbar [data-toolbar-id="format.' + item.action + '"]',
        )
        if (await button.isVisible()) await button.click()
        else
          await button.evaluate((button) => {
            if (button.disabled) throw new Error('unavailable format action')
            button.click()
          })
        await settle()
        const observed = {}
        const record = async (phase) => {
          await settle()
          const value = await snapshot(page)
          value.canonicalModel = JSON.parse(
            JSON.stringify(
              oracle.schema
                .nodeFromJSON(oracle.markdown.parse(value.source))
                .toJSON(),
            ),
          )
          observed[phase] = value
          t.diagnostic(
            JSON.stringify({
              engine,
              name: item.name,
              phase,
              ...value,
            }),
          )
          return value
        }
        const action = await record('action')
        assert.notEqual(action.source, source)
        assert.equal(action.version, before.version + 1)
        assert.equal(action.caret.empty, false)
        assert.deepEqual(action.inputs, [])
        if (engine === 'tiptap') {
          assert.notDeepEqual(action.model, before.model)
          native.set(item.name, observed)
        } else {
          const expected = native.get(item.name).action
          for (const key of ['source', 'canonicalModel', 'text', 'styles'])
            assert.deepEqual(action[key], expected[key], 'action ' + key)
        }
        // Preserve actual post-toolbar DOM range. No selectAll/selection reset/focus
        // dispatch separates the action from either raw insertion.
        await page.keyboard.insertText('Z')
        const first = await record('Z')
        assert.equal(first.version, action.version + 1)
        assert.deepEqual(first.inputs, [{ type: 'insertText', data: 'Z' }])
        await page.keyboard.insertText('Q')
        const second = await record('Q')
        assert.equal(second.version, first.version + 1)
        assert.deepEqual(second.inputs, [
          { type: 'insertText', data: 'Z' },
          { type: 'insertText', data: 'Q' },
        ])
        // Keep each history event's full snapshot. Native source-history echoes
        // may add the canonical empty header; undo-Q is not assumed model-equal to Z.
        for (const [label, phase] of [
          ['Undo', 'undoQ'],
          ['Undo', 'undoZ'],
          ['Undo', 'undoFormat'],
          ['Redo', 'redoFormat'],
          ['Redo', 'redoZ'],
          ['Redo', 'redoQ'],
        ]) {
          await menuHistory(label)
          await record(phase)
        }
        await page.keyboard.insertText('R')
        await record('R')
        await menuHistory('Undo')
        await record('undoR')
        await menuHistory('Redo')
        const final = await record('redoR')
        // Fresh reload has its own full canonical model/count/source witness.
        await open(join(profile, item.name + '-fresh.md'), final.source)
        const fresh = await record('fresh')
        assert.equal(fresh.source, final.source)
        assert.equal(fresh.version, 0)
        if (engine === 'tiptap')
          assert.deepEqual(fresh.model, fresh.canonicalModel)
        // Owner contract: stable logical behavior in both engines; native quirks are fixed, not copied.
        const point = ({ text, offset }) => [
            text.slice(0, offset),
            text.slice(offset),
          ],
          caret = (at) => ({ anchor: at, head: at, empty: true }),
          logical = []
        const expect = (phase, expected) => {
          try {
            assert.deepEqual(observed[phase].caret, expected)
          } catch {
            logical.push(phase + ': caret')
          }
        }
        // Formatting keeps the picked range.
        expect('action', {
          anchor: point(item.reverse ? item.head : item.anchor),
          head: point(item.reverse ? item.anchor : item.head),
          empty: false,
        })
        // Typing leaves the caret right after the typed text.
        for (const [phase, typed] of [
          ['Z', 'Z'],
          ['Q', 'ZQ'],
          ['R', 'ZQR'],
        ]) {
          const { anchor } = observed[phase].caret
          if (!anchor?.[0].endsWith(typed)) logical.push(phase + ': typed')
          expect(phase, caret(anchor))
        }
        // Undo restores the caret the edit was typed at; redo the caret it left.
        for (const [phase, at] of [
          ['undoQ', 'Z'],
          ['redoZ', 'Z'],
          ['redoQ', 'Q'],
          ['undoR', 'redoQ'],
          ['redoR', 'R'],
        ])
          expect(phase, observed[at].caret)
        // History restores a picked range as a caret at its upper end.
        for (const phase of ['undoZ', 'undoFormat', 'redoFormat'])
          expect(phase, caret(point(item.head)))
        t.diagnostic(JSON.stringify({ engine, name: item.name, logical }))
        if (engine === 'codemirror') {
          const expected = native.get(item.name),
            differences = []
          for (const [phase, actual] of Object.entries(observed)) {
            const baseline = expected[phase]
            if (!baseline) {
              differences.push(phase + ': missing native witness')
              continue
            }
            // Fresh-open carets differ before any edit (native ends in the last
            // block, CodeMirror at the source end); that comparison stays paired.
            for (const key of [
              'canonicalModel',
              'text',
              'styles',
              ...(phase === 'fresh' ? ['caret'] : []),
              'inputs',
            ])
              try {
                assert.deepEqual(actual[key], baseline[key])
              } catch {
                differences.push(phase + ': ' + key)
              }
            if (cellSpelling(actual.source) !== cellSpelling(baseline.source))
              differences.push(phase + ': source cell contents/alignment')
            if (actual.version !== baseline.version)
              differences.push(phase + ': version')
          }
          assert.deepEqual(differences, [], 'raw paired differences')
        }
        assert.deepEqual(logical, [], 'logical carets')
      })
  })
