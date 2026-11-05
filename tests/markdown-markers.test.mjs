import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  electron,
  waitForDocumentEditor,
  waitForFormattedEditor,
} from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

async function openCMMarkers(t, source, math = false) {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-cm-markers-'))
  const file = join(profile, 'markers.md')
  await writeFile(file, source)
  if (math)
    await writeFile(
      join(profile, 'addons.json'),
      JSON.stringify({ math: true }),
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
  page.setDefaultTimeout(7000)
  const rich = await waitForFormattedEditor(app, page)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  return { app, page, rich }
}

/** Replaces the formatted source directly, so its lines are not typed input. */
async function markerSource(rich, source, anchor) {
  await rich.evaluate(
    (element, { source, anchor }) => {
      const view = element.cmTile.root.view
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: source },
        selection: { anchor },
        scrollIntoView: true,
      })
      view.focus()
    },
    { source, anchor },
  )
}

const markerState = (rich) =>
  rich.evaluate((element) => {
    const { state } = element.cmTile.root.view
    return { head: state.selection.main.head, doc: state.doc.toString() }
  })

async function markerSelection(rich, anchor, head = anchor) {
  await rich.evaluate(
    (element, { anchor, head }) => {
      const view = element.cmTile.root.view
      view.dispatch({ selection: { anchor, head }, scrollIntoView: true })
      view.focus()
    },
    { anchor, head },
  )
}

test('right arrows exit final formatting, return inside and undo only plain input', {
  timeout: 60000,
}, async (t) => {
  const { app, page, rich } = await openCMMarkers(t, '*hello*')
  // Hidden markers retain mark-exit behavior; shown source stops are checked below.
  await page.evaluate(() => localStorage.setItem('markdown-markers', 'false'))
  await page.reload()
  await waitForDocumentEditor(app, page)
  for (const source of [
    '*hello*',
    '**hello**',
    '~~hello~~',
    '`hello`',
    '***hello***',
  ]) {
    await t.test(source, async () => {
      // Typing over a formatted selection is literal text, as in the rich editor.
      await markerSource(rich, source, 0)
      const inside = source.indexOf('hello') + 5
      await markerSelection(rich, inside)
      await rich.press('ArrowRight')
      assert.equal(
        (await page.evaluate(() => window.hibi.getDocument())).markdown,
        source,
      )
      await rich.press('ArrowRight')
      assert.equal(
        (await page.evaluate(() => window.hibi.getDocument())).markdown,
        source,
        'repeated right arrows must not insert spaces',
      )
      await rich.press('ArrowLeft')
      await page.keyboard.insertText('y')
      await page.evaluate(() => window.hibi.flushDocumentChanges())
      assert.equal(
        (await page.evaluate(() => window.hibi.getDocument())).markdown,
        source.replace('hello', 'helloy'),
        'left arrow returns inside the formatted text',
      )
      await pressShortcut(
        app,
        process.platform === 'darwin' ? 'Meta+z' : 'Control+z',
      )
      await waitForAsync(
        page,
        async (expected) =>
          (await window.hibi.getDocument()).markdown === expected,
        source,
      )
      await rich.press('ArrowRight')
      await rich.press('ArrowRight')
      await page.keyboard.insertText('x')
      assert.equal(
        (await page.evaluate(() => window.hibi.getDocument())).markdown,
        `${source}x`,
        'input after formatting remains plain text',
      )
      await pressShortcut(
        app,
        process.platform === 'darwin' ? 'Meta+z' : 'Control+z',
      )
      assert.equal(
        (await page.evaluate(() => window.hibi.getDocument())).markdown,
        source,
        'one undo removes only the plain text',
      )
    })
  }
  await t.test('next paragraph', async () => {
    await markerSource(rich, '*hello*\n\nnext', 6)
    await rich.press('ArrowRight')
    assert.equal(
      await rich.evaluate(
        (element) => element.cmTile.root.view.state.selection.main.head,
      ),
      9,
    )
    await page.keyboard.insertText('x')
    assert.equal(
      (await page.evaluate(() => window.hibi.getDocument())).markdown,
      '*hello*\n\nxnext',
      'right arrow still advances to the next paragraph',
    )
    await rich.press('ArrowLeft')
    await rich.press('ArrowLeft')
    await page.keyboard.insertText('y')
    assert.equal(
      (await page.evaluate(() => window.hibi.getDocument())).markdown,
      '*helloy*\n\nxnext',
      'left arrow returns inside the formatting that ends the paragraph',
    )
  })
  await t.test('adjacent formatting', async () => {
    await markerSource(rich, '**a**_b_', 3)
    await rich.press('ArrowRight')
    await page.keyboard.insertText('y')
    assert.equal(
      (await markerState(rich)).doc,
      '**a**_by_',
      'one right arrow crosses the hidden delimiters and the next character',
    )
  })
  for (const source of [
    '```\ncode\n```\n\nnext',
    '> ```\n> code\n> ```\n>\n> next',
    '- item\n\n  ```\n  code\n  ```\n\n  next',
    '> - item\n>\n>   ```\n>   code\n>   ```\n>\n>   next',
  ])
    await t.test(`code block exit ${JSON.stringify(source)}`, async () => {
      await markerSource(rich, source, source.indexOf('code') + 4)
      await rich.press('ArrowRight')
      assert.deepEqual(await markerState(rich), {
        head: source.indexOf('next'),
        doc: source,
      })
      await rich.press('ArrowLeft')
      assert.equal(
        (await markerState(rich)).head,
        source.indexOf('code') + 4,
        'left arrow returns to the end of the code',
      )
    })
  await t.test('hidden markers', async () => {
    await page.evaluate(() => localStorage.setItem('markdown-markers', 'false'))
    await page.reload()
    await waitForDocumentEditor(app, page)
    await markerSource(rich, '*hello*', 0)
    await markerSelection(rich, 6)
    assert.equal(await rich.locator('.hibi-lp-marker').count(), 0)
    await rich.press('ArrowRight')
    await page.keyboard.insertText('x')
    assert.equal(
      (await page.evaluate(() => window.hibi.getDocument())).markdown,
      '*hello*x',
      'formatting can be exited with markers hidden',
    )
  })
})

