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
import {
  defaultPane,
  frozenOracle,
  frozenSnapshot,
  overlayScrollbars,
} from './frozen-oracle.mjs'
import { pressShortcut } from './keyboard.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
// What the formatted view drew while it matched the removed rich view, and the
// rich view's own results, recorded before its removal.
const check = frozenSnapshot('formatted-text-extras')
const recorded = frozenOracle('formatted-text-extras-rich')
const parityNote = `# Small parity

Water is H~2~O and CO~2~ here, with ~a long subscript~ too.

References read ~&amp;~ and ~a&#169;b~, and code keeps ~~a~ \`~~\` as text.

-# a line of small text &amp; &#169;

A paragraph, then
-# small text that ends it

> -# quoted small text

- -# listed small text &lt;
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
    // Colors are read once transitions to the new palette end.
    return Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation instanceof CSSTransition)
        .map((animation) => animation.finished.catch(() => {})),
    )
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
  await waitForAsync(
    page,
    async (name) => (await window.hibi.getDocument()).name === name,
    name,
  )
  await waitForDocumentEditor(app, page)
}

/** Reload the window with the marker setting. */
async function markers(shown) {
  await page.evaluate(
    (shown) => localStorage.setItem('markdown-markers', String(shown)),
    shown,
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
      args: [
        resolve('.'),
        '--force-device-scale-factor=1',
        `--user-data-dir=${join(folder, 'profile')}`,
      ],
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

/**
 * The distinct computed styles of subscripts and small text, and what the pane
 * draws in place of its pixels: each line's and inline element's tag, classes
 * and computed paint, and its box in the pane. The formatted view's text around
 * a reference is split around its characters, so it has more elements.
 */
const capture = (selectors) =>
  page.evaluate((selectors) => {
    const distinct = (selector, keys) => [
      ...new Set(
        [...document.querySelectorAll(selector)].map((element) => {
          const style = getComputedStyle(element)
          return JSON.stringify(keys.map((key) => style[key]))
        }),
      ),
    ]
    const pane = document.querySelector('.rich-pane')
    const origin = pane.getBoundingClientRect()
    const round = (value) => Math.round(value * 10) / 10
    const keys = [
      'color',
      'backgroundColor',
      'fontSize',
      'fontWeight',
      'fontStyle',
      'verticalAlign',
      'textDecorationLine',
      'opacity',
    ]
    const drawn = [
      ...pane.querySelectorAll('.cm-content > *, .cm-content > * *'),
    ]
    return {
      styles: {
        subscripts: distinct(selectors.subscript, [
          'verticalAlign',
          'fontSize',
          'color',
        ]),
        subtext: distinct(selectors.subtext, [
          'fontSize',
          'color',
          'lineHeight',
        ]),
      },
      drawn: drawn.map((element) => {
        const style = getComputedStyle(element)
        return {
          element: [
            element.tagName.toLowerCase(),
            ...[...element.classList]
              .filter((name) => !/^cm-(active|focused)/.test(name))
              .sort(),
          ].join('.'),
          ...Object.fromEntries(keys.map((key) => [key, style[key]])),
        }
      }),
      boxes: drawn.map((element) => {
        const box = element.getBoundingClientRect()
        return {
          left: round(box.left - origin.left),
          top: round(box.top - origin.top),
          width: round(box.width),
          height: round(box.height),
        }
      }),
    }
  }, selectors)

test('subscripts and small text keep the rich view’s recorded styles and drawing, in light and dark', {
  timeout: 120000,
}, async (t) => {
  await overlayScrollbars(t, page)
  await open('parity.md')
  await page
    .locator('.rich-pane .hibi-lp-h1', { hasText: 'Small parity' })
    .waitFor()
  await page.locator('.rich-pane .hibi-lp-subscript').first().waitFor()
  // The harness suites draw in the default window's pane, so on a screen
  // that fits the default window the app's pane is that size too.
  const screen = await app.evaluate(
    ({ screen }) => screen.getPrimaryDisplay().workAreaSize,
  )
  if (screen.height >= 720)
    assert.deepEqual(
      await page
        .locator('.rich-pane', {
          has: page.locator('.hibi-lp-h1', { hasText: 'Small parity' }),
        })
        .evaluate((pane) => {
          const box = pane.getBoundingClientRect()
          return { width: box.width, height: box.height }
        }),
      defaultPane,
    )
  for (const scheme of ['hibi-light', 'hibi-dark']) {
    await applyPalette(scheme)
    await settle()
    const formatted = await capture({
      subscript: '.rich-pane .hibi-lp-subscript',
      // Lines, or the text beside a list bullet.
      subtext: '.rich-pane .markdown-subtext',
    })
    check(`parity ${scheme} styles`, formatted.styles)
    check(`parity ${scheme} drawn`, formatted.drawn)
    check(`parity ${scheme} boxes`, formatted.boxes, {
      tolerance: 1,
    })
  }
  // The formatted view shows each reference's characters, as the rich view does.
  assert.deepEqual(
    await page.evaluate(() =>
      [...document.querySelectorAll('.rich-pane .hibi-lp-entity')].map(
        (glyph) => glyph.textContent,
      ),
    ),
    ['&', '©', '&', '©', '<'],
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
  // Clicking a reference's characters places the caret there, which shows
  // its source; the other references keep their characters.
  await page
    .locator('.rich-pane .hibi-lp-entity', { hasText: '©' })
    .first()
    .click()
  const line = page.locator('.rich-pane .cm-line', { hasText: 'a&#169;b' })
  await line.waitFor()
  assert.deepEqual(
    await line
      .locator('.hibi-lp-entity')
      .evaluateAll((glyphs) => glyphs.map((glyph) => glyph.textContent)),
    ['&'],
  )
  // With markers hidden, the caret does not reveal them.
  await markers(false)
  await open('parity.md')
  await page
    .locator('.rich-pane .cm-line', { hasText: 'a line of small text' })
    .click()
  await settle()
  assert.equal(await marker('-#').count(), 0)
  await markers(true)
})

test('decoded entity glyphs retain nested link, strong and emphasis styles', {
  timeout: 90000,
}, async () => {
  const source =
    '# Attributes\n\n~**&amp;**~ ~*&#169;*~ ~[&amp;](Other.md)~\n\n-# **&amp;** *&#169;* [&#169;](Other.md) `&amp;`\n\n| cell |\n| --- |\n| ~[&amp;](Other.md)~ **~&#169;~** |\n'
  await writeFile(join(folder, 'notes', 'attributes.md'), source)
  const styles = (selector) =>
    page.evaluate(
      (selector) =>
        [...document.querySelectorAll(selector)].map((node) => {
          const style = getComputedStyle(node)
          const decorations = new Set()
          for (
            let at = node;
            at && !at.matches('.rich-pane');
            at = at.parentElement
          )
            for (const line of getComputedStyle(at).textDecorationLine.split(
              ' ',
            ))
              if (line !== 'none') decorations.add(line)
          return {
            text: node.textContent,
            weight: style.fontWeight,
            style: style.fontStyle,
            color: style.color,
            decoration: [...decorations].sort().join(' '),
          }
        }),
      selector,
    )
  await markers(false)
  await open('attributes.md')
  await waitForAsync(
    page,
    () => document.querySelectorAll('.rich-pane .hibi-lp-entity').length >= 8,
  )
  // The rich view's subscripts, links, strong and emphasis styles, recorded
  // while the views matched.
  for (const scheme of ['hibi-light', 'hibi-dark']) {
    await applyPalette(scheme)
    check(
      `attributes ${scheme} entity styles`,
      await styles('.rich-pane .hibi-lp-entity'),
    )
  }
  assert.equal(
    await page.evaluate(async () => (await window.hibi.getDocument()).markdown),
    source,
  )
  await markers(true)
})

test('enter inside a subscript splits it into two subscripts, and undo joins them', {
  timeout: 90000,
}, async () => {
  await writeFile(
    join(folder, 'notes', 'split.md'),
    '# Split\n\nWater is ~abcd~ here.\n',
  )
  await open('split.md')
  await page
    .locator('.rich-pane .hibi-lp-subscript', { hasText: 'abcd' })
    .waitFor()
  await page.locator('.rich-pane .cm-line', { hasText: 'Water is' }).click()
  await page.evaluate(() => {
    const view = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    view.dispatch({
      selection: { anchor: view.state.doc.toString().indexOf('abcd') + 2 },
    })
  })
  await page.keyboard.press('Enter')
  // Before, the note became `~ab` and `cd~` and lost both subscripts.
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes(
      'Water is ~ab~\n\n~cd~ here.',
    ),
  )
  await page
    .locator('.rich-pane .hibi-lp-subscript', { hasText: 'cd' })
    .waitFor()
  assert.deepEqual(
    await page.evaluate(() =>
      [...document.querySelectorAll('.rich-pane .hibi-lp-subscript')].map(
        (element) => element.textContent,
      ),
    ),
    ['ab', 'cd'],
  )
  await pressShortcut(app, `${mod}+z`)
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes(
      'Water is ~abcd~ here.',
    ),
  )
})

test('backspace at the start of small text keeps the recorded rich view block behavior', {
  timeout: 90000,
}, async () => {
  const sources = [
    '-# abcd',
    'before\n\n-# abcd',
    '-# before\n\n-# abcd',
    '> -# abcd',
    '- -# abcd',
  ]
  const output = []
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await markers(false)
  for (const [index, source] of sources.entries()) {
    const name = `backspace-${index}.md`
    await writeFile(join(folder, 'notes', name), source)
    await open(name)
    await page.locator('.rich-pane .cm-content').waitFor()
    await waitForAsync(
      page,
      async (name) => (await window.hibi.getDocument()).name === name,
      name,
    )
    await page.evaluate(() => {
      const view = document.querySelector('.rich-pane .cm-content').cmTile.root
        .view
      view.focus()
      view.dispatch({
        selection: { anchor: view.state.doc.toString().indexOf('abcd') },
      })
    })
    await page.keyboard.press('Backspace')
    await page.evaluate(() => new Promise(requestAnimationFrame))
    const markdown = (await page.evaluate(() => window.hibi.getDocument()))
      .markdown
    output.push(markdown.trimEnd())
    assert.deepEqual(
      await page.evaluate(() => {
        const content = document.querySelector('.rich-pane .cm-content')
        return [
          document.activeElement === content,
          content.cmTile.root.view.state.selection.main.head,
        ]
      }),
      [true, markdown.indexOf('abcd')],
    )
    if (markdown !== source) {
      await pressShortcut(app, `${mod}+z`)
      await waitForAsync(
        page,
        async (source) => (await window.hibi.getDocument()).markdown === source,
        source,
      )
    }
  }
  console.log(JSON.stringify({ smallTextBackspace: output }))
  assert.deepEqual(
    output,
    sources.map((source) => recorded({ kind: 'backspace', source })),
  )
  await markers(true)
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
          (line) => line.textContent === '-# a line of small text & ©',
        ),
      })),
      { subscripts: 0, subtext: 0, marker: true },
      check,
    )
    assert.equal(
      await page.evaluate(
        async () => (await window.hibi.getDocument()).markdown,
      ),
      parityNote,
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
