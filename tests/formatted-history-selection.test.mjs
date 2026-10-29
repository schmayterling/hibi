import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { electron, waitForDocumentEditor } from './electron.mjs'
import {
  selectFormattedEngine,
  testFormattedEngines as test,
} from './formatted-engine.mjs'
import { clickMenu, pressShortcut, withHeldClock } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const redo = process.platform === 'win32' ? 'Control+y' : `${mod}+Shift+z`

// Each range is picked between two points given as [word, offset in word].
const cases = [
  {
    name: 'plain paragraph range',
    source: 'alpha bravo charlie\n',
    anchor: ['bravo', 1],
    head: ['charlie', 2],
    typed: ['Z', 'Q'],
    after: 'alpha bZQarlie\n',
  },
  {
    name: 'cross-paragraph backward range',
    source: 'alpha bravo\n\ncharlie delta\n',
    anchor: ['delta', 2],
    head: ['bravo', 1],
    typed: ['Z', 'Q'],
    after: 'alpha bZQlta\n',
  },
  {
    name: 'range inside a list item',
    source: '- one two three\n- four\n',
    anchor: ['two', 1],
    head: ['three', 3],
    typed: ['Z'],
    after: '- one tZee\n- four\n',
  },
  {
    name: 'range replaced by composition',
    source: 'before chosen after\n',
    anchor: ['chosen', 0],
    head: ['chosen', 6],
    composed: ['日', '日本', '日本語'],
    after: 'before 日本語 after\n',
  },
  {
    name: 'range inside one table cell',
    // The native editor only edits tables in their serialized spelling.
    source:
      'plain\n\n| aa          | bb   |\n| ----------- | ---- |\n| alpha bravo | tail |\n',
    cell: true,
    anchor: ['alpha', 1],
    head: ['bravo', 2],
    typed: ['Z', 'Q'],
    after: 'plain\n\n| aa | bb |\n| --- | --- |\n| aZQavo | tail |\n',
  },
  {
    // The composition's group cancels out, so history steps over it to the
    // edit before it.
    name: 'earlier caret past a composition that restored its text',
    source: 'alpha bravo charlie\n',
    earlier: { at: ['bravo', 2], typed: 'X' },
    anchor: ['charlie', 0],
    head: ['charlie', 7],
    composed: ['日', '日本', 'charlie'],
    after: 'alpha brXavo charlie\n',
  },
  {
    // Typing and the deletions right after it are one step in either engine.
    name: 'range typed over and partly deleted',
    source: 'alpha bravo charlie\n',
    anchor: ['bravo', 1],
    head: ['charlie', 2],
    typed: ['Z', 'Q'],
    deleted: 1,
    after: 'alpha bZarlie\n',
  },
  {
    name: 'earlier caret past typing that its deletion took back',
    source: 'alpha bravo charlie\n',
    earlier: { at: ['bravo', 2], typed: 'X' },
    anchor: ['charlie', 0],
    head: ['charlie', 0],
    typed: ['Q'],
    deleted: 1,
    after: 'alpha brXavo charlie\n',
  },
  {
    name: 'range formatted bold',
    source: 'alpha bravo charlie\n',
    anchor: ['bravo', 1],
    head: ['charlie', 2],
    action: 'bold',
    after: 'alpha b**ravo ch**arlie\n',
  },
]

// History selections as offsets into the editor's visible text, the same
// logical place in either engine.
const selection = (page) =>
  page.evaluate(() => {
    const root = document.querySelector(
      '.rich-pane [aria-label="Document editor"]',
    )
    const visible = (range) => {
      const fragment = range.cloneContents()
      for (const node of fragment.querySelectorAll(
        '.hibi-lp-marker, .cm-placeholder, [aria-hidden="true"], label',
      ))
        node.remove()
      return fragment.textContent ?? ''
    }
    const offset = (node, at) => {
      if (!node || !root.contains(node)) return null
      const range = document.createRange()
      range.selectNodeContents(root)
      range.setEnd(node, at)
      return visible(range).length
    }
    const dom = getSelection()
    const model = root.editor
      ? root.editor.state.selection.toJSON()
      : root.cmTile.root.view.state.selection.main.toJSON()
    return {
      anchor: offset(dom.anchorNode, dom.anchorOffset),
      head: offset(dom.focusNode, dom.focusOffset),
      model,
    }
  })