test('arrows cross touching hidden delimiters in a table cell', {
  timeout: 60000,
}, async (t) => {
  const source = '| head | other |\n| --- | --- |\n| ***hello*** | plain |'
  const { app, page, rich } = await openCMMarkers(t, source)
  await page.evaluate(() => localStorage.setItem('markdown-markers', 'false'))
  await page.reload()
  await waitForDocumentEditor(app, page)
  await rich.locator('.hibi-lp-table td').first().click()
  const editor = page.locator('.hibi-lp-cell-editor .cm-content')
  await editor.waitFor()
  const cell = () =>
    editor.evaluate(
      (element) => element.cmTile.root.view.state.selection.main.head,
    )
  await editor.evaluate((element) => {
    const view = element.cmTile.root.view
    view.dispatch({
      selection: { anchor: view.state.doc.toString().indexOf('hello') + 5 },
    })
    view.focus()
  })
  const inside = await cell()
  await editor.press('ArrowRight')
  assert.equal(await cell(), inside + 3, 'right arrow crosses all three')
  await editor.press('ArrowLeft')
  assert.equal(await cell(), inside, 'left arrow returns inside')
  await page.keyboard.insertText('y')
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    source.replace('hello', 'helloy'),
  )
  // Between adjacent formatting one press crosses the hidden delimiters and
  // the next character, as in the formatted view's own text.
  const adjacent = '| head | other |\n| --- | --- |\n| **a**_b_ | plain |'
  const document = page.getByRole('textbox', { name: 'Document editor' })
  await markerSource(document, adjacent, 0)
  await document.locator('.hibi-lp-table td').first().click()
  await editor.waitFor()
  await editor.evaluate((element) => {
    const view = element.cmTile.root.view
    view.dispatch({
      selection: { anchor: view.state.doc.toString().indexOf('a') + 1 },
    })
    view.focus()
  })
  await editor.press('ArrowRight')
  await page.keyboard.insertText('y')
  await page.evaluate(() => window.hibi.flushDocumentChanges())
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    adjacent.replace('_b_', '_by_'),
  )
})

