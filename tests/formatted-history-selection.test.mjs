import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { electron, waitForDocumentEditor } from './electron.mjs'
import {
  selectFormattedEngine,
  testFormattedEngines as test,
} from './formatted-engine.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
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
    const rich = await selectFormattedEngine(app, page, engine)
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    const saved = (text) =>
      waitForAsync(
        page,
        async (text) => {
          await window.hibi.flushDocumentChanges()
          return (await window.hibi.getDocument()).markdown === text
        },
        text,
      )
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
    const text = await rich.evaluate((root) => {
      const clone = root.cloneNode(true)
      for (const node of clone.querySelectorAll(
        '.hibi-lp-marker, .cm-placeholder, [aria-hidden="true"], label',
      ))
        node.remove()
      return clone.textContent
    })
    const point = ([word, offset]) => text.indexOf(word) + offset
    const anchor = point(item.anchor),
      head = point(item.head),
      from = Math.min(anchor, head)
    if (engine === 'codemirror')
      await rich.evaluate((element) => element.cmTile.root.view.focus())
    else await rich.focus()
    // CodeMirror reverts a raw focus caret for a moment, so the pick repeats
    // until the model holds it.
    await page.waitForFunction(
      ({ anchor, head }) => {
        const root = document.querySelector(
          '.rich-pane [aria-label="Document editor"]',
        )
        const find = ([word, offset]) => {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
          while (walker.nextNode())
            if (walker.currentNode.data.includes(word))
              return [
                walker.currentNode,
                walker.currentNode.data.indexOf(word) + offset,
              ]
          return null
        }
        const empty = root.editor
          ? root.editor.state.selection.empty
          : root.cmTile.root.view.state.selection.main.empty
        const dom = getSelection()
        const [anchorNode, anchorOffset] = find(anchor)
        const [focusNode, focusOffset] = find(head)
        if (
          !empty &&
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
      { anchor: item.anchor, head: item.head },
      { polling: 100 },
    )
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
    } else
      for (const typed of item.typed) {
        await page.keyboard.insertText(typed)
        length += typed.length
      }
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
    assert.deepEqual([undone.anchor, undone.head], [anchor, head], 'undo')
    await pressShortcut(app, redo)
    await saved(item.after)
    const redone = await settled()
    t.diagnostic(JSON.stringify({ engine, phase: 'redo', ...redone }))
    assert.deepEqual([redone.anchor, redone.head], left, 'redo')
    await cdp.detach()
  })
