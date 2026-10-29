import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { bundledColorschemes } from '../src/shared/color-palettes.ts'
import { COLOR_TOKENS } from '../src/shared/colorschemes.ts'
import {
  after,
  before,
  electron,
  waitForAsync,
  waitForDocumentEditor,
} from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

const parityNote = `# Math parity

Inline $x^2 + y^2 = z^2$ in a paragraph, and $\\frac{a}{b}$ too.

$$
\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}
$$

After the block, $$\\alpha$$ stays text.

$$\\int_0^1 x\\,dx$$

> A quote with $q$ and
> $$
> \\sqrt{2}
> $$

- item with $m$
- another $\\beta$

## Heading $h_1$

Broken $\\frac{1$ formula.
`

const editNote = 'Text $a+b$ end.\n\n$$\nc^2\n$$\n\nlast line\n'

let app, folder, page

const palette = (id) => {
  const scheme = bundledColorschemes.find((entry) => entry.id === id)
  return {
    id,
    appearance: scheme.appearance,
    css: `:root { color-scheme: ${scheme.appearance}; ${COLOR_TOKENS.map((key) => `--${key}: ${scheme.colors[key]};`).join(' ')} }`,
  }
}
const applyPalette = (scheme) =>
  page.evaluate(({ id, appearance, css }) => {
    let style = document.querySelector('style[data-test-palette]')
    if (!style) {
      style = document.createElement('style')
      style.dataset.testPalette = ''
      document.head.append(style)
    }
    style.textContent = css
    document.documentElement.dataset.colorscheme = id
    document.documentElement.dataset.appearance = appearance
  }, palette(scheme))

/** Open a note with the File menu's shortcut. */
async function open(name) {
  await app.evaluate(
    ({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      })
    },
    join(folder, 'notes', name),
  )
  await pressShortcut(app, `${mod}+o`)
}

/** Reload the window with the formatted engine switch and marker setting. */
async function engine(codemirror, markers = true) {
  await page.evaluate(
    ({ codemirror, markers }) => {
      if (codemirror)
        localStorage.setItem('hibi:formatted-engine', 'codemirror')
      else localStorage.setItem('hibi:formatted-engine', 'tiptap')
      localStorage.setItem('markdown-markers', String(markers))
    },
    { codemirror, markers },
  )
  await page.reload()
  await waitForDocumentEditor(app, page)
}

const documentText = () =>
  page.evaluate(async () => (await window.hibi.getDocument()).markdown)

before(
  async () => {
    folder = await mkdtemp(join(tmpdir(), 'hibi-formatted-math-'))
    await mkdir(join(folder, 'notes'))
    await mkdir(join(folder, 'profile'))
    await writeFile(
      join(folder, 'profile', 'addons.json'),
      JSON.stringify({ math: true }),
    )
    await writeFile(join(folder, 'notes', 'parity.md'), parityNote)
    let many = '# Formulas\n\n'
    for (let index = 0; index < 400; index++) {
      for (let line = 0; line < 4; line++)
        many += `Line ${index}.${line} has $\\frac{a+${index}}{c+d}+\\sqrt{x^2+y^2}$ inline.\n\n`
      many += `$$\n\\sum_{i=1}^{${index}} \\frac{i^2}{\\sqrt{i+1}}\n$$\n\n`
    }
    await writeFile(join(folder, 'notes', 'many.md'), many)
    app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
    })
    // Closing with edited notes answers the unsaved-changes prompt.
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    page = await app.firstWindow()
    page.setDefaultTimeout(30000)
    await waitForDocumentEditor(app, page)
  },
  { timeout: 90000 },
)

after(
  async () => {
    await app?.close()
    if (folder) await rm(folder, { recursive: true, force: true })
  },
  { timeout: 30000 },
)

