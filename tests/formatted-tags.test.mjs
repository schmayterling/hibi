import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { bundledColorschemes } from '../src/shared/color-palettes.ts'
import { COLOR_TOKENS } from '../src/shared/colorschemes.ts'
import { noteTags } from '../src/shared/note-tags.ts'
import {
  after,
  before,
  electron,
  waitForAsync,
  waitForDocumentEditor,
} from './electron.mjs'
import { frozenSnapshot, overlayScrollbars } from './frozen-oracle.mjs'
import { pressShortcut } from './keyboard.mjs'
import { uiName } from './ui.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
// What the formatted view drew while it matched the removed rich view.
const check = frozenSnapshot('formatted-tags')

const parityNote = `# Tags parity #heading

Plain #alpha and #beta/nested in a paragraph.
A second line #gamma, and #日本語.

**#bold**, *#italic*, ~~#struck~~ and ***#both***.

foo#not (#paren) [#bracket] {#brace} [#reference][r]

\`#code\` [#link](https://example.com) ![#image](x.png) <https://example.com/#auto>

- item #item
- [ ] #task
- [x] done #done

> quoted #quote
>#lazy

| head #cellhead |
| --- |
| #cell |

## Heading #h2 ##

Setext #setext
===

a hard break
#afterbreak

-# small text #small

- -# listed small text #smalllist
- -# #smallonly

> -# quoted small text #smallquote

\`\`\`
#fenced
\`\`\`
`

/**
 * The removed rich view's text model decoded escapes and entities and kept
 * inline HTML as raw chips; the formatted view finds tags in the source text,
 * as the workspace index does.
 */
const differencesNote = `# Differences

a \\#escaped \\*#afterescape #foo\\_bar &#35;numeric &nbsp;#nbsp <b>#html</b>
`

/**
 * Tagged paragraphs of one length, so notes of different sizes show the same
 * text around their middle paragraph.
 */
