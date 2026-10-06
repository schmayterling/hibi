import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { getSchema } from '@tiptap/core'
import { StarterKit } from '@tiptap/starter-kit'
import { blockMarkdownMarkers } from '../src/renderer/src/markdown-markers.ts'
import { electron } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const schema = getSchema([StarterKit])
const bold = schema.marks.bold.create()
const italic = schema.marks.italic.create()

test('block markers retain nested and adjacent mark boundaries without touching text', () => {
  const paragraph = schema.nodes.paragraph.create(null, [
    schema.text('one', [bold]),
    schema.text(' two', [bold, italic]),
    schema.text(' three', [bold]),
    schema.text(' code', [schema.marks.code.create()]),
  ])
  assert.deepEqual(blockMarkdownMarkers(paragraph, 10), [
    { pos: 10, text: '**', side: -1 },
    { pos: 13, text: '*', side: -1 },
    { pos: 17, text: '*', side: 1 },
    { pos: 23, text: '**`', side: 0 },
    { pos: 28, text: '`', side: 1 },
  ])
  assert.equal(paragraph.textContent, 'one two three code')
  const linked = schema.nodes.paragraph.create(null, [
    schema.text('a', [bold]),
    schema.text('b', [
      bold,
      schema.marks.link.create({ href: 'https://example.com' }),
    ]),
    schema.text('c', [bold]),
  ])
  assert.deepEqual(
    blockMarkdownMarkers(linked, 1).map((hint) => hint.text),
    ['**', '**'],
  )
})

test('heading hints reflect level and code blocks and unformatted paragraphs stay untouched', () => {
  const heading = schema.nodes.heading.create(
    { level: 3 },
    schema.text('title', [bold]),
  )
  assert.deepEqual(blockMarkdownMarkers(heading, 7), [
    { pos: 7, text: '### ', side: -10 },
    { pos: 7, text: '**', side: -1 },
    { pos: 12, text: '**', side: 1 },
  ])
  assert.deepEqual(
    blockMarkdownMarkers(
      schema.nodes.codeBlock.create(null, schema.text('**literal**')),
      1,
    ),
    [],
  )
  assert.deepEqual(
    blockMarkdownMarkers(
      schema.nodes.paragraph.create(null, schema.text('**literal**')),
      1,
    ),
    [],
  )
})