/** Formula boxes and a screenshot of the formatted pane. */
async function capture(name) {
  await page.evaluate(async () => {
    await document.fonts.ready
  })
  const boxes = await page.evaluate(() =>
    [...document.querySelectorAll('.rich-pane .katex')].map((katex) => {
      const box = katex.getBoundingClientRect()
      const pane = katex.closest('.rich-pane').getBoundingClientRect()
      return {
        left: Math.round(box.left - pane.left),
        top: Math.round(box.top - pane.top),
        width: Math.round(box.width),
        height: Math.round(box.height),
      }
    }),
  )
  const image = await page
    .locator('.rich-pane')
    .screenshot({ path: `test-results/formatted-math-${name}.png` })
  return { boxes, image }
}

test('formulas render in the formatted view as in the rich view, in light and dark', {
  timeout: 120000,
}, async () => {
  await open('parity.md')
  await page.locator('.tiptap h1', { hasText: 'Math parity' }).waitFor()
  await page.waitForFunction(
    () => document.querySelectorAll('.tiptap .katex').length === 9,
  )
  const rich = {}
  for (const scheme of ['hibi-light', 'hibi-dark']) {
    await applyPalette(scheme)
    rich[scheme] = await capture(`rich-${scheme}`)
  }
  await engine(true)
  await open('parity.md')
  await page
    .locator('.rich-pane .hibi-lp-h1', { hasText: 'Math parity' })
    .waitFor()
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.rich-pane .hibi-formatted .katex').length ===
      9,
  )
  await page.locator('.hibi-formatted .katex-error').waitFor({
    state: 'attached',
  })
  // The rich view's markup, so the addon's styles and error display apply alike.
  assert.deepEqual(
    await page.evaluate(() => ({
      inline: document.querySelectorAll(
        '.hibi-formatted span.tiptap-mathematics-render[data-type="inline-math"][data-latex] > .katex',
      ).length,
      block: document.querySelectorAll(
        '.hibi-formatted div.tiptap-mathematics-render[data-type="block-math"][data-latex] > .block-math-inner > .katex-display > .katex',
      ).length,
      error: document.querySelector('.hibi-formatted .katex-error')
        ?.textContent,
      literal: [...document.querySelectorAll('.hibi-formatted .cm-line')].some(
        (line) => line.textContent.includes('$$\\alpha$$ stays text'),
      ),
    })),
    { inline: 6, block: 3, error: '\\frac{1', literal: true },
  )
  const report = []
  for (const scheme of ['hibi-light', 'hibi-dark']) {
    await applyPalette(scheme)
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => done())),
    )
    const formatted = await capture(`formatted-${scheme}`)
    assert.equal(formatted.boxes.length, rich[scheme].boxes.length)
    formatted.boxes.forEach((box, index) => {
      const other = rich[scheme].boxes[index]
      for (const key of Object.keys(box))
        assert.ok(
          Math.abs(box[key] - other[key]) <= 1,
          `${scheme} formula ${index} ${key}: ${JSON.stringify({ box, other })}`,
        )
    })
    const difference = await app.evaluate(
      ({ nativeImage }, images) => {
        const [a, b] = images.map((image) =>
          nativeImage.createFromBuffer(Buffer.from(image, 'base64')),
        )
        const size = a.getSize(),
          other = b.getSize()
        if (size.width !== other.width || size.height !== other.height) return 1
        const left = a.toBitmap(),
          right = b.toBitmap()
        let changed = 0
        for (let i = 0; i < left.length; i += 4)
          if (
            Math.abs(left[i] - right[i]) > 8 ||
            Math.abs(left[i + 1] - right[i + 1]) > 8 ||
            Math.abs(left[i + 2] - right[i + 2]) > 8
          )
            changed++
        return changed / (left.length / 4)
      },
      [rich[scheme].image, formatted.image].map((image) =>
        image.toString('base64'),
      ),
    )
    report.push({ scheme, difference })
  }
  console.log(JSON.stringify(report))
  for (const { scheme, difference } of report)
    assert.ok(difference < 0.002, `${scheme}: ${difference}`)
})