const tagged = (count) =>
  `# Tagged\n\n${Array.from(
    { length: count },
    (_, index) =>
      `p${String(index).padStart(5, '0')} #t${String(index % 50).padStart(2, '0')} **#b${index % 7}**`,
  ).join('\n\n')}\n`

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

const tree = () => page.getByRole('tree', { name: /workspace files/i })

/** Open the test workspace with the File menu's shortcut. */
async function openWorkspace() {
  await app.evaluate(
    ({ dialog }, root) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [root],
      })
    },
    join(folder, 'notes'),
  )
  await pressShortcut(app, `${mod}+Shift+o`)
  await tree().waitFor()
}

/** Open a note of the workspace with the File menu's shortcut. */
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
}

/** Run a palette command by its label. */
async function choose(name) {
  await pressShortcut(app, `${mod}+k`)
  await page.getByRole('combobox', { name: /search commands/i }).fill(name)
  await page
    .getByRole('option')
    .filter({ has: page.getByText(uiName(name, true), { exact: true }) })
    .first()
    .click()
}

/** Tags in the pane that are inside small text, in document order. */
const smallTags = (selector) =>
  page.evaluate(
    (selector) =>
      [...document.querySelectorAll(selector)]
        .filter((element) => element.closest('.markdown-subtext'))
        .map((element) => element.dataset.tag),
    selector,
  )

/** Tags in the pane, in document order, with their attributes, computed styles and size. */
const sampleTags = (selector) =>
  page.evaluate(
    (selector) =>
      [...document.querySelectorAll(selector)].map((element) => {
        const style = getComputedStyle(element)
        const box = element.getBoundingClientRect()
        return {
          text: element.textContent,
          tag: element.dataset.tag,
          tooltip: element.dataset.tooltip,
          color: style.color,
          backgroundColor: style.backgroundColor,
          borderRadius: style.borderRadius,
          fontFamily: style.fontFamily,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          fontStyle: style.fontStyle,
          letterSpacing: style.letterSpacing,
          width: Math.round(box.width * 10) / 10,
          height: Math.round(box.height * 10) / 10,
        }
      }),
    selector,
  )

before(
  async () => {
    folder = await mkdtemp(join(tmpdir(), 'hibi-formatted-tags-'))
    await mkdir(join(folder, 'notes'))
    await writeFile(join(folder, 'notes', 'parity.md'), parityNote)
    await writeFile(join(folder, 'notes', 'differences.md'), differencesNote)
    for (const [name, count] of [
      ['short.md', 2000],
      ['long.md', 8000],
    ])
      await writeFile(join(folder, 'notes', name), tagged(count))
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
    // The parity note's small text needs the text extras syntax.
    await page.evaluate(() => window.hibi.setAddonEnabled('text-extras', true))
    await page
      .locator('style[data-addon-style="text-extras.text-extras"]')
      .waitFor({ state: 'attached' })
    // Tall enough that every line of the parity note renders. macOS keeps a
    // shown window, as hosted runners show them, within the screen; the
    // page's own viewport can be taller.
    await page.setViewportSize({ width: 1100, height: 2000 })
    await openWorkspace()
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

test('tags render in the formatted view with the rich view’s recorded styles and sizes, in light and dark', {
  timeout: 180000,
}, async (t) => {
  await overlayScrollbars(t, page)
  const expected = noteTags(parityNote)
  await open('parity.md')
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll('.rich-pane .hibi-formatted .hibi-tag')
        .length === count,
    expected.length,
  )
  // Small text renders as small text, its tags inside it, also where a listed
  // one holds only a tag.
  assert.deepEqual(await smallTags('.rich-pane .hibi-formatted .hibi-tag'), [
    'small',
    'smalllist',
    'smallonly',
    'smallquote',
  ])
  for (const scheme of ['hibi-light', 'hibi-dark']) {
    await applyPalette(scheme)
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => done())),
    )
    const formatted = await sampleTags('.rich-pane .hibi-formatted .hibi-tag')
    // The tags the workspace index finds, in the rich view's order, with its
    // attributes, computed styles and sizes.
    assert.deepEqual(
      [...new Set(formatted.map(({ tag }) => tag))].sort(),
      expected,
    )
    check(
      `parity ${scheme} tags`,
      formatted.map(({ width, height, ...style }) => style),
    )
    check(
      `parity ${scheme} sizes`,
      // Hibi's fonts have no CJK glyphs: each system's fallback font sets
      // that tag's width, so only its height is compared.
      formatted.map(({ tag, width, height }) =>
        tag === '日本語' ? { height } : { width, height },
      ),
      { tolerance: 0.5 },
    )
  }

  // Where the rich view decoded escapes and entities or kept inline HTML as
  // a chip, the formatted view shows the text as written and its tags are the
  // ones the workspace index finds.
  await open('differences.md')
  await page
    .locator('.rich-pane .hibi-lp-h1', { hasText: 'Differences' })
    .waitFor()
  await page.locator('.rich-pane .hibi-formatted .hibi-tag').first().waitFor()
  const formattedDifferences = (
    await sampleTags('.rich-pane .hibi-formatted .hibi-tag')
  ).map(({ tag }) => tag)
  assert.deepEqual(formattedDifferences, ['afterescape', 'foo', 'html'])
  assert.deepEqual(noteTags(differencesNote), [
    'afterescape',
    'foo',
    'html',
    'numeric',
  ])
})

test('shift-click on a tag browses it, also in a table cell, and a plain click places the caret', {
  timeout: 90000,
}, async () => {
  await open('parity.md')
  await page.locator('.rich-pane .hibi-tag[data-tag="alpha"]').waitFor()
  const sidebar = page.getByRole('complementary', {
    name: /^tags$/i,
    exact: true,
  })
  await page.locator('.rich-pane .hibi-tag[data-tag="alpha"]').click()
  const caret = await page.evaluate(() => {
    const view = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    return {
      head: view.state.selection.main.head,
      tag: view.state.doc.toString().indexOf('#alpha'),
    }
  })
  assert.ok(
    caret.head >= caret.tag && caret.head <= caret.tag + '#alpha'.length,
    JSON.stringify(caret),
  )
  assert.equal(await sidebar.count(), 0)
  await page
    .locator('.rich-pane .hibi-tag[data-tag="alpha"]')
    .click({ modifiers: ['Shift'] })
  await sidebar
    .getByRole('region', { name: 'Notes tagged #alpha' })
    .getByRole('button', { name: /^parity\.md$/i })
    .waitFor()
  // A table renders its cells in a widget, outside the editor's own handlers.
  await page
    .locator('.rich-pane table .hibi-tag[data-tag="cell"]')
    .click({ modifiers: ['Shift'] })
  await sidebar
    .getByRole('region', { name: 'Notes tagged #cell' })
    .getByRole('button', { name: /^parity\.md$/i })
    .waitFor()
  await page.keyboard.press('Escape')
})

test('active table tag shift-click survives selection, typing and undo', {
  timeout: 90000,
}, async () => {
  await open('parity.md')
  const original = await page.evaluate(
    async () => (await window.hibi.getDocument()).markdown,
  )
  await page.locator('.rich-pane table .hibi-tag[data-tag="cell"]').click()
  const cell = page.locator('.rich-pane .hibi-lp-cell-editor .cm-content')
  await cell.waitFor()
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+ArrowRight')
  assert.ok(
    await cell.evaluate(
      (element) => !element.cmTile.root.view.state.selection.main.empty,
    ),
  )
  await page.keyboard.type('z')
  await waitForAsync(
    page,
    async (text) => (await window.hibi.getDocument()).markdown !== text,
    original,
  )
  await page.keyboard.press(`${mod}+z`)
  await waitForAsync(
    page,
    async (text) => (await window.hibi.getDocument()).markdown === text,
    original,
  )
  await page
    .locator('.rich-pane .hibi-lp-cell-editor .hibi-tag[data-tag="cell"]')
    .click({ modifiers: ['Shift'] })
  await page
    .getByRole('complementary', { name: /^tags$/i })
    .getByRole('region', { name: 'Notes tagged #cell' })
    .getByRole('button', { name: /^parity\.md$/i })
    .waitFor()
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    original,
  )
  await page.keyboard.press('Escape')
})

test('long names resolve off the input path and keep their complete tag identity', {
  timeout: 90000,
}, async () => {
  const name = 'ΟΣ'.repeat(16000)
  const markdown = 'prefix #' + name + ' suffix'
  await writeFile(join(folder, 'notes', 'long-name.md'), markdown)
  await page.evaluate(() => {
    const original = String.prototype.matchAll
    window.longTagScan = {
      units: 0,
      restore: () => {
        String.prototype.matchAll = original
      },
    }
    String.prototype.matchAll = function (pattern) {
      if (pattern instanceof RegExp && pattern.source.includes('#('))
        window.longTagScan.units += this.length
      return original.call(this, pattern)
    }
  })
  try {
    await open('long-name.md')
    await page.waitForFunction(
      (expected) =>
        document
          .querySelector('.rich-pane .hibi-tag')
          ?.getAttribute('data-tag') === expected,
      name.toLowerCase(),
    )
    await page.evaluate((at) => {
      window.longTagScan.units = 0
      const view = document.querySelector('.rich-pane .cm-content').cmTile.root
        .view
      view.dispatch({ changes: { from: at, insert: 'A' } })
    }, 8 + name.length)
    await page.waitForFunction(
      (expected) =>
        document
          .querySelector('.rich-pane .hibi-tag')
          ?.getAttribute('data-tag') === expected,
      (name + 'A').toLowerCase(),
    )
    assert.ok(await page.evaluate(() => window.longTagScan.units < 2048))
    assert.equal(
      (await page.evaluate(() => window.hibi.getDocument())).markdown,
      'prefix #' + name + 'A suffix',
    )
  } finally {
    await page.evaluate(() => window.longTagScan.restore())
  }
})

test('table tags follow live bold syntax changes in static and active cells', {
  timeout: 90000,
}, async () => {
  await writeFile(
    join(folder, 'notes', 'literal-tags.md'),
    '**#hidden** #plain\n\n| h |\n| - |\n| **#hidden** #plain |',
  )
  await open('literal-tags.md')
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.rich-pane .hibi-tag[data-tag="hidden"]')
        .length === 2,
  )
  const toggle = async (enabled) => {
    await choose('settings')
    await page.getByRole('tab', { name: /^syntax$/i, exact: true }).click()
    await page
      .getByRole('checkbox', { name: /^bold$/i, exact: true })
      .setChecked(enabled)
    await page
      .getByRole('button', { name: /^back to app$/i, exact: true })
      .click()
  }
  try {
    await toggle(false)
    await page.waitForFunction(
      () => !document.querySelector('.rich-pane .hibi-tag[data-tag="hidden"]'),
    )
    await page.locator('.rich-pane table .hibi-tag[data-tag="plain"]').click()
    await page.locator('.rich-pane .hibi-lp-cell-editor .cm-content').waitFor()
    assert.equal(
      await page
        .locator('.rich-pane .hibi-lp-cell-editor .hibi-tag[data-tag="hidden"]')
        .count(),
      0,
    )
  } finally {
    await toggle(true)
  }
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.rich-pane .hibi-tag[data-tag="hidden"]')
        .length === 2,
  )
})

test('turning tags off shows them as text in the formatted view, and on styles them again', {
  timeout: 90000,
}, async () => {
  await open('parity.md')
  const tags = page.locator('.rich-pane .hibi-formatted .hibi-tag')
  await tags.first().waitFor()
  await choose('disable tags')
  await waitForAsync(page, async () =>
    (await window.hibi.getAddonStates()).some(
      (addon) => addon.id === 'tags' && !addon.enabled,
    ),
  )
  await page.waitForFunction(
    () => !document.querySelector('.rich-pane .hibi-formatted .hibi-tag'),
  )
  assert.ok(
    await page
      .locator('.rich-pane .cm-line', { hasText: 'Plain #alpha and' })
      .count(),
  )
  await choose('enable tags')
  await page
    .locator('.rich-pane .hibi-formatted .hibi-tag[data-tag="alpha"]')
    .waitFor()
})

test('typing scans only rendered tagged paragraphs in notes of different sizes', {
  timeout: 180000,
}, async () => {
  await page.evaluate(() => {
    if (window.tagScan) return
    const matchAll = String.prototype.matchAll
    window.tagScan = { calls: 0, characters: 0, redraws: [] }
    String.prototype.matchAll = function (pattern) {
      if (pattern instanceof RegExp && pattern.source.includes('#(')) {
        const scan = window.tagScan
        scan.calls++
        scan.characters += this.length
        // One redraw scans its tags within one task.
        if (!scan.redraw) {
          scan.redraw = { calls: 0, characters: 0 }
          scan.redraws.push(scan.redraw)
          queueMicrotask(() => {
            scan.redraw = null
          })
        }
        scan.redraw.calls++
        scan.redraw.characters += this.length
      }
      return matchAll.call(this, pattern)
    }
  })
  const reset = () =>
    page.evaluate(() => {
      window.tagScan = { calls: 0, characters: 0, redraws: [] }
    })
  /** Wait until renders stop, and give what they scanned since the last reset. */
  const settled = async () => {
    let calls = -1
    for (let round = 0; round < 20; round++) {
      await page.evaluate(
        () =>
          new Promise((done) =>
            requestIdleCallback(() => requestAnimationFrame(() => done()), {
              timeout: 2000,
            }),
          ),
      )
      const now = await page.evaluate(() => window.tagScan.calls)
      if (now === calls) break
      calls = now
    }
    return page.evaluate(() => window.tagScan)
  }
  const visibleWorkload = () =>
    page.evaluate(() => {
      const view = document.querySelector('.rich-pane .cm-content').cmTile.root
        .view
      const text = view.visibleRanges
        .map(({ from, to }) => view.state.doc.sliceString(from, to))
        .join('\n')
      return {
        paragraphs: text.match(/^p\d{5}(?= )/gm) ?? [],
        expectedTags: (text.match(/(?<!\w)#[tb]\d+/g) ?? []).map((tag) =>
          tag.slice(1),
        ),
        tags: [...view.dom.querySelectorAll('.hibi-tag')].map(
          (tag) => tag.dataset.tag,
        ),
        heading: text.startsWith('# Tagged\n\n'),
      }
    })
  const measure = async (name, count) => {
    await open(name)
    await page.locator('.rich-pane .hibi-formatted .hibi-tag').first().waitFor()
    await settled()
    const caret = (text) =>
      page.evaluate((text) => {
        const view = document.querySelector('.rich-pane .cm-content').cmTile
          .root.view
        const at = view.state.doc.toString().indexOf(text) + text.length
        view.focus()
        view.dispatch({ selection: { anchor: at }, scrollIntoView: true })
      }, text)
    // CodeMirror may buffer different numbers of paragraphs in the two notes.
    // Record the actual source window independently of the rendered tags.
    await caret('p00020 ')
    await settled()
    const visible = await visibleWorkload()
    assert.ok(visible.heading && visible.paragraphs.length > 0)
    assert.deepEqual(visible.tags, visible.expectedTags)
    assert.equal(visible.tags.length, 2 * visible.paragraphs.length)
    const typed = []
    for (const key of 'typed') {
      await reset()
      await page.keyboard.type(key)
      const work = await settled()
      const next = await visibleWorkload()
      assert.deepEqual(next.paragraphs, visible.paragraphs)
      assert.deepEqual(next.tags, next.expectedTags)
      // Typing directly before #t20 joins it to the preceding word.
      assert.equal(next.tags.length, 2 * next.paragraphs.length - 1)
      typed.push({ ...work, paragraphs: next.paragraphs.length })
    }
    await waitForAsync(page, async () =>
      (await window.hibi.getDocument()).markdown.includes('p00020 typed'),
    )
    // The middle of the note renders its tags when it comes into view.
    const middle = `p${String(count / 2).padStart(5, '0')} `
    await reset()
    await caret(middle)
    await page
      .locator('.rich-pane .cm-line', { hasText: middle.trim() })
      .locator('.hibi-tag')
      .first()
      .waitFor()
    return {
      length: await page.evaluate(
        async () => (await window.hibi.getDocument()).markdown.length,
      ),
      shown: visible.tags.length,
      paragraphs: visible.paragraphs.length,
      typed,
      jumped: await settled(),
    }
  }
  const short = await measure('short.md', 2000)
  const long = await measure('long.md', 8000)
  console.log(JSON.stringify({ short, long }))
  // Both open in the formatted view, below the source-first opening size.
  assert.ok(long.length < 256 * 1024 && long.length > 3.9 * short.length)
  // Each redraw scans each visible paragraph's two tagged runs (15 characters
  // total), the heading's seven-character run and every key typed so far.
  // The formatted view redraws for each parse step it publishes, so a busy
  // page can redraw a key's text twice, or the text before it once more.
  for (const sample of [short, long]) {
    assert.equal(sample.shown, 2 * sample.paragraphs)
    sample.typed.forEach(({ redraws, paragraphs }, index) => {
      const typed = redraws.map(({ calls, characters }) =>
        calls === 2 * paragraphs + 1 ? characters - 15 * paragraphs - 7 : NaN,
      )
      assert.ok(
        typed.includes(index + 1) &&
          typed.every((count) => count === index || count === index + 1),
        JSON.stringify(sample.typed),
      )
      for (const redraw of redraws)
        assert.ok(
          redraw.characters < sample.length / 50,
          JSON.stringify(redraw),
        )
    })
    // That happens now and then, not for every key: whatever the note's size,
    // its keys take at most two redraws more than one each.
    const redraws = sample.typed.reduce(
      (count, key) => count + key.redraws.length,
      0,
    )
    assert.ok(redraws <= sample.typed.length + 2, JSON.stringify(sample.typed))
  }
  for (const { jumped, length } of [short, long])
    assert.ok(
      jumped.calls > 0 && jumped.characters < length / 10,
      JSON.stringify(jumped),
    )
})