test('right arrow exits final formatting without changing text or trapping the caret', {
  timeout: 60000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-markers-eof-'))
  const note = join(profile, 'eof.md')
  await writeFile(note, '*hello*')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`, note],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  const rich = page.getByRole('textbox', { name: /document editor/i })
  await rich.waitFor()
  for (const html of [
    '<em>hello</em>',
    '<strong>hello</strong>',
    '<s>hello</s>',
    '<code>hello</code>',
    '<strong><em>hello</em></strong>',
  ]) {
    const original = await rich.evaluate((element, html) => {
      const editor = element.editor
      editor.commands.setContent(`<p>${html}</p>`)
      editor.commands.setTextSelection(6)
      editor.view.focus()
      return editor.getJSON()
    }, html)
    await rich.press('ArrowRight')
    const escaped = await rich.evaluate((element) => {
      const editor = element.editor
      const marker = [...element.querySelectorAll('.markdown-marker')].at(-1)
      return {
        doc: editor.getJSON(),
        marks: editor.state.storedMarks?.map((mark) => mark.type.name),
        afterMarker:
          editor.view.coordsAtPos(editor.state.selection.from).left >=
          marker.getBoundingClientRect().right - 1,
      }
    })
    assert.deepEqual(escaped.doc, original, html)
    assert.deepEqual(escaped.marks, [], html)
    assert.equal(escaped.afterMarker, true, html)
    await rich.press('ArrowRight')
    assert.deepEqual(
      await rich.evaluate((element) => element.editor.getJSON()),
      original,
      'repeated right arrows must not insert spaces',
    )
    await rich.press('ArrowLeft')
    assert.equal(
      await rich.evaluate((element) => element.editor.state.selection.from),
      6,
      'left arrow returns inside the formatted text',
    )
    await page.keyboard.insertText('y')
    assert.deepEqual(
      await rich.evaluate(
        (element) => element.editor.getJSON().content[0].content,
      ),
      [{ ...original.content[0].content[0], text: 'helloy' }],
    )
    await rich.evaluate((element) => element.editor.commands.undo())
    await rich.press('ArrowRight')
    await rich.press('ArrowRight')
    await page.keyboard.insertText('x')
    const content = await rich.evaluate(
      (element) => element.editor.getJSON().content[0].content,
    )
    assert.deepEqual(content.at(-1), { type: 'text', text: 'x' }, html)
    await rich.evaluate((element) => element.editor.commands.undo())
    assert.deepEqual(
      await rich.evaluate((element) => element.editor.getJSON()),
      original,
      'one undo removes only the plain text',
    )
  }
  await rich.evaluate((element) => {
    const editor = element.editor
    editor.commands.setContent('<p><em>hello</em></p><p>next</p>')
    editor.commands.setTextSelection(6)
    editor.view.focus()
  })
  await rich.press('ArrowRight')
  await page.waitForFunction(
    () => document.querySelector('.tiptap').editor.state.selection.from === 8,
  )
  assert.equal(
    await rich.evaluate((element) => element.editor.state.selection.from),
    8,
    'right arrow still advances to the next paragraph',
  )
  await page.evaluate(() => localStorage.setItem('markdown-markers', 'false'))
  await page.reload()
  await rich.waitFor()
  await rich.evaluate((element) => {
    element.editor.commands.setContent('<p><em>hello</em></p>')
    element.editor.commands.setTextSelection(6)
    element.editor.view.focus()
  })
  assert.equal(await rich.locator('.markdown-marker').count(), 0)
  await rich.press('ArrowRight')
  await page.keyboard.insertText('x')
  assert.deepEqual(
    await rich.evaluate((element) =>
      element.editor.getJSON().content[0].content.at(-1),
    ),
    { type: 'text', text: 'x' },
    'formatting can be exited with markers hidden',
  )
})

test('drawn caret leaves final formatting at the end of the document', {
  timeout: 60000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-markers-caret-'))
  const note = join(profile, 'caret.md')
  await writeFile(note, '**hello**')
  await writeFile(join(profile, 'addons.json'), JSON.stringify({ math: true }))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`, note],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(8000)
  const rich = page.getByRole('textbox', { name: /document editor/i })
  for (const hints of [true, false]) {
    await page.evaluate(
      (hints) => localStorage.setItem('markdown-markers', String(hints)),
      hints,
    )
    await page.reload()
    await rich.waitFor()
    for (const html of ['<strong>hello</strong>', '<code>hello</code>']) {
      const label = `${html} with hints ${hints ? 'on' : 'off'}`
      await rich.evaluate((element, html) => {
        element.editor.commands.setContent(`<p>${html}</p>`)
        element.editor.commands.setTextSelection(6)
        element.editor.view.focus()
      }, html)
      await page.locator('.editor-cursor').waitFor()
      await rich.press('ArrowRight')
      // The drawn caret, not the editor position, must sit outside the styled box.
      await page.waitForFunction(() => {
        const caret = document.querySelector('.editor-cursor')
        const mark = document.querySelector('.tiptap p > :is(strong, code)')
        return (
          caret &&
          caret.getBoundingClientRect().left >=
            mark.getBoundingClientRect().right - 0.5
        )
      }, null)
      assert.equal(
        await rich.locator('.markdown-marker').count(),
        hints ? 2 : 0,
        label,
      )
      await page.keyboard.insertText('x')
      assert.deepEqual(
        await rich.evaluate((element) =>
          element.editor.getJSON().content[0].content.at(-1),
        ),
        { type: 'text', text: 'x' },
        label,
      )
    }
  }
  // Inline nodes are not formatting placeholders; a tall equation keeps a text-sized caret.
  await page.waitForFunction(
    () => document.querySelector('.tiptap')?.editor.schema.nodes.inlineMath,
  )
  await rich.evaluate((element) => {
    element.editor.commands.setContent(
      '<p>hello <span data-type="inline-math" data-latex="\\dfrac{1}{\\dfrac{1}{2}}"></span></p>',
    )
    element.editor.commands.setTextSelection(1)
    element.editor.view.focus()
  })
  await page.locator('.tiptap-mathematics-render .katex').waitFor()
  await rich.press('End')
  const math = await page.evaluate(async () => {
    // The drawn caret measures on the next frame after the selection moves.
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    )
    const caret = document
      .querySelector('.editor-cursor')
      .getBoundingClientRect()
    return {
      caret: { top: caret.top, bottom: caret.bottom, height: caret.height },
      formula: document
        .querySelector('.tiptap-mathematics-render')
        .getBoundingClientRect()
        .toJSON(),
      fontSize: Number.parseFloat(
        getComputedStyle(document.querySelector('.tiptap p')).fontSize,
      ),
    }
  })
  assert.ok(math.formula.height > math.fontSize * 2, JSON.stringify(math))
  assert.ok(math.caret.height < math.fontSize * 1.5, JSON.stringify(math))
  assert.ok(math.caret.top >= math.formula.top - 1, JSON.stringify(math))
  assert.ok(math.caret.bottom <= math.formula.bottom + 1, JSON.stringify(math))
})

