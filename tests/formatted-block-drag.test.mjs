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

const note = `# hello **world**

second paragraph

third paragraph

- first item
- second item
  - nested item

1. one
2. two
3. three

> quoted text

\`\`\`js
const code = 1
\`\`\`

last paragraph`

let app, folder, page

const palette = (id) => {
  const scheme = bundledColorschemes.find((entry) => entry.id === id)
  return {
    id,
    appearance: scheme.appearance,
    css: `:root { color-scheme: ${scheme.appearance}; ${COLOR_TOKENS.map((key) => `--${key}: ${scheme.colors[key]};`).join(' ')} }`,
  }
}
/** Colors and backgrounds ease between states; compare them settled. */
const settled = () =>
  page.waitForFunction(
    () =>
      !document
        .getAnimations()
        .some((animation) => animation instanceof CSSTransition),
  )
const applyPalette = async (scheme) => {
  await page.evaluate(({ id, appearance, css }) => {
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
  await settled()
}

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

const markdown = async () =>
  (await page.evaluate(() => window.hibi.getDocument())).markdown
const saved = (text) =>
  waitForAsync(
    page,
    async (text) => (await window.hibi.getDocument()).markdown === text,
    text,
  )
const grip = () => page.locator('.rich-pane .block-drag-handle')
/** Wait for the handle to show beside the line at `top`-`bottom`. */
const shown = (top = -Infinity, bottom = Infinity) =>
  page.waitForFunction(
    ([top, bottom]) => {
      const handle = document.querySelector('.rich-pane .block-drag-handle')
      if (!handle || getComputedStyle(handle).visibility !== 'visible')
        return false
      const box = handle.getBoundingClientRect()
      return box.top >= top - 2 && box.top <= bottom
    },
    [top, bottom],
  )
/** Hover a line's text, `x` from its left edge, and wait for the handle beside it. */
const hover = async (line, x = 40) => {
  const box = await page.locator(line).first().boundingBox()
  const { top, pane } = await page
    .locator(line)
    .first()
    .evaluate((element) => {
      const { top, bottom } = element
        .closest('.rich-pane')
        .getBoundingClientRect()
      return {
        top: Number.parseFloat(element.style.paddingTop) || 0,
        pane: [top, bottom],
      }
    })
  const y = box.y + top + 14
  // The pointer reaches only what the scrolled pane shows.
  assert.ok(y > pane[0] && y < pane[1], `${line} at ${y}, pane ${pane}`)
  await page.mouse.move(0, 0)
  // Nested blocks give way to their parents within 12px of their edges.
  await page.mouse.move(box.x + x, y)
  await shown(box.y, box.y + box.height)
  await settled()
  return { ...box, top }
}

before(
  async () => {
    folder = await mkdtemp(join(tmpdir(), 'hibi-formatted-block-drag-'))
    await mkdir(join(folder, 'notes'))
    await mkdir(join(folder, 'profile'))
    await writeFile(
      join(folder, 'profile', 'addons.json'),
      JSON.stringify({ 'block-drag': true }),
    )
    await writeFile(join(folder, 'notes', 'note.md'), note)
    await writeFile(
      join(folder, 'notes', 'tall.md'),
      '# keyboard first\n\nkeyboard second\n\n' +
        '\x60\x60\x60txt\n' +
        Array.from({ length: 180 }, (_, i) => `code-line-${i}`).join('\n') +
        '\n\x60\x60\x60\n\nlast\n',
    )
    await writeFile(
      join(folder, 'notes', 'long.md'),
      // Under the size at which notes open in source view first.
      Array.from(
        { length: 5000 },
        (_, i) => `Paragraph ${i} with **bold** text.`,
      ).join('\n\n'),
    )
    app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
    })
    // Quitting with edited notes answers the unsaved-changes prompt.
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    page = await app.firstWindow()
    page.setDefaultTimeout(20000)
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
 * The window's pixels in `rect`, as drawn. Not page.screenshot: on Windows and
 * Linux its clip resizes the page while capturing, and a shown window then
 * gets a mouse move from wherever the desktop's pointer rests.
 */
async function capture(rect) {
  // A frame drawn after the last change.
  await page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  )
  const png = await app.evaluate(async ({ BrowserWindow }, rect) => {
    const window = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === 'app://hibi/',
    )
    const image = await window.webContents.capturePage(rect, {
      stayHidden: true,
    })
    return image.toPNG().toString('base64')
  }, rect)
  return Buffer.from(png, 'base64')
}

/**
 * Hover each block's first line of text and report where the handle goes,
 * relative to the pane, with its look at rest and under the pointer.
 */
