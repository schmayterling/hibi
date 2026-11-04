import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const plain = '# Title\n\nsaved text\n\nend\n\n'
// Each of these starts the work that kept a failed view redrawing itself.
const withTable =
  '# Title\n\nA note[^1] and [link][x].\n\n| a | b |\n| - | - |\n| [^2] | [x] |\n\n[^1]: one\n[^2]: two\n[x]: https://example.test\n\nend\n\n'

/**
 * A feature drawing a widget at each `Q` in the note, built from `widget`, the
 * body of a WidgetType subclass, with `deco` as the rest of its decoration.
 * `key` is the length of the note, so a later widget is not the same as this.
 */
const widgetAddon = (
  presentation,
  { widget, deco = '' },
) => `export default (sdk) => ({ start(context) {
  const { StateField } = sdk.codeMirror.state
  const { Decoration, EditorView, WidgetType } = sdk.codeMirror.view
  class Bad extends WidgetType {
    constructor(key) { super(); this.key = key }
    ${widget}
  }
  const decorate = (state) => {
    const text = state.doc.toString()
    const at = text.indexOf('Q')
    return at < 0 ? Decoration.none : Decoration.set([Decoration.${deco ? 'replace' : 'widget'}({ widget: new Bad(text.length) ${deco} }).range(at, at + ${deco ? 1 : 0})])
  }
  const field = StateField.define({
    create: decorate,
    update: (_, transaction) => decorate(transaction.state),
    provide: (self) => EditorView.decorations.from(self),
  })
  context.editor.${presentation === 'formatted' ? 'registerFormatted' : 'registerSource'}({ id: 'bad', create: () => field })
} })`

const healthy = `toDOM() { const dom = document.createElement('span'); dom.className = 'bad-widget'; dom.style.cssText = 'display: inline-block; width: 20px; height: 10px'; return dom }`
const throwing = `toDOM() { throw new Error('widget boom') }`