test('the caret reveals formula source, typing edits it and undo restores it', {
  timeout: 90000,
}, async () => {
  await writeFile(join(folder, 'notes', 'edit.md'), editNote)
  await open('edit.md')
  await page.locator('.rich-pane .cm-line', { hasText: 'last line' }).waitFor()
  // Hidden windows have no focus; markers under the caret need a focused editor.
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await page.locator('.rich-pane [data-type="inline-math"] .katex').waitFor()
  // Clicking a formula places the caret beside its source, which shows.
  await page.locator('.rich-pane [data-type="inline-math"]').click()
  await page
    .locator('.rich-pane .hibi-lp-math-source', { hasText: 'a+b' })
    .waitFor()
  assert.equal(
    await page.locator('.rich-pane [data-type="inline-math"]').count(),
    0,
  )
  assert.deepEqual(
    await page.evaluate(() =>
      [...document.querySelectorAll('.rich-pane .hibi-lp-marker')].map(
        (marker) => marker.textContent,
      ),
    ),
    ['$', '$'],
  )
  // Typing inside the revealed source edits the formula's text.
  await page.locator('.rich-pane .hibi-lp-math-source').click()
  await page.keyboard.press('End')
  await page.locator('.rich-pane .cm-line', { hasText: 'Text' }).click()
  await page.keyboard.press('Home')
  for (let step = 0; step < 6; step++) await page.keyboard.press('ArrowRight')
  await page.keyboard.type('x')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.startsWith('Text $xa+b$ end.'),
  )
  await pressShortcut(app, `${mod}+z`)
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.startsWith('Text $a+b$ end.'),
  )
  // Leaving renders the formula again.
  await page.locator('.rich-pane .cm-line', { hasText: 'last line' }).click()
  await page.locator('.rich-pane [data-type="inline-math"] .katex').waitFor()
  // A press on a display block selects it whole, as the rich editor's node
  // selection, without showing its source (open-001, triple-001).
  await page.locator('.rich-pane [data-type="block-math"]').click()
  assert.equal(await page.locator('.rich-pane .hibi-lp-math-source').count(), 0)
  // A caret in it shows its lines with the formula still rendered below them.
  await page.evaluate(() => {
    const view = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    view.dispatch({
      selection: { anchor: view.state.doc.toString().indexOf('c^2') },
    })
    view.focus()
  })
  await page
    .locator('.rich-pane .hibi-lp-math-source', { hasText: 'c^2' })
    .waitFor()
  assert.equal(
    await page.locator('.rich-pane [data-type="block-math"] .katex').count(),
    1,
  )
  assert.ok((await documentText()).includes('$$\nc^2\n$$'))
})

test('insert math writes one source edit in the formatted view', {
  timeout: 90000,
}, async () => {
  await page.locator('.rich-pane .cm-line', { hasText: 'last line' }).click()
  await page.keyboard.press('End')
  await clickMenu(app, 'Command palette')
  const commands = page.getByRole('dialog', { name: 'Command palette' })
  await commands
    .getByRole('combobox', { name: /search commands/i })
    .fill('Insert inline math')
  await commands
    .getByRole('option', { name: /Insert inline math/i })
    .press('Enter')
  const prompt = page.getByRole('dialog', { name: 'Math' })
  await prompt.getByRole('textbox', { name: 'LaTeX' }).fill('e=mc^2')
  await prompt.getByRole('button', { name: 'Apply' }).click()
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('last line$e=mc^2$'),
  )
  // The caret after it keeps its source showing.
  await page
    .locator('.rich-pane .hibi-lp-math-source', { hasText: 'e=mc^2' })
    .waitFor()
  // One undo step removes the insertion.
  await pressShortcut(app, `${mod}+z`)
  await waitForAsync(
    page,
    async (note) => (await window.hibi.getDocument()).markdown === note,
    editNote,
  )
})

