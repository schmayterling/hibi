import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { sourceIndent } from '../src/renderer/src/source-indent.ts'
import {
  codeIndentLines,
  detectIndentUnit,
} from '../src/renderer/src/tab-indent.ts'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu, replaceSourceText } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('indentation follows the first indented line', () => {
  assert.equal(detectIndentUnit('a\n  \n\tb'), '\t')
  assert.equal(detectIndentUnit('a\n b\n   c'), '   ')
  assert.equal(detectIndentUnit('        code'), '    ')
  assert.equal(detectIndentUnit('plain\n'), undefined)
  const late = `${'line\n'.repeat(1499)}    late`
  assert.equal(detectIndentUnit(late), '    ')
  // Code blocks read their first thousand lines, in both editors.
  assert.equal(detectIndentUnit(late, codeIndentLines), undefined)
  assert.equal(detectIndentUnit(late.slice(500 * 5), codeIndentLines), '    ')

  let state = EditorState.create({ doc: late, extensions: sourceIndent })
  const unit = () => state.field(sourceIndent)?.unit
  const edit = (changes) => {
    state = state.update({ changes }).state
  }
  assert.equal(unit(), '    ')
  edit({ from: 0, insert: '  first\n' })
  assert.equal(unit(), '  ')
  edit({ from: 0, to: 2 })
  assert.equal(unit(), '    ')
  edit({ from: state.doc.length - 8, insert: 'x' })
  assert.equal(unit(), undefined)
  edit({ from: state.doc.length, insert: '\n\tz' })
  assert.equal(unit(), '\t')
  edit({ from: 4, insert: '\n\t\t' })
  assert.equal(unit(), '\t')
  assert.equal(state.field(sourceIndent).from, 5)
})