async function open(t, { source, presentation = 'formatted', addon }) {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-widget-faults-'))
  const profile = join(folder, 'profile')
  const file = join(folder, 'note.md')
  await writeFile(file, source)
  const installed = join(profile, 'installed-addons', 'bad-ext')
  await mkdir(installed, { recursive: true })
  await writeFile(
    join(installed, 'hibi-addon.json'),
    JSON.stringify({
      id: 'bad-ext',
      name: 'Bad ext',
      description: 'Widget fault fixture',
      apiVersion: 3,
      capabilities: [presentation],
      version: '1.0.0',
      kind: 'extension',
      authors: [{ displayName: 'Test' }],
      entry: 'index.js',
    }),
  )
  await writeFile(join(installed, 'index.js'), widgetAddon(presentation, addon))
  await writeFile(
    join(installed, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['hibi-addon.json', 'index.js'],
      source: 'local',
    }),
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'bad-ext': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  const child = app.process()
  t.after(async () => {
    // A page that stopped answering never lets the app close by itself.
    await Promise.race([
      app
        .evaluate(({ dialog }) => {
          dialog.showMessageBox = async () => ({ response: 1 })
          dialog.showErrorBox = () => {}
        })
        .then(() => app.close()),
      new Promise((done) => setTimeout(done, 15000)),
    ])
    child.kill('SIGKILL')
    await rm(folder, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  const context = { app, page, file, errors: [] }
  page.on('pageerror', (error) => context.errors.push(error.message))
  await waitForDocumentEditor(app, page, { timeout: 20000 })
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await pressShortcut(app, `${mod}+o`)
  context.pane = presentation === 'formatted' ? '.rich-pane' : '.source-pane'
  // Renderer focus stays inside a hidden test window.
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  return context
}

async function answers(context) {
  assert.equal(
    await Promise.race([
      context.page.evaluate(() => 'answered'),
      new Promise((done) => setTimeout(() => done('no answer'), 5000)),
    ]),
    'answered',
  )
}

async function opened(context, source, presentation = 'formatted') {
  await answers(context)
  await waitForAsync(
    context.page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    source,
  )
  if (presentation === 'source')
    await context.page
      .getByRole('button', { name: 'Source view', exact: true })
      .click()
  await context.page
    .locator(
      `.editor-panes[data-source-ready="true"] ${context.pane} .cm-content[contenteditable="true"]`,
    )
    .waitFor({ timeout: 20000 })
}

/** Types `keys` one at a time at the end of the last line, as the DOM reads them. */
async function type(context, keys) {
  await context.page.evaluate((pane) => {
    const view = document.querySelector(`${pane} .cm-content`).cmTile.root.view
    const { doc } = view.state
    view.dispatch({ selection: { anchor: doc.length } })
    view.focus()
  }, context.pane)
  for (const key of keys) {
    await Promise.race([
      context.page.keyboard.insertText(key),
      new Promise((done) => setTimeout(done, 5000)),
    ])
    await answers(context)
    await context.page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    )
  }
}

const shownText = ({ page, pane }) =>
  page.evaluate(
    (pane) =>
      [...document.querySelectorAll(`${pane} .cm-line`)]
        .map((line) => line.textContent)
        .at(-1),
    pane,
  )

/** The note, the screen and the file all hold what was typed once it is saved. */
async function typingAndSavingWork(context, source, typed, shown = typed) {
  const expected = `${source}${typed}`
  await waitForAsync(
    context.page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    expected,
  )
  assert.equal(await shownText(context), shown)
  await pressShortcut(context.app, `${mod}+s`)
  await waitForAsync(
    context.page,
    async () => !(await window.hibi.getDocument()).dirty,
  )
  assert.equal(await readFile(context.file, 'utf8'), expected)
  await answers(context)
  assert.deepEqual(context.errors, [])
}

for (const presentation of ['formatted', 'source'])
  for (const [name, source] of [
    ['a plain note', plain],
    ['a note with a table, a footnote and a reference', withTable],
  ])
    test(`a ${presentation} widget that fails to draw in ${name} shows empty: the page answers, typing reaches the note and the file, and the user is told`, {
      timeout: 60000,
    }, async (t) => {
      const context = await open(t, {
        source,
        presentation,
        addon: { widget: throwing },
      })
      await opened(context, source, presentation)
      await type(context, 'before ')
      await type(context, 'Q')
      await type(context, 'more')
      await typingAndSavingWork(context, source, 'before Qmore')
      assert.match(
        await context.page.locator('.document-notice').textContent(),
        /widget boom/,
      )
    })

test('a note already holding a widget that fails opens, answers and saves', {
  timeout: 60000,
}, async (t) => {
  const source = `${withTable}Q held\n\n`
  const context = await open(t, { source, addon: { widget: throwing } })
  await opened(context, source)
  await type(context, 'x')
  await typingAndSavingWork(context, source, 'x')
})

test('a widget that fails when scrolling draws it leaves the note working', {
  timeout: 60000,
}, async (t) => {
  const far = Array.from({ length: 400 }, (_, i) => `line ${i}\n\n`).join('')
  const source = `${far}Q far\n\nend\n\n`
  const context = await open(t, { source, addon: { widget: throwing } })
  await opened(context, source)
  // Nothing has drawn it yet, so nothing has failed.
  assert.equal(await context.page.locator('.document-notice').count(), 0)
  await context.page.evaluate((pane) => {
    const view = document.querySelector(`${pane} .cm-content`).cmTile.root.view
    view.dispatch({
      effects: view.constructor.scrollIntoView(view.state.doc.length),
    })
  }, context.pane)
  await context.page.locator('.document-notice').waitFor({ timeout: 10000 })
  await type(context, 'x')
  await typingAndSavingWork(context, source, 'x')
})

test('a widget replacing text that fails to draw keeps that text in the note and in the file', {
  timeout: 60000,
}, async (t) => {
  const context = await open(t, {
    source: plain,
    addon: { widget: throwing, deco: ', inclusive: false' },
  })
  await opened(context, plain)
  await type(context, 'Qmore')
  await typingAndSavingWork(context, plain, 'Qmore', 'more')
})

/** A widget drawn fine, one of whose other methods fails. */
const otherMethods = {
  'updateDOM on a redraw': `${healthy}
    updateDOM() { throw new Error('widget boom') }`,
  'eq on a redraw': `${healthy}
    eq() { throw new Error('widget boom') }`,
  estimatedHeight: `${healthy}
    get estimatedHeight() { throw new Error('widget boom') }`,
  lineBreaks: `${healthy}
    get lineBreaks() { throw new Error('widget boom') }`,
  coordsAt: `${healthy}
    coordsAt() { throw new Error('widget boom') }`,
  ignoreEvent: `${healthy}
    ignoreEvent() { throw new Error('widget boom') }`,
  destroy: `${healthy}
    destroy() { throw new Error('widget boom') }`,
  'toDOM returning no element': 'toDOM() { return null }',
}

for (const [method, widget] of Object.entries(otherMethods))
  test(`a widget whose ${method} fails leaves typing, saving and the page working`, {
    timeout: 60000,
  }, async (t) => {
    const context = await open(t, { source: withTable, addon: { widget } })
    await opened(context, withTable)
    await type(context, 'Qab')
    const widgetBox = await context.page.evaluate((pane) => {
      const view = document.querySelector(`${pane} .cm-content`).cmTile.root
        .view
      const at = view.state.doc.toString().indexOf('Q')
      // These are what reach coordsAt and ignoreEvent.
      const coords = view.coordsAtPos(at, -1)
      const box =
        document
          .querySelector(`${pane} .bad-widget`)
          ?.getBoundingClientRect() ?? coords
      return { x: box.left + 2, y: (box.top + box.bottom) / 2 }
    }, context.pane)
    await context.page.mouse.click(widgetBox.x, widgetBox.y)
    await context.page.keyboard.press('ArrowUp')
    await context.page.keyboard.press('ArrowDown')
    await type(context, 'cd')
    await typingAndSavingWork(context, withTable, 'Qabcd')
    // Taking the widget away is what reaches destroy.
    await context.page.evaluate((pane) => {
      const view = document.querySelector(`${pane} .cm-content`).cmTile.root
        .view
      const at = view.state.doc.toString().indexOf('Q')
      view.focus()
      view.dispatch({ selection: { anchor: at + 1 } })
    }, context.pane)
    await context.page.keyboard.press('Backspace')
    await type(context, 'e')
    await typingAndSavingWork(context, withTable, 'abcde')
  })
