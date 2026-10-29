import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  after,
  before,
  electron,
  waitForAsync,
  waitForDocumentEditor,
} from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
let app, page, folder

before(
  async () => {
    folder = await mkdtemp(join(tmpdir(), 'hibi-formatted-blocks-'))
    await mkdir(join(folder, 'notes'))
    app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
    })
    // Quitting with edited notes answers the unsaved-changes prompt.
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    page = await app.firstWindow()
    page.setDefaultTimeout(10000)
    await waitForDocumentEditor(app, page)
    await page.evaluate(() =>
      localStorage.setItem('hibi:formatted-engine', 'codemirror'),
    )
    await page.reload()
    await waitForDocumentEditor(app, page)
    // Hidden windows have no focus; markers under the caret need a focused editor.
    const session = await page.context().newCDPSession(page)
    await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  },
  { timeout: 60000 },
)

after(
  async () => {
    await app?.close()
    if (folder) await rm(folder, { recursive: true, force: true })
  },
  { timeout: 30000 },
)

/** Open a note in the formatted view and wait for `text` in it. */
async function open(name, markdown, text) {
  const file = join(folder, 'notes', name)
  await writeFile(file, markdown)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await pressShortcut(app, `${mod}+o`)
  await page
    .locator('.rich-pane:not([inert]) .hibi-formatted .cm-content', {
      hasText: text,
    })
    .waitFor()
}

const source = (text) =>
  waitForAsync(
    page,
    async (text) => (await window.hibi.getDocument()).markdown === text,
    text,
  )

const pane = (selector, options) =>
  page.locator(`.rich-pane:not([inert]) ${selector}`, options)

test('task checkboxes toggle their marker with one edit, undo, and the keyboard', {
  timeout: 60000,
}, async () => {
  const note = '- [ ] buy milk\n- [x] done\n- [ ]\n'
  await open('tasks.md', note, 'buy milk')
  const boxes = pane('input.hibi-lp-task')
  await boxes.nth(2).waitFor()
  assert.deepEqual(
    await boxes.evaluateAll((all) => all.map((box) => box.checked)),
    [false, true, false],
  )
  assert.equal(
    await boxes.first().getAttribute('aria-label'),
    'Task item checkbox for buy milk',
  )
  assert.equal(
    await boxes.nth(2).getAttribute('aria-label'),
    'Task item checkbox for empty task item',
  )
  // The marker and list bullet are not text; the checkbox is a real control.
  assert.deepEqual(
    await pane('.cm-line').evaluateAll((lines) =>
      lines.map((line) => line.textContent),
    ),
    ['buy milk', 'done', '', ''],
  )
  await boxes.first().click()
  await source('- [x] buy milk\n- [x] done\n- [ ]\n')
  assert.equal(await boxes.first().isChecked(), true)
  await pressShortcut(app, `${mod}+z`)
  await source(note)
  await waitForAsync(page, () => {
    const box = document.querySelector('.rich-pane input.hibi-lp-task')
    return box && !box.checked
  })
  // Escape, then Tab moves to the checkboxes; Space toggles the focused one.
  await pane('.cm-line', { hasText: 'done' }).click()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Tab')
  await waitForAsync(page, () =>
    document.activeElement?.classList.contains('hibi-lp-task'),
  )
  await page.keyboard.press('Space')
  await source('- [x] buy milk\n- [x] done\n- [ ]\n')
  // The box keeps focus, so the next one is a Tab away.
  assert.ok(
    await page.evaluate(() =>
      document.activeElement?.classList.contains('hibi-lp-task'),
    ),
  )
  await page.keyboard.press('Tab')
  await page.keyboard.press('Space')
  await source('- [x] buy milk\n- [ ] done\n- [ ]\n')
})

test('entities show their characters and reveal their source under the caret', {
  timeout: 60000,
}, async () => {
  await open('entities.md', 'Fish &amp; chips &copy; 2026\n', 'Fish')
  assert.deepEqual(
    await pane('.hibi-lp-entity').evaluateAll((all) =>
      all.map((glyph) => glyph.textContent),
    ),
    ['&', '©'],
  )
  assert.equal(
    await pane('.cm-line').first().textContent(),
    'Fish & chips © 2026',
  )
  // The caret beside an entity shows its source as a marker.
  await pane('.cm-line').first().click()
  await page.keyboard.press('Home')
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')
  await pane('.hibi-lp-marker', { hasText: '&amp;' }).waitFor()
  assert.equal(await pane('.hibi-lp-entity').count(), 1)
})

test('raw html stays editable source: chips, line breaks and typing inside a tag', {
  timeout: 60000,
}, async () => {
  const note = '<span>chip</span> text<br>next\n'
  await open('html.md', note, 'chip')
  // Chips can draw a frame after the text.
  await waitForAsync(
    page,
    () =>
      [...document.querySelectorAll('.rich-pane:not([inert]) .hibi-lp-html')]
        .map((chip) => chip.textContent)
        .join() === '<span>,</span>',
  )
  assert.equal(await pane('.hibi-lp-html-break br').count(), 1)
  // The line wraps at <br>; its first row starts with the chip.
  await pane('.hibi-lp-html').first().click()
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.type('x')
  await source('<sxpan>chip</span> text<br>next\n')
  await pressShortcut(app, `${mod}+z`)
  await source(note)
})