test('drawn caret leaves final formatting and stays text-sized beside tall math', {
  timeout: 60000,
}, async (t) => {
  const { app, page, rich } = await openCMMarkers(t, '**hello**', true)
  for (const hints of [true, false]) {
    await page.evaluate(
      (hints) => localStorage.setItem('markdown-markers', String(hints)),
      hints,
    )
    await page.reload()
    await waitForDocumentEditor(app, page)
    for (const source of ['**hello**', '`hello`'])
      await t.test(`${source}, hints ${hints}`, async () => {
        await markerSource(rich, source, 0)
        const inside = source.indexOf('hello') + 5
        await markerSelection(rich, inside)
        // Shown delimiters are editable source, so each arrow crosses
        // one real character; hidden delimiters are crossed atomically.
        for (let at = inside; at < source.length; at++) {
          await rich.press('ArrowRight')
          if (!hints) break
          assert.equal(
            await rich.evaluate(
              (element) => element.cmTile.root.view.state.selection.main.head,
            ),
            at + 1,
          )
        }
        await page.locator('.editor-cursor').waitFor()
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        )
        const geometry = await page.evaluate(() => {
          const caret = document
            .querySelector('.editor-cursor')
            .getBoundingClientRect()
          const mark = document
            .querySelector('.rich-pane :is(.hibi-lp-strong, .hibi-lp-code)')
            .getBoundingClientRect()
          return { caret: caret.left, end: mark.right }
        })
        assert.ok(
          geometry.caret >= geometry.end - 0.5,
          JSON.stringify(geometry),
        )
        assert.equal(
          await rich.locator('.hibi-lp-marker').count(),
          hints ? 2 : 0,
        )
        await page.keyboard.insertText('x')
        assert.equal(
          (await page.evaluate(() => window.hibi.getDocument())).markdown,
          `${source}x`,
        )
      })
  }
  await markerSource(rich, 'hello $\\dfrac{1}{\\dfrac{1}{2}}$', 0)
  await markerSelection(rich, 0)
  await page.locator('.rich-pane .katex').waitFor()
  await rich.press('End')
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  )
  const math = await page.evaluate(() => {
    const caret = document
      .querySelector('.editor-cursor')
      .getBoundingClientRect()
    const formula = document
      .querySelector('.rich-pane .hibi-lp-math')
      .getBoundingClientRect()
    return {
      caret: caret.toJSON(),
      formula: formula.toJSON(),
      fontSize: Number.parseFloat(
        getComputedStyle(document.querySelector('.rich-pane .cm-line'))
          .fontSize,
      ),
    }
  })
  assert.ok(math.formula.height > math.fontSize * 2, JSON.stringify(math))
  assert.ok(math.caret.height < math.fontSize * 1.5, JSON.stringify(math))
  assert.ok(math.caret.top >= math.formula.top - 1, JSON.stringify(math))
  assert.ok(math.caret.bottom <= math.formula.bottom + 1, JSON.stringify(math))
})

test('a focused table cell reveals all its formatting markers', {
  timeout: 60000,
}, async (t) => {
  const cell = 'some **bold** and *italic* with `code` and ~~strike~~'
  const { page, rich } = await openCMMarkers(
    t,
    `| head | other |\n| --- | --- |\n| ${cell} | plain |`,
  )
  await rich.locator('.hibi-lp-table td').first().click()
  const editor = page.locator('.hibi-lp-cell-editor .cm-content')
  await editor.waitFor()
  await editor.evaluate((element) => {
    const view = element.cmTile.root.view
    view.dispatch({
      selection: { anchor: view.state.doc.toString().indexOf('bold') + 1 },
    })
    view.focus()
  })
  await editor.locator('.hibi-lp-marker').first().waitFor()
  assert.equal(await editor.locator('.hibi-lp-marker').count(), 8)
})