for (const item of cases)
  test(`history restores the ${item.name} on undo and the edit selection on redo`, {
    timeout: 60000,
  }, async (t) => {
    const engine = t.formattedEngine
    const profile = await mkdtemp(join(tmpdir(), 'hibi-history-selection-'))
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
    await selectFormattedEngine(app, page, engine)
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    // Table padding follows each engine's serializer.
    const saved = (text) =>
      waitForAsync(
        page,
        async ({ text, cell }) => {
          await window.hibi.flushDocumentChanges()
          const spell = (text) =>
            cell ? text.replace(/ +/g, ' ').replace(/-+/g, '---') : text
          return (
            spell((await window.hibi.getDocument()).markdown) === spell(text)
          )
        },
        { text, cell: !!item.cell },
      ).catch(async (error) => {
        const { markdown } = await page.evaluate(() =>
          window.hibi.getDocument(),
        )
        assert.equal(markdown, text, 'saved')
        throw error
      })
    const settled = async () => {
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      )
      return selection(page)
    }
    const file = join(profile, 'note.md')
    await writeFile(file, item.source)
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      })
    }, file)
    await clickMenu(app, 'Open…')
    await waitForDocumentEditor(app, page)
    await saved(item.source)
    // The cell editor is another .cm-content.
    const root = page.locator('.rich-pane [aria-label="Document editor"]')
    const visibleText = () =>
      root.evaluate((root) => {
        const clone = root.cloneNode(true)
        for (const node of clone.querySelectorAll(
          '.hibi-lp-marker, .cm-placeholder, [aria-hidden="true"], label',
        ))
          node.remove()
        return clone.textContent
      })
    if (engine === 'codemirror')
      await root.evaluate((element) => element.cmTile.root.view.focus())
    else await root.focus()
    // Picks a DOM selection between two points, inside the cell editor when
    // the formatted view has one open.
    const pick = async (from, to) => {
      const text = await visibleText()
      if (item.cell && engine === 'codemirror') {
        // Only enter the cell here. The range itself is a DOM pick below.
        await root.evaluate(
          (element, at) =>
            element.cmTile.root.view.dispatch({ selection: { anchor: at } }),
          item.source.indexOf(from[0]) + from[1],
        )
        await page.waitForFunction(
          () =>
            document.activeElement?.getAttribute('aria-label') ===
              'Table cell' && document.activeElement.isContentEditable,
        )
      }
      // CodeMirror reverts a raw focus caret for a moment, so the pick repeats
      // until the model holds it.
      await page.waitForFunction(
        ({ anchor, head }) => {
          const root = document.querySelector(
            '.rich-pane [aria-label="Document editor"]',
          )
          const scope =
            root.querySelector('.hibi-lp-cell-editor .cm-content') ?? root
          const find = ([word, offset]) => {
            const walker = document.createTreeWalker(
              scope,
              NodeFilter.SHOW_TEXT,
            )
            while (walker.nextNode())
              if (walker.currentNode.data.includes(word))
                return [
                  walker.currentNode,
                  walker.currentNode.data.indexOf(word) + offset,
                ]
            return null
          }
          const model = root.editor
            ? root.editor.state.selection
            : root.cmTile.root.view.state.selection.main
          const dom = getSelection()
          const [anchorNode, anchorOffset] = find(anchor)
          const [focusNode, focusOffset] = find(head)
          const collapsed =
            anchorNode === focusNode && anchorOffset === focusOffset
          if (
            model.empty === collapsed &&
            dom.anchorNode === anchorNode &&
            dom.anchorOffset === anchorOffset &&
            dom.focusNode === focusNode &&
            dom.focusOffset === focusOffset
          )
            return true
          dom.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset)
          document.dispatchEvent(new Event('selectionchange'))
          return false
        },
        { anchor: from, head: to },
        { polling: 100 },
      )
      return [from, to].map(([word, offset]) => text.indexOf(word) + offset)
    }
    // An earlier edit, whose history step is the one undo and redo reach.
    let restored, reached
    if (item.earlier) {
      const [at] = await pick(item.earlier.at, item.earlier.at)
      await page.keyboard.insertText(item.earlier.typed)
      restored = [at, at]
      reached = [at + item.earlier.typed.length, at + item.earlier.typed.length]
      await saved(item.after)
    }
    const [anchor, head] = await pick(item.anchor, item.head),
      from = Math.min(anchor, head)
    const picked = await settled()
    t.diagnostic(JSON.stringify({ engine, phase: 'picked', ...picked }))
    assert.deepEqual([picked.anchor, picked.head], [anchor, head], 'picked')
    let length = 0
    if (item.action)
      await page
        .locator(`.editor-toolbar [data-toolbar-id="format.${item.action}"]`)
        .click()
    else if (item.composed) {
      for (const candidate of item.composed.slice(0, -1))
        await cdp.send('Input.imeSetComposition', {
          text: candidate,
          selectionStart: candidate.length,
          selectionEnd: candidate.length,
        })
      await cdp.send('Input.insertText', { text: item.composed.at(-1) })
      length = item.composed.at(-1).length
    }
    // Keys within the grouping window are one step, however slow the machine.
    else
      await withHeldClock(page, async () => {
        for (const typed of item.typed) {
          await page.keyboard.insertText(typed)
          length += typed.length
        }
        for (let left = item.deleted ?? 0; left; left--) {
          await page.keyboard.press('Backspace')
          length--
        }
      })
    await saved(item.after)
    // Typing leaves a caret after its text; formatting keeps the range.
    const left = item.action ? [anchor, head] : [from + length, from + length]
    const edited = await settled()
    t.diagnostic(JSON.stringify({ engine, phase: 'edited', ...edited }))
    assert.deepEqual([edited.anchor, edited.head], left, 'edit selection')
    await pressShortcut(app, `${mod}+z`)
    await saved(item.source)
    const undone = await settled()
    t.diagnostic(JSON.stringify({ engine, phase: 'undo', ...undone }))
    assert.deepEqual(
      [undone.anchor, undone.head],
      restored ?? [anchor, head],
      'undo',
    )
    await pressShortcut(app, redo)
    await saved(item.after)
    const redone = await settled()
    t.diagnostic(JSON.stringify({ engine, phase: 'redo', ...redone }))
    assert.deepEqual([redone.anchor, redone.head], reached ?? left, 'redo')
    await cdp.detach()
  })