test('rich markers follow only the focused block, preserve copying and undo, and can be disabled', {
  timeout: 60000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-markers-'))
  const source =
    '# Marker heading\n\nSome **bold** and *italic* with `code` and ~~strike~~.\n\nAnother **block**.\n\n```js\nconst literal = "**plain**"\n```'
  const note = join(profile, 'markers.md')
  await writeFile(note, source)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`, note],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(8000)
  await page.setViewportSize({ width: 1100, height: 850 })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const rich = page.getByRole('textbox', { name: /document editor/i })
  const heading = rich.locator('h1')
  await heading.click()
  await heading.locator('.markdown-marker').waitFor()
  assert.equal(
    await heading.locator('.markdown-marker').getAttribute('data-marker'),
    '# ',
  )
  assert.equal(await rich.locator('p .markdown-marker').count(), 0)
  const paragraph = rich.locator('p').first()
  await paragraph.click()
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.tiptap p:first-of-type .markdown-marker')
        .length === 8,
  )
  assert.equal(await heading.locator('.markdown-marker').count(), 0)
  assert.equal(
    await paragraph.textContent(),
    'Some bold and italic with code and strike.',
  )
  assert.equal(await rich.locator('.markdown-marker').count(), 8)
  await paragraph.evaluate((element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
  })
  await page.waitForFunction(
    () =>
      window.getSelection()?.toString() ===
      'Some bold and italic with code and strike.',
  )
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
  assert.equal(copied.text, 'Some bold and italic with code and strike.')
  assert.doesNotMatch(copied.html, /markdown-marker|data-marker/)
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    source,
  )
  await rich.press('Control+a')
  await page.waitForFunction(
    () => !document.querySelector('.tiptap .markdown-marker'),
  )
  await rich.locator('p').nth(1).click()
  await rich.locator('p').nth(1).locator('.markdown-marker').first().waitFor()
  assert.equal(await paragraph.locator('.markdown-marker').count(), 0)
  await rich.locator('pre').click()
  await page.waitForFunction(
    () => !document.querySelector('.tiptap .markdown-marker'),
  )
  assert.equal(await rich.locator('.markdown-marker').count(), 0)
  await paragraph.click()
  await page.keyboard.press('End')
  await page.keyboard.press('x')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('x'),
  )
  assert.equal(
    await paragraph.textContent(),
    'Some bold and italic with code and strike.x',
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
  assert.equal(await rich.locator('.markdown-marker').count(), 0)
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+z' : 'Control+z',
  )
  await waitForAsync(
    page,
    async (source) => (await window.hibi.getDocument()).markdown === source,
    source,
  )
  await page.reload()
  await paragraph.click()
  assert.equal(await rich.locator('.markdown-marker').count(), 0)
  assert.equal(
    await page.evaluate(() => localStorage.getItem('markdown-markers')),
    'false',
  )
  await changeSetting(true)
  await paragraph.click()
  await paragraph.locator('.markdown-marker').first().waitFor()
  await page.getByRole('button', { name: /^side-by-side$/i }).click()
  const code = page.getByRole('textbox', { name: /markdown editor/i })
  await code.click()
  await page.waitForFunction(
    () => !document.querySelector('.tiptap .markdown-marker'),
  )
  assert.equal(await rich.locator('.markdown-marker').count(), 0)
  await paragraph.click()
  assert.equal(await rich.getAttribute('aria-readonly'), 'true')
  assert.equal(await rich.locator('.markdown-marker').count(), 0)
  await page.getByRole('button', { name: /^normal$/i }).click()
  await paragraph.click()
  await paragraph.locator('.markdown-marker').first().waitFor()
  assert.equal(await rich.getAttribute('aria-readonly'), 'false')
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    source,
  )
  assert.deepEqual(errors, [])
})