test('Tab indents source and code, keeps lists and tables, and Escape then Tab leaves', {
  timeout: 60000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-tab-indent-'))
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
  await waitForDocumentEditor(app, page)
  const rich = page.locator('.tiptap')
  const source = page.getByRole('textbox', {
    name: 'Markdown editor',
    exact: true,
  })
  const settings = async (change) => {
    await clickMenu(app, 'Settings')
    await page.getByRole('tab', { name: 'Editor', exact: true }).click()
    await change({
      indents: page.getByRole('checkbox', {
        name: 'Tab key indents',
        exact: true,
      }),
      view: page.getByLabel('Default view', { exact: true }),
    })
    await page.getByRole('button', { name: /back to app/i }).click()
  }
  const saved = (markdown) =>
    waitForAsync(
      page,
      async (markdown) =>
        (await window.hibi.getDocument())?.markdown === markdown,
      markdown,
    )
  const focusIn = (selector) =>
    page.evaluate(
      (selector) => !!document.activeElement?.closest(selector),
      selector,
    )
  const setRich = (content, selection) =>
    rich.evaluate(
      (element, [content, selection]) => {
        const editor = element.editor
        editor.commands.setContent(content)
        editor.commands.setTextSelection(selection)
        editor.view.focus()
      },
      [content, selection],
    )
  const richState = () =>
    rich.evaluate((element) => {
      const { state } = element.editor
      return {
        text: state.doc.textBetween(0, state.doc.content.size, '|'),
        from: state.selection.from,
        to: state.selection.to,
      }
    })
  const listTab = async () => {
    await setRich('<ul><li><p>a</p></li><li><p>b</p></li></ul>', 8)
    await page.keyboard.press('Tab')
    assert.equal(await rich.locator('ul ul').count(), 1)
  }

  // Rich paragraphs: a tab only after text on the line; never at its start.
  await setRich('<p>ab</p>', 3)
  await page.keyboard.press('Tab')
  assert.deepEqual(await richState(), { text: 'ab\t', from: 4, to: 4 })
  await setRich('<p>ab</p>', 1)
  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab')
  assert.deepEqual(await richState(), { text: 'ab', from: 1, to: 1 })
  assert.equal(await focusIn('.tiptap'), true)

  // Each Tab is its own undo step, apart from typing.
  const undone = async (text) => {
    await page.keyboard.press('ControlOrMeta+z')
    await waitForAsync(
      page,
      (text) =>
        document.querySelector('.tiptap').editor.state.doc.textContent === text,
      text,
    )
  }
  await setRich('<p>base</p>', 5)
  await page.keyboard.type('x')
  await page.keyboard.press('Tab')
  await undone('basex')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await undone('basex\t')
  await undone('basex')
  await undone('base')

  // Rich code blocks indent at the caret or across selected lines.
  await setRich('<pre><code>x\ny</code></pre>', 1)
  await page.keyboard.press('Tab')
  assert.equal((await richState()).text, '\tx\ny')
  await setRich('<pre><code>x\ny</code></pre>', { from: 1, to: 4 })
  await page.keyboard.press('Tab')
  assert.equal((await richState()).text, '\tx\n\ty')
  await page.keyboard.press('Shift+Tab')
  assert.equal((await richState()).text, 'x\ny')
  await setRich('<pre><code>  x\ny</code></pre>', 5)
  await page.keyboard.press('Tab')
  assert.equal((await richState()).text, '  x\n  y')

  // A 1 MB selection indents in one edit instead of one block copy per line.
  const lines = 16384
  const big = Array.from({ length: lines }, (_, line) =>
    `${line}`.padEnd(63, 'x'),
  ).join('\n')
  await setRich(`<pre><code>${big}</code></pre>`, {
    from: 1,
    to: big.length + 1,
  })
  const started = performance.now()
  await page.keyboard.press('Tab')
  const indented = await rich.evaluate((element) => {
    const { state } = element.editor
    const text = state.doc.firstChild.textContent
    return {
      length: text.length,
      every: text.split('\n').every((line) => /^\t\d+x+$/.test(line)),
      from: state.selection.from,
      to: state.selection.to,
    }
  })
  assert.ok(performance.now() - started < 10000)
  assert.deepEqual(indented, {
    length: big.length + lines,
    every: true,
    from: 2,
    to: big.length + lines + 1,
  })

  // Lists and tables keep their own Tab behavior.
  await listTab()
  const cell = () =>
    rich.evaluate(
      (element) => element.editor.state.selection.$from.parent.textContent,
    )
  await setRich('<table><tr><td><p>a</p></td><td><p>b</p></td></tr></table>', 4)
  await page.keyboard.press('Tab')
  assert.equal(await cell(), 'b')
  await page.keyboard.press('Shift+Tab')
  assert.equal(await cell(), 'a')

  // Escape then Tab leaves without a time limit; another key disarms it.
  const exitHelp = 'Press Escape, then Tab, to leave the editor.'
  assert.equal(await rich.getAttribute('aria-description'), exitHelp)
  // A timed window opened by this Escape would have closed long ago.
  const escapeAMinuteAgo = async () => {
    await page.evaluate(() => {
      const now = Date.now
      Date.now = () => now() - 60000
      window.restoreNow = () => {
        Date.now = now
      }
    })
    await page.keyboard.press('Escape')
    await page.evaluate(() => window.restoreNow())
  }
  await setRich('<p>ab</p>', 3)
  await page.keyboard.press('Escape')
  await page.keyboard.type('x')
  await page.keyboard.press('Tab')
  assert.deepEqual(await richState(), { text: 'abx\t', from: 5, to: 5 })
  await setRich('<p>ab</p>', 3)
  await escapeAMinuteAgo()
  await page.keyboard.press('Shift+Tab')
  assert.equal(await focusIn('.tiptap'), false)
  assert.equal((await richState()).text, 'ab')

  // With the setting off, Tab moves focus outside lists and tables.
  await settings(({ indents }) => indents.uncheck())
  await setRich('<pre><code>x</code></pre>', 2)
  await page.keyboard.press('Tab')
  assert.equal(await focusIn('.tiptap'), false)
  assert.equal((await richState()).text, 'x')
  await listTab()
  // Code in a first item keeps focus too, like the item's text.
  for (const [list, item] of [
    ['bulletList', 'listItem'],
    ['taskList', 'taskItem'],
  ]) {
    const text = (text) => ({ type: 'text', text })
    await setRich(
      {
        type: 'doc',
        content: [
          {
            type: list,
            content: [
              {
                type: item,
                content: [
                  { type: 'paragraph', content: [text('a')] },
                  { type: 'codeBlock', content: [text('x')] },
                ],
              },
            ],
          },
        ],
      },
      6,
    )
    await page.keyboard.press('Tab')
    assert.equal(await focusIn('.tiptap'), true)
    assert.equal((await richState()).text, 'a|x')
  }

  await settings(async ({ indents, view }) => {
    await indents.check()
    await view.selectOption('markdown')
  })
  await source.waitFor()

  // Toolbar indentation uses Tab's unit and follows edits to the file.
  const toolbarIndent = async (text, expected) => {
    await replaceSourceText(page, source, text)
    await source.press('ControlOrMeta+End')
    const inline = page.locator(
      '.editor-toolbar > button[data-toolbar-id="format.indent"]',
    )
    if (await inline.count()) await inline.click()
    else {
      await page
        .getByRole('button', { name: 'More formatting actions' })
        .click()
      await page
        .locator('.toolbar-menu button[data-toolbar-id="format.indent"]')
        .click()
    }
    await saved(expected)
  }
  await toolbarIndent('    one\ntwo', '    one\n    two')
  await toolbarIndent('\tone\ntwo', '\tone\n\ttwo')

  // Source: insert at the caret, then indent and outdent selected lines.
  await replaceSourceText(page, source, 'one\ntwo')
  await source.press('Home')
  await source.press('Tab')
  await saved('one\n\ttwo')
  await source.press('Shift+Tab')
  await saved('one\ntwo')
  await source.press('ControlOrMeta+a')
  await source.press('Tab')
  await saved('\tone\n\ttwo')
  await source.press('Shift+Tab')
  await saved('one\ntwo')
  await replaceSourceText(page, source, '  one\ntwo')
  await source.press('Home')
  await source.press('Tab')
  await saved('  one\n  two')
  assert.equal(await focusIn('.source-pane'), true)
  assert.equal(await source.getAttribute('aria-description'), exitHelp)
  await escapeAMinuteAgo()
  await source.press('Tab')
  assert.equal(await focusIn('.source-pane'), false)
  await saved('  one\n  two')

  await settings(({ indents }) => indents.uncheck())
  await source.focus()
  await source.press('Tab')
  assert.equal(await focusIn('.source-pane'), false)
  await saved('  one\n  two')
})