// Like PM history, typing joins only the edit right before it.
const adjacency = [
  {
    name: 'typing joins only where the edit before it left off, as in CM and PM history',
    // An extension types in two places at once, with no selection between.
    edits: [
      [1, 'X'],
      [15, 'Y'],
    ],
    after: 'aXlpha bravo chYarlie\n',
    undone: ['aXlpha bravo charlie\n', 'alpha bravo charlie\n'],
  },
  {
    name: 'typing next to an earlier edit of its group but not the last one starts a new step',
    // B touches A's end; C touches A's start but not B.
    edits: [
      [1, 'X'],
      [2, 'Y'],
      [1, 'Z'],
    ],
    after: 'aZXYlpha bravo charlie\n',
    undone: ['aXYlpha bravo charlie\n', 'alpha bravo charlie\n'],
  },
]

for (const item of adjacency)
  test(item.name, { timeout: 60000 }, async (t) => {
    const engine = t.formattedEngine
    const profile = await mkdtemp(join(tmpdir(), 'hibi-history-adjacent-'))
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
    await selectFormattedEngine(app, page, engine)
    const file = join(profile, 'note.md')
    await writeFile(file, 'alpha bravo charlie\n')
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      })
    }, file)
    await clickMenu(app, 'Open…')
    await waitForDocumentEditor(app, page)
    const saved = (text) =>
      waitForAsync(
        page,
        async (text) => {
          await window.hibi.flushDocumentChanges()
          return (await window.hibi.getDocument()).markdown === text
        },
        text,
      )
    await saved('alpha bravo charlie\n')
    const root = page.locator('.rich-pane [aria-label="Document editor"]')
    await root.focus()
    await withHeldClock(page, () =>
      root.evaluate(
        (element, { engine, edits }) => {
          if (engine === 'codemirror') {
            const { view } = element.cmTile.root
            view.dispatch({ selection: { anchor: edits[0][0] } })
            for (const [from, insert] of edits)
              view.dispatch({
                changes: { from, insert },
                userEvent: 'input.type',
              })
          } else {
            const { view } = element.editor
            // One paragraph: its text starts one position into the document.
            element.editor.commands.setTextSelection(edits[0][0] + 1)
            for (const [from, insert] of edits)
              view.dispatch(view.state.tr.insertText(insert, from + 1))
          }
        },
        { engine, edits: item.edits },
      ),
    )
    await saved(item.after)
    for (const text of item.undone) {
      await pressShortcut(app, `${mod}+z`)
      await saved(text)
    }
    for (const text of [...item.undone.slice(0, -1).reverse(), item.after]) {
      await pressShortcut(app, redo)
      await saved(text)
    }
  })