test('inserted display math stays in the quote or list item around the caret', {
  timeout: 120000,
}, async () => {
  // The second note's caret line is a lazy continuation: no marker, still in the quote.
  for (const [name, note, caret, expected, line] of [
    [
      'quote.md',
      '> before after\n\nlast\n',
      '> before',
      '> before\n>\n> $$\n> x^2\n> $$\n>\n>  after\n\nlast\n',
      '.hibi-lp-quote',
    ],
    [
      'lazy.md',
      '> intro\nbefore after\n\nlast\n',
      '> intro\nbefore',
      '> intro\nbefore\n>\n> $$\n> x^2\n> $$\n>\n>  after\n\nlast\n',
      '.hibi-lp-quote',
    ],
    [
      'lazy-list.md',
      '- intro\nbefore after\n\nlast\n',
      '- intro\nbefore',
      '- intro\nbefore\n\n  $$\n  x^2\n  $$\n\n   after\n\nlast\n',
      '.hibi-lp-nested',
    ],
  ]) {
    await writeFile(join(folder, 'notes', name), note)
    await open(name)
    await page.locator('.rich-pane .cm-line', { hasText: 'last' }).click()
    await page.evaluate((anchor) => {
      const view = document.querySelector('.rich-pane .cm-content').cmTile.root
        .view
      view.dispatch({ selection: { anchor } })
    }, caret.length)
    await clickMenu(app, 'Command palette')
    const commands = page.getByRole('dialog', { name: 'Command palette' })
    await commands
      .getByRole('combobox', { name: /search commands/i })
      .fill('Insert block math')
    await commands
      .getByRole('option', { name: /Insert block math/i })
      .press('Enter')
    const prompt = page.getByRole('dialog', { name: 'Math' })
    await prompt.getByRole('textbox', { name: 'LaTeX' }).fill('x^2')
    await prompt.getByRole('button', { name: 'Apply' }).click()
    // The formula and the rest of the line keep their container.
    await waitForAsync(
      page,
      async (expected) =>
        (await window.hibi.getDocument()).markdown === expected,
      expected,
    )
    await page
      .locator(`.rich-pane .cm-line${line} [data-type="block-math"] .katex`)
      .waitFor()
    await pressShortcut(app, `${mod}+z`)
    await waitForAsync(
      page,
      async (expected) =>
        (await window.hibi.getDocument()).markdown === expected,
      note,
    )
  }
})

