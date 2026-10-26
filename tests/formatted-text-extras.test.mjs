import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test, { after, before } from 'node:test'
import { bundledColorschemes } from '../src/shared/color-palettes.ts'
import { COLOR_TOKENS } from '../src/shared/colorschemes.ts'
import { electron, waitForAsync, waitForDocumentEditor } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const parityNote = `# Small parity

Water is H~2~O and CO~2~ here, with ~a long subscript~ too.

-# a line of small text

A paragraph, then
-# small text that ends it

> -# quoted small text

- -# listed small text
- item with x~i~ inside
`
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
      else localStorage.removeItem('hibi:formatted-engine')
      localStorage.setItem('markdown-markers', String(markers))
    },
    { codemirror, markers },
  )
  await page.reload()
  await waitForDocumentEditor(app, page)
}

const settle = () =>
  page.evaluate(
    () =>
      new Promise((done) =>
        requestIdleCallback(() => requestAnimationFrame(() => done()), {
          timeout: 2000,
        }),
      ),
  )

before(
  async () => {
    folder = await mkdtemp(join(tmpdir(), 'hibi-formatted-text-extras-'))
    await mkdir(join(folder, 'notes'))
    await mkdir(join(folder, 'profile'))
    await writeFile(join(folder, 'notes', 'parity.md'), parityNote)
    let many = '# Subscripts\n\n'
    for (let index = 0; index < 5000; index++) {
      many += `L${index} a~${index}~ b~2~ c~3~ d~4~\n\n`
      if (index % 10 === 0) many += `-# s${index}\n\n`
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

/** Computed styles of subscripts and small text, and a screenshot of the pane. */
async function capture(name, selectors) {
  const styles = await page.evaluate((selectors) => {
    const read = (element, keys) => {
      const style = getComputedStyle(element)
      return Object.fromEntries(keys.map((key) => [key, style[key]]))
    }
    return {
      subscripts: [...document.querySelectorAll(selectors.subscript)].map(
        (element) => read(element, ['verticalAlign', 'fontSize', 'color']),
      ),
      subtext: [...document.querySelectorAll(selectors.subtext)].map(
        (element) => read(element, ['fontSize', 'color', 'lineHeight']),
      ),
    }
  }, selectors)
  const image = await page
    .locator('.rich-pane')
    .screenshot({ path: `test-results/formatted-text-extras-${name}.png` })
  return { styles, image }
}

test('subscripts and small text render in the formatted view as in the rich view, in light and dark', {
  timeout: 120000,
}, async () => {
  await open('parity.md')
  await page.locator('.tiptap h1', { hasText: 'Small parity' }).waitFor()
  const rich = {}
  for (const scheme of ['hibi-light', 'hibi-dark']) {
    await applyPalette(scheme)
    rich[scheme] = await capture(`rich-${scheme}`, {
      subscript: '.rich-pane sub',
      subtext: '.rich-pane p.markdown-subtext',
    })
  }
  await engine(true)
  await open('parity.md')
  await page
    .locator('.rich-pane .hibi-lp-h1', { hasText: 'Small parity' })
    .waitFor()
  await page.locator('.rich-pane .hibi-lp-subscript').first().waitFor()
  const report = []
  for (const scheme of ['hibi-light', 'hibi-dark']) {
    await applyPalette(scheme)
    await settle()
    const formatted = await capture(`formatted-${scheme}`, {
      subscript: '.rich-pane .hibi-lp-subscript',
      // Lines, or the text beside a list bullet.
      subtext: '.rich-pane .markdown-subtext',
    })
    assert.deepEqual(formatted.styles, rich[scheme].styles, scheme)
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
  // Four subscripts and four small-text paragraphs, as in the rich view.
  assert.deepEqual(
    [
      rich['hibi-light'].styles.subscripts.length,
      rich['hibi-light'].styles.subtext.length,
    ],
    [4, 4],
  )
})

test('the caret reveals subscript tildes and the small-text marker', {
  timeout: 90000,
}, async () => {
  await open('parity.md')
  await page.locator('.rich-pane .hibi-lp-subscript').first().waitFor()
  // Hidden windows have no focus; markers under the caret need a focused editor.
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const marker = (text) =>
    page.locator('.rich-pane .hibi-lp-marker', { hasText: text })
  assert.equal(await marker('~').count(), 0)
  await page
    .locator('.rich-pane .hibi-lp-subscript', { hasText: 'a long subscript' })
    .click()
  await marker('~').first().waitFor()
  await page
    .locator('.rich-pane .cm-line', { hasText: 'a line of small text' })
    .click()
  await marker('-#').waitFor()
  // With markers hidden, the caret does not reveal them.
  await engine(true, false)
  await open('parity.md')
  await page
    .locator('.rich-pane .cm-line', { hasText: 'a line of small text' })
    .click()
  await settle()
  assert.equal(await marker('-#').count(), 0)
  await engine(true, true)
})

test('with their syntax settings or the flavor off, subscripts and small text stay as written', {
  timeout: 90000,
}, async () => {
  const literal = async (check) => {
    await page.reload()
    await waitForDocumentEditor(app, page)
    await page
      .locator('.rich-pane .cm-line', { hasText: 'Water is H~2~O' })
      .waitFor()
    assert.deepEqual(
      await page.evaluate(() => ({
        subscripts: document.querySelectorAll('.rich-pane .hibi-lp-subscript')
          .length,
        subtext: document.querySelectorAll('.rich-pane .markdown-subtext')
          .length,
        marker: [...document.querySelectorAll('.rich-pane .cm-line')].some(
          (line) => line.textContent === '-# a line of small text',
        ),
      })),
      { subscripts: 0, subtext: 0, marker: true },
      check,
    )
  }
  await open('parity.md')
  await page.locator('.rich-pane .hibi-lp-subscript').first().waitFor()
  await page.evaluate(() =>
    localStorage.setItem(
      'hibi:markdown-syntax-disabled',
      JSON.stringify(['text-extras.subscript', 'text-extras.subtext']),
    ),
  )
  await literal('syntax settings off')
  await page.evaluate(() =>
    localStorage.removeItem('hibi:markdown-syntax-disabled'),
  )
  const id = await page.evaluate(
    async () => (await window.hibi.getDocument()).id,
  )
  await page.evaluate((id) => {
    localStorage.setItem(
      `hibi:flavor:${id}`,
      JSON.stringify({ dialect: 'auto', syntax: [] }),
    )
  }, id)
  await literal('flavor off')
  await page.evaluate((id) => localStorage.removeItem(`hibi:flavor:${id}`), id)
  await page.reload()
  await waitForDocumentEditor(app, page)
})

test('20,000 subscripts: only those near the viewport render and typing redraws only its line', {
  timeout: 120000,
}, async () => {
  await page.evaluate(() => {
    window.subscriptRenders = 0
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node.nodeType === 1)
            window.subscriptRenders += node.matches('.hibi-lp-subscript')
              ? 1
              : node.querySelectorAll('.hibi-lp-subscript').length
    }).observe(document.body, { childList: true, subtree: true })
  })
  await open('many.md')
  await page
    .locator('.rich-pane .hibi-lp-h1', { hasText: 'Subscripts' })
    .waitFor()
  await page.locator('.rich-pane .hibi-lp-subscript').first().waitFor()
  await settle()
  const opened = await page.evaluate(() => ({
    subscripts: document.querySelectorAll('.rich-pane .hibi-lp-subscript')
      .length,
    subtext: document.querySelectorAll('.rich-pane .cm-line.markdown-subtext')
      .length,
    renders: window.subscriptRenders,
  }))
  // The note has 20,000 subscripts and 500 small-text lines; the view draws those it shows.
  assert.ok(
    opened.subscripts > 0 && opened.subscripts < 1000,
    JSON.stringify(opened),
  )
  assert.ok(opened.renders < 1000, JSON.stringify(opened))
  assert.ok(opened.subtext < 50, JSON.stringify(opened))
  // Typing at the end of a line redraws that line's four subscripts at most.
  await page.locator('.rich-pane .cm-line', { hasText: /^L3 a3 / }).click()
  await page.keyboard.press('End')
  await page.evaluate(() => {
    window.subscriptRenders = 0
  })
  for (const key of 'typed') await page.keyboard.type(key)
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('d~4~typed'),
  )
  await settle()
  const typed = await page.evaluate(() => window.subscriptRenders)
  assert.ok(typed <= 4 * 'typed'.length, `${typed} subscripts redrawn`)
  // Far down the note, the subscripts there render when they come into view.
  await page.evaluate(() => {
    window.subscriptRenders = 0
    const view = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    view.dispatch({
      selection: { anchor: view.state.doc.length },
      scrollIntoView: true,
    })
  })
  await page.locator('.rich-pane .cm-line', { hasText: /^L4999 / }).waitFor()
  await settle()
  const scrolled = await page.evaluate(() => ({
    subscripts: document.querySelectorAll('.rich-pane .hibi-lp-subscript')
      .length,
    renders: window.subscriptRenders,
  }))
  console.log(JSON.stringify({ opened, typed, scrolled }))
  assert.ok(scrolled.subscripts < 1000, JSON.stringify(scrolled))
  assert.ok(scrolled.renders < 1000, JSON.stringify(scrolled))
})