test('footnote notes open in the formatted view with references and notes in place', {
  timeout: 60000,
}, async () => {
  await open(
    'footnotes.md',
    'A claim[^1] here, a guess[^2].\n\n[^1]: The source\n    continued.\n',
    'A claim',
  )
  // A reference without a definition stays text, as in exports.
  assert.deepEqual(
    await pane('.hibi-lp-footnote-ref').evaluateAll((all) =>
      all.map((ref) => ref.textContent),
    ),
    ['1'],
  )
  assert.match(await pane('.cm-line').first().textContent(), /guess\[\^2\]/)
  assert.equal(
    await pane('.cm-line.hibi-lp-footnote-label').textContent(),
    'The source continued.',
  )
  // Notes are editable in place; defining the second label resolves its reference.
  await pane('.cm-line.hibi-lp-footnote-label').click()
  await page.keyboard.press('End')
  await page.keyboard.type(' More')
  await page.keyboard.press('Enter')
  await page.keyboard.type('[^2]: A hunch.')
  await source(
    'A claim[^1] here, a guess[^2].\n\n[^1]: The source\n    continued. More\n\n[^2]: A hunch.\n',
  )
  await waitForAsync(
    page,
    () =>
      document.querySelectorAll('.rich-pane .hibi-lp-footnote-ref').length ===
      2,
  )
})

test('frontmatter is hidden and protected; select all covers the text', {
  timeout: 60000,
}, async () => {
  await open('properties.md', '---\ntitle: x\n---\n\n# Body\n', 'Body')
  assert.ok(
    !(await pane('.cm-content').textContent()).includes('title'),
    'frontmatter hidden',
  )
  await pane('.hibi-lp-h1').click()
  await page.keyboard.press('Home')
  await page.keyboard.press('Backspace')
  await page.keyboard.press(`${mod}+a`)
  await page.keyboard.type('New')
  await source('---\ntitle: x\n---\n\nNew')
  // The properties editor above the view edits it; it stays hidden.
  const properties = pane('.frontmatter')
  await properties.locator('.frontmatter-yaml-toggle').click()
  await properties.getByLabel('Frontmatter YAML').fill('title: y\n')
  await properties.getByRole('button', { name: 'Apply YAML' }).click()
  await source('---\ntitle: y\n---\n\nNew')
  assert.ok(
    !(await pane('.cm-content').textContent()).includes('title'),
    'frontmatter hidden after a properties edit',
  )
})

test('github alerts show their title in place of the marker, in the alert box', {
  timeout: 60000,
}, async () => {
  await open('alerts.md', '> [!TIP] Remember\n> body text\n', 'body text')
  assert.equal(
    await pane('.hibi-lp-alert-title-text').textContent(),
    'Remember',
  )
  const lines = await pane('.cm-line').evaluateAll((all) =>
    all.slice(0, 2).map((line) => ({
      classes: [...line.classList].sort(),
      paint: line.style.getPropertyValue('--hibi-paint'),
      color: getComputedStyle(line).color,
      ink: getComputedStyle(document.documentElement)
        .getPropertyValue('--ink')
        .trim(),
    })),
  )
  for (const line of lines) {
    assert.ok(line.classes.includes('hibi-lp-alert-tip'), line.classes)
    assert.ok(!line.classes.includes('hibi-lp-quote'), line.classes)
    assert.match(line.paint, /3px/)
  }
  assert.ok(lines[0].classes.includes('hibi-lp-alert-title'))
})

test('images resolve beside the note, missing ones say so, and the caret reveals their source', {
  timeout: 60000,
}, async () => {
  await writeFile(
    join(folder, 'notes', 'pic.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      'base64',
    ),
  )
  const note =
    'Intro text\n\n![a picture](pic.png)\n\n![gone](missing.png)\n\n![two\nlines](pic.png) and ![next](\npic.png)\n'
  await open('media.md', note, 'Intro')
  const picture = pane('.document-media img[alt="a picture"]')
  // Descriptions and destinations on later lines resolve like one-line images.
  await waitForAsync(
    page,
    () =>
      [...document.querySelectorAll('.rich-pane .document-media img[src]')]
        .map((image) => image.alt)
        .join() === 'a picture,two lines,next',
  )
  await waitForAsync(
    page,
    () =>
      document.querySelector('.rich-pane .document-media img[alt="gone"]')
        ?.dataset.tooltip,
  )
  assert.equal(
    await pane('.document-media img[alt="gone"]').getAttribute('data-tooltip'),
    'Could not load this media. Check the file path. Save the note first if the path is relative to it.',
  )
  // Clicking the image puts the caret beside it, which reveals its source.
  await picture.click()
  await pane('.hibi-lp-marker', { hasText: '](pic.png)' }).waitFor()
  assert.equal(await picture.count(), 1)
  await page.keyboard.press('End')
  await page.keyboard.type(' after')
  const typed = note.replace('(pic.png)\n', '(pic.png) after\n')
  await source(typed)
})

test('task checkboxes are named by the text they show, without markdown', {
  timeout: 60000,
}, async () => {
  await open(
    'task-names.md',
    '- [ ] buy **milk** at [the store](https://example.com)\n- [x] call &amp; `write`\n- [ ] read [[b|alias]] today\n',
    'buy milk',
  )
  const boxes = pane('input.hibi-lp-task')
  await boxes.nth(2).waitFor()
  const cdp = await page.context().newCDPSession(page)
  const { nodes } = await cdp.send('Accessibility.getFullAXTree')
  assert.deepEqual(
    nodes
      .filter((node) => node.role?.value === 'checkbox' && !node.ignored)
      .map((node) => node.name?.value)
      .filter((name) => name?.startsWith('Task item checkbox')),
    [
      'Task item checkbox for buy milk at the store',
      'Task item checkbox for call & write',
      'Task item checkbox for read alias today',
    ],
  )
})