test('focused markers preserve copying, source, undo, preferences and split editing', {
  timeout: 60000,
}, async (t) => {
  const source =
    '# Marker heading\n\nSome **bold** and *italic* with `code` and ~~strike~~.\n\nAnother **block**.\n\n```js\nconst literal = "**plain**"\n```'
  const { app, page, rich } = await openCMMarkers(t, source)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const heading = rich.locator('.hibi-lp-h1')
  const paragraph = rich.locator('.cm-line').filter({ hasText: /^Some / })
  await heading.click()
  assert.equal(await heading.locator('.hibi-lp-marker').textContent(), '# ')
  assert.equal(await paragraph.locator('.hibi-lp-marker').count(), 0)
  await paragraph.click()
  const from = source.indexOf('Some '),
    to = source.indexOf('\n\nAnother')
  await t.test('focused paragraph reveals its formatting markers', async () => {
    await rich.locator('.hibi-lp-strong').first().click()
    assert.equal(await heading.locator('.hibi-lp-marker').count(), 0)
    assert.equal(await rich.locator('.hibi-lp-marker').count(), 8)
    await markerSelection(rich, from, to)
    assert.equal(await paragraph.locator('.hibi-lp-marker').count(), 8)
  })
  await markerSelection(rich, from, to)
  const copied = await rich.evaluate((element) => {
    const clipboardData = new DataTransfer()
    element.dispatchEvent(
      new ClipboardEvent('copy', {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    )
    return {
      text: clipboardData.getData('text/plain'),
      html: clipboardData.getData('text/html'),
    }
  })
  // Accepted difference: the formatted view copies the selection's exact
  // Markdown as text, as a Markdown editor does, where the rich editor copies
  // rendered text. Both copy the rendered HTML.
  await t.test(
    'copy keeps the exact markdown as text and clean rendered html',
    async () => {
      assert.equal(copied.text, source.slice(from, to))
      assert.equal(
        await page.evaluate(
          (html) =>
            new DOMParser()
              .parseFromString(html, 'text/html')
              .body.textContent.trim(),
          copied.html,
        ),
        'Some bold and italic with code and strike.',
      )
      assert.doesNotMatch(
        copied.html,
        /markdown-marker|data-marker|hibi-lp-marker/,
      )
    },
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    source,
  )
  await rich.press('ControlOrMeta+a')
  await t.test('select all hides formatting markers', async () => {
    assert.equal(await rich.locator('.hibi-lp-marker').count(), 0)
    assert.equal(
      (await page.evaluate(() => window.hibi.getDocument())).markdown,
      source,
    )
  })
  await rich
    .locator('.cm-line')
    .filter({ hasText: /^Another/ })
    .click()
  assert.equal(await paragraph.locator('.hibi-lp-marker').count(), 0)
  await rich.locator('.hibi-lp-codeblock').first().click()
  assert.deepEqual(await rich.locator('.hibi-lp-marker').allTextContents(), [
    '```js',
    '```',
  ])
  await markerSelection(rich, to)
  await page.keyboard.insertText('x')
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    `${source.slice(0, to)}x${source.slice(to)}`,
  )
  const changeSetting = async (enabled) => {
    await clickMenu(app, 'Settings')
    await page.getByRole('tab', { name: /^editor$/i }).click()
    await page
      .getByRole('checkbox', { name: /^show markdown markers$/i })
      .setChecked(enabled)
    await page.getByRole('button', { name: /back to app/i }).click()
  }
  await changeSetting(false)
  await paragraph.click()
  assert.equal(await rich.locator('.hibi-lp-marker').count(), 0)
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+z' : 'Control+z',
  )
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    source,
  )
  await page.reload()
  await paragraph.click()
  assert.equal(await rich.locator('.hibi-lp-marker').count(), 0)
  assert.equal(
    await page.evaluate(() => localStorage.getItem('markdown-markers')),
    'false',
  )
  await changeSetting(true)
  await rich.locator('.hibi-lp-strong').first().click()
  await rich.locator('.hibi-lp-marker').first().waitFor()
  await page.getByRole('button', { name: /^side-by-side$/i }).click()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  await page.getByRole('textbox', { name: /markdown editor/i }).focus()
  await page.waitForFunction(
    () => !document.querySelector('.rich-pane .hibi-lp-marker'),
  )
  assert.equal(await rich.locator('.hibi-lp-marker').count(), 0)
  await rich.locator('.hibi-lp-strong').first().click()
  // Accepted difference: the codemirror split pane stays editable and shows
  // the markers under its caret, as the focused formatted view does.
  assert.equal(await rich.getAttribute('contenteditable'), 'true')
  await rich.locator('.hibi-lp-marker').first().waitFor()
  await page.getByRole('button', { name: /^normal$/i }).click()
  await rich.locator('.hibi-lp-strong').first().click()
  assert.equal(
    await rich.evaluate(
      (element) => element.getAttribute('aria-readonly') === 'true',
    ),
    false,
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    source,
  )
  assert.deepEqual(errors, [])
})