test('with markers hidden, clicking a formula opens its prompt and replaces the formula', {
  timeout: 90000,
}, async () => {
  await engine(true, false)
  await open('edit.md')
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await page.locator('.rich-pane [data-type="block-math"] .katex').waitFor()
  await page.locator('.rich-pane [data-type="block-math"]').click()
  const prompt = page.getByRole('dialog', { name: 'Math' })
  const field = prompt.getByRole('textbox', { name: 'LaTeX' })
  assert.equal(await field.inputValue(), 'c^2')
  await field.fill('d^3')
  await prompt.getByRole('button', { name: 'Apply' }).click()
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('$$\nd^3\n$$'),
  )
  // The source stays hidden; the new formula renders in place.
  await page
    .locator('.rich-pane [data-type="block-math"][data-latex="d^3"] .katex')
    .waitFor()
  assert.equal(await page.locator('.rich-pane .hibi-lp-math-source').count(), 0)
  await pressShortcut(app, `${mod}+z`)
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('$$\nc^2\n$$'),
  )
  // Keyboard: an arrow key toward a formula focuses its edit control, and
  // Enter opens the prompt; the source never shows.
  const control = page.locator(
    '.rich-pane [data-type="inline-math"] button[aria-label="Edit equation"]',
  )
  await page.locator('.rich-pane .cm-line', { hasText: 'last line' }).click()
  await page.evaluate(() => {
    const view = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    view.dispatch({ selection: { anchor: 'Text '.length } })
  })
  await page.keyboard.press('ArrowRight')
  await waitForAsync(
    page,
    () =>
      document.activeElement?.getAttribute('aria-label') === 'Edit equation',
  )
  // Arrows leave it again, on the side they point to.
  await page.keyboard.press('ArrowRight')
  assert.deepEqual(
    await page.evaluate(() => {
      const view = document.querySelector('.rich-pane .cm-content').cmTile.root
        .view
      return { focused: view.hasFocus, head: view.state.selection.main.head }
    }),
    { focused: true, head: 'Text $a+b$'.length },
  )
  await page.keyboard.press('ArrowLeft')
  await waitForAsync(
    page,
    () =>
      document.activeElement?.getAttribute('aria-label') === 'Edit equation',
  )
  await page.keyboard.press('Enter')
  assert.equal(await field.inputValue(), 'a+b')
  await field.fill('a-b')
  await page
    .getByRole('dialog', { name: 'Math' })
    .getByRole('button', { name: 'Apply' })
    .click()
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.startsWith('Text $a-b$ end.'),
  )
  await control.waitFor()
  assert.equal(await page.locator('.rich-pane .hibi-lp-math-source').count(), 0)
  await pressShortcut(app, `${mod}+z`)
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.startsWith('Text $a+b$ end.'),
  )
  await engine(true, true)
})

test('2,000 formulas: only formulas near the viewport render and typing renders none', {
  timeout: 120000,
}, async () => {
  await page.evaluate(() => {
    window.mathRenders = 0
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node.nodeType === 1)
            window.mathRenders += node.matches('.katex')
              ? 1
              : node.querySelectorAll('.katex').length
    }).observe(document.body, { childList: true, subtree: true })
  })
  await open('many.md')
  await page
    .locator('.rich-pane .hibi-lp-h1', { hasText: 'Formulas' })
    .waitFor()
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.rich-pane .hibi-formatted .katex').length >
      10,
  )
  const settle = () =>
    page.evaluate(
      () =>
        new Promise((done) =>
          requestIdleCallback(() => requestAnimationFrame(() => done()), {
            timeout: 2000,
          }),
        ),
    )
  await settle()
  const opened = await page.evaluate(() => ({
    rendered: document.querySelectorAll('.rich-pane .hibi-formatted .katex')
      .length,
    renders: window.mathRenders,
  }))
  // The rich view renders all 2,000; the formatted view only those it shows.
  assert.ok(opened.rendered < 200, JSON.stringify(opened))
  assert.ok(opened.renders < 200, JSON.stringify(opened))
  // Typing beside formulas renders none of them again.
  await page.locator('.rich-pane .cm-line', { hasText: 'Line 0.1 has' }).click()
  await page.keyboard.press('End')
  await page.evaluate(() => {
    window.mathRenders = 0
  })
  for (const key of 'typed') await page.keyboard.type(key)
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('inline.typed'),
  )
  await settle()
  assert.equal(await page.evaluate(() => window.mathRenders), 0)
  // Far down the note, the formulas there render when they come into view.
  await page.evaluate(() => {
    window.mathRenders = 0
    const view = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    view.dispatch({
      selection: { anchor: view.state.doc.length },
      scrollIntoView: true,
    })
  })
  await page
    .locator('.rich-pane [data-type="block-math"][data-latex*="399"] .katex')
    .waitFor()
  await settle()
  const scrolled = await page.evaluate(() => ({
    rendered: document.querySelectorAll('.rich-pane .hibi-formatted .katex')
      .length,
    renders: window.mathRenders,
  }))
  console.log(JSON.stringify({ opened, scrolled }))
  assert.ok(scrolled.rendered < 200, JSON.stringify(scrolled))
  assert.ok(scrolled.renders < 200, JSON.stringify(scrolled))
})