async function handles(targets) {
  const out = []
  for (const target of targets) {
    const box = await hover(target)
    const { top } = box
    const measured = await grip().evaluate((handle) => {
      const pane = handle.closest('.rich-pane').getBoundingClientRect()
      const rect = handle.getBoundingClientRect()
      const style = getComputedStyle(handle)
      return {
        box: [
          rect.left - pane.left,
          rect.top - pane.top,
          rect.width,
          rect.height,
        ].map(Math.round),
        color: style.color,
        background: style.backgroundColor,
        transition: style.transitionDuration,
      }
    })
    const image = await capture({
      x: Math.round(box.x - 40),
      y: Math.round(box.y + top - 4),
      width: 40,
      height: 34,
    })
    // Under the pointer, the handle takes the hover colors.
    const handle = await grip().boundingBox()
    await page.mouse.move(handle.x + 11, handle.y + 13)
    await page.waitForFunction(() =>
      document.querySelector('.rich-pane .block-drag-handle').matches(':hover'),
    )
    await settled()
    const hovered = await grip().evaluate((handle) => {
      const style = getComputedStyle(handle)
      return [style.color, style.backgroundColor]
    })
    out.push({ target, ...measured, hovered, image })
  }
  return out
}

const difference = (a, b) =>
  app.evaluate(
    ({ nativeImage }, images) => {
      const [left, right] = images.map((image) =>
        nativeImage.createFromBuffer(Buffer.from(image, 'base64')).toBitmap(),
      )
      if (left.length !== right.length) return 1
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
    [a, b].map((image) => image.toString('base64')),
  )

test('the formatted view’s handle sits and looks like the rich view’s, in light and dark', {
  timeout: 120000,
}, async () => {
  await open('note.md')
  await page.locator('.tiptap h1').waitFor()
  const rich = {}
  for (const scheme of ['hibi-light', 'hibi-dark']) {
    await applyPalette(scheme)
    rich[scheme] = await handles([
      '.tiptap h1',
      '.tiptap > p >> nth=0',
      '.tiptap li >> nth=0',
      '.tiptap li li',
      '.tiptap pre',
    ])
  }
  await page.mouse.move(0, 0)
  await page.evaluate(() =>
    localStorage.setItem('hibi:formatted-engine', 'codemirror'),
  )
  await page.reload()
  await waitForDocumentEditor(app, page)
  await open('note.md')
  await page.locator('.rich-pane .hibi-lp-h1').waitFor()
  assert.equal(await page.locator('.rich-pane .tiptap').count(), 0)
  const report = []
  for (const scheme of ['hibi-light', 'hibi-dark']) {
    await applyPalette(scheme)
    const formatted = await handles([
      '.rich-pane .hibi-lp-h1',
      '.rich-pane .cm-line:has-text("second paragraph")',
      '.rich-pane .hibi-lp-list-item:has-text("first item")',
      '.rich-pane .hibi-lp-list-item:has-text("nested item")',
      '.rich-pane .hibi-lp-codeblock-first',
    ])
    formatted.forEach((handle, index) => {
      const expected = rich[scheme][index]
      for (const [i, value] of handle.box.entries())
        assert.ok(
          Math.abs(value - expected.box[i]) <= 1,
          `${scheme} ${handle.target}: ${handle.box} vs ${expected.box}`,
        )
      assert.equal(handle.color, expected.color, handle.target)
      assert.equal(handle.background, expected.background, handle.target)
      assert.deepEqual(handle.hovered, expected.hovered, handle.target)
      assert.notDeepEqual(handle.hovered, [handle.color, handle.background])
      assert.equal(handle.transition, expected.transition)
    })
    for (const [index, handle] of formatted.entries())
      report.push({
        scheme,
        target: handle.target,
        difference: await difference(handle.image, rich[scheme][index].image),
      })
  }
  console.log(JSON.stringify(report))
  for (const { scheme, target, difference } of report)
    assert.ok(difference < 0.02, `${scheme} ${target}: ${difference}`)
  await applyPalette('hibi-light')
})

test('the handle moves blocks with its menu, by dragging and from the keyboard, one undo step each', {
  timeout: 120000,
}, async () => {
  // Hidden windows have no focus; the editor's own focus needs emulating.
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const undo = async () => {
    await pressShortcut(app, `${mod}+z`)
    await saved(note)
  }
  const menu = async (line, label, x) => {
    await hover(line, x)
    await grip().click()
    await page.getByRole('menuitem', { name: label, exact: true }).click()
  }
  assert.equal(await markdown(), note)
  await menu('.rich-pane .hibi-lp-h1', 'Move block down')
  await saved(
    note.replace(
      '# hello **world**\n\nsecond paragraph',
      'second paragraph\n\n# hello **world**',
    ),
  )
  await undo()
  // An item moves within its list; a numbered one keeps the numbers.
  await menu(
    '.rich-pane .hibi-lp-list-item:has-text("first item")',
    'Move block down',
  )
  await saved(
    note.replace(
      '- first item\n- second item\n  - nested item',
      '- second item\n  - nested item\n- first item',
    ),
  )
  await undo()
  await menu('.rich-pane .hibi-lp-list-item:has-text("three")', 'Move block up')
  await saved(note.replace('2. two\n3. three', '2. three\n3. two'))
  await undo()

  // Dragging the heading shows where it lands, halfway between the blocks
  // around the drop, and the lower half of a block drops after it.
  await hover('.rich-pane .hibi-lp-h1')
  const handle = await grip().boundingBox()
  const third = await page
    .locator('.rich-pane .cm-line:has-text("third paragraph")')
    .boundingBox()
  const item = await page
    .locator('.rich-pane .hibi-lp-list-item:has-text("first item")')
    .boundingBox()
  const target = { x: third.x + 30, y: third.y + third.height - 3 }
  await page.mouse.move(handle.x + 11, handle.y + 13)
  await page.mouse.down()
  for (const step of [0.25, 0.5, 0.75, 1])
    await page.mouse.move(
      handle.x + 11 + (target.x - handle.x - 11) * step,
      handle.y + 13 + (target.y - handle.y - 13) * step,
    )
  // The test driver sends dragover only on release; send the one a pointer
  // resting there would.
  await page.evaluate(({ x, y }) => {
    document.elementFromPoint(x, y).dispatchEvent(
      new DragEvent('dragover', {
        clientX: x,
        clientY: y,
        bubbles: true,
        cancelable: true,
        dataTransfer: new DataTransfer(),
      }),
    )
  }, target)
  await page.waitForFunction(() => {
    const line = document.querySelector('.rich-pane .block-drag-drop')
    return line && !line.hidden
  })
  const drop = await page.locator('.rich-pane .block-drag-drop').boundingBox()
  assert.ok(
    drop.y > third.y + third.height - 1 && drop.y < item.y,
    `${drop.y} between ${third.y + third.height} and ${item.y}`,
  )
  assert.ok(Math.abs(drop.x - third.x) <= 1, `${drop.x} ${third.x}`)
  await page.mouse.up()
  await saved(
    note.replace(
      '# hello **world**\n\nsecond paragraph\n\nthird paragraph',
      'second paragraph\n\nthird paragraph\n\n# hello **world**',
    ),
  )
  assert.equal(
    await page.locator('.rich-pane .block-drag-drop').isVisible(),
    false,
  )
  await undo()

  // The palette's commands move the block at the caret; the handle hides
  // while typing, as in the rich view.
  await page.locator('.rich-pane .cm-line:has-text("third paragraph")').click()
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('.rich-pane .block-drag-handle'))
        .visibility === 'visible',
  )
  await page.keyboard.press('End')
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('.rich-pane .block-drag-handle'))
        .visibility === 'hidden',
  )
  await clickMenu(app, 'Command palette')
  await page
    .getByRole('combobox', { name: 'Search commands' })
    .fill('move block up')
  await page.getByRole('option', { name: /move block up/i }).click()
  await saved(
    note.replace(
      'second paragraph\n\nthird paragraph',
      'third paragraph\n\nsecond paragraph',
    ),
  )
  // The caret stays in the moved block, so the command repeats on it.
  await clickMenu(app, 'Command palette')
  await page
    .getByRole('combobox', { name: 'Search commands' })
    .fill('move block up')
  await page.getByRole('option', { name: /move block up/i }).click()
  await saved(
    note.replace(
      '# hello **world**\n\nsecond paragraph\n\nthird paragraph',
      'third paragraph\n\n# hello **world**\n\nsecond paragraph',
    ),
  )
  await pressShortcut(app, `${mod}+z`)
  await pressShortcut(app, `${mod}+z`)
  await saved(note)

  // The handle is a labelled button: Enter opens its menu. At the left edge
  // of a quote's text the handle moves the quote, as in the rich view.
  const quote = await page
    .locator('.rich-pane .cm-line:has-text("quoted text")')
    .boundingBox()
  await page.mouse.move(0, 0)
  await page.mouse.move(quote.x + 4, quote.y + quote.height / 2)
  await shown(quote.y, quote.y + quote.height)
  assert.ok((await grip().boundingBox()).x < quote.x - 30)
  await page
    .getByRole('button', { name: 'Drag block or open block actions' })
    .focus()
  await page.keyboard.press('Enter')
  const down = page.getByRole('menuitem', { name: 'Move block down' })
  await down.focus()
  await page.keyboard.press('Enter')
  await saved(
    note.replace(
      '> quoted text\n\n```js\nconst code = 1\n```',
      '```js\nconst code = 1\n```\n\n> quoted text',
    ),
  )
  await undo()

  // Source mode makes the formatted pane inert, and its handle with it.
  await hover('.rich-pane .hibi-lp-h1')
  await pressShortcut(app, `${mod}+Shift+]`)
  await page.waitForFunction(() => {
    const handle = document.querySelector('.rich-pane .block-drag-handle')
    return getComputedStyle(handle).visibility === 'hidden'
  })
  await pressShortcut(app, `${mod}+Shift+[`)
  await page.locator('.rich-pane .hibi-lp-h1').waitFor()
})

test('in a long note the handle follows the block under the pointer and moves it as one small edit', {
  timeout: 120000,
}, async () => {
  await open('long.md')
  // The note opens with the caret at its end, so its first line may be out of view.
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.startsWith('Paragraph 0 '),
  )
  await page
    .locator('.rich-pane .cm-line:has-text("Paragraph ")')
    .first()
    .waitFor()
  const before = await markdown()
  // Jump to the middle of the note, with the caret in the block above, whose
  // markers the focused view shows. Scrolling the caret into view would leave
  // the block below it past the pane's edge, so center that block instead.
  await page.evaluate(() => {
    const view = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    const doc = view.state.doc.toString()
    view.dispatch({
      selection: { anchor: doc.indexOf('Paragraph 2499 ') },
      effects: view.constructor.scrollIntoView(doc.indexOf('Paragraph 2500 '), {
        y: 'center',
      }),
    })
  })
  // Its markers hidden: the formatted view has laid out the blocks around it.
  const line = '.rich-pane .cm-line:has-text("Paragraph 2500 with bold text.")'
  await page.locator(line).waitFor()
  const text = await hover(line)
  const handle = await grip().boundingBox()
  assert.ok(
    Math.abs(handle.y - text.y - text.top) <= 1,
    `${handle.y} ${text.y}`,
  )
  assert.ok(Math.abs(handle.x + handle.width - text.x) <= 1)
  await grip().click()
  await page
    .getByRole('menuitem', { name: 'Move block down', exact: true })
    .click()
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes(
      'Paragraph 2501 with **bold** text.\n\nParagraph 2500 with',
    ),
  )
  const after = await markdown()
  assert.equal(after.length, before.length)
  // Only the two blocks changed places.
  let first = 0
  while (after[first] === before[first]) first++
  let last = 0
  while (after.at(-1 - last) === before.at(-1 - last)) last++
  assert.ok(
    before.length - first - last <= 80,
    String(before.length - first - last),
  )
  await pressShortcut(app, `${mod}+z`)
  await saved(before)
})

test('native tab activates the caret block without hover and tall blocks keep their handle', {
  timeout: 120000,
}, async () => {
  await page.evaluate(() =>
    localStorage.setItem('hibi:formatted-engine', 'codemirror'),
  )
  await page.reload()
  await waitForDocumentEditor(app, page)
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await open('tall.md')
  await page.locator('.rich-pane .hibi-lp-h1').waitFor()
  await page.mouse.move(0, 0)
  await page.locator('.rich-pane .cm-content').focus()
  await page.evaluate(() => {
    const view = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    view.dispatch({
      selection: {
        anchor: view.state.doc.toString().indexOf('keyboard second'),
      },
    })
  })
  await page.keyboard.press('End')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Tab')
  await page.waitForFunction(() =>
    document.activeElement?.classList.contains('block-drag-handle'),
  )
  await page.keyboard.press('Enter')
  await page
    .getByRole('menuitem', { name: 'Move block up', exact: true })
    .waitFor()
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent),
    'Move block up',
  )
  await page.keyboard.press('Enter')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.startsWith(
      'keyboard second\n\n# keyboard first',
    ),
  )
  assert.equal(
    await page.evaluate(() =>
      document.activeElement?.classList.contains('cm-content'),
    ),
    true,
  )
  await pressShortcut(app, `${mod}+z`)
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.startsWith(
      '# keyboard first\n\nkeyboard second',
    ),
  )

  await page.emulateMedia({ reducedMotion: 'reduce' })
  const opening = await page
    .locator('.rich-pane .hibi-lp-codeblock-first')
    .boundingBox()
  const code = await page
    .locator('.rich-pane .cm-line:has-text("code-line-0")')
    .boundingBox()
  await page.mouse.move(code.x + 45, code.y + code.height / 2)
  await shown(opening.y, opening.y + opening.height)
  const box = await grip().boundingBox()
  assert.ok(
    Math.abs(box.y - opening.y - 8) < 10,
    JSON.stringify({ box, opening }),
  )
  assert.equal(
    await grip().evaluate(
      (handle) => getComputedStyle(handle).transitionDuration,
    ),
    '0s',
  )
  // Its bottom is offscreen: geometry lookup must not render or scan the entire block.
  assert.ok(
    await page.evaluate(() => {
      const view = document.querySelector('.rich-pane .cm-content').cmTile.root
        .view
      return (
        view.viewport.to < view.state.doc.toString().indexOf('code-line-179')
      )
    }),
  )
})
