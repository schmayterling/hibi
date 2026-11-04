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

async function install(profile, id, capabilities, code) {
  const installed = join(profile, 'installed-addons', id)
  await mkdir(installed, { recursive: true })
  await writeFile(
    join(installed, 'hibi-addon.json'),
    JSON.stringify({
      id,
      name: id,
      description: 'Widget fault fixture',
      apiVersion: 3,
      capabilities,
      version: '1.0.0',
      kind: 'extension',
      authors: [{ displayName: 'Test' }],
      entry: 'index.js',
    }),
  )
  await writeFile(join(installed, 'index.js'), code)
  await writeFile(
    join(installed, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['hibi-addon.json', 'index.js'],
      source: 'local',
    }),
  )
}

const registerIn = (presentation) =>
  presentation === 'formatted' ? 'registerFormatted' : 'registerSource'

/** A feature marking the editor, which stays when the one beside it fails. */
const goodAddon = (presentation) => `export default (sdk) => ({ start(context) {
  const { EditorView } = sdk.codeMirror.view
  context.editor.${registerIn(presentation)}({ id: 'good', create: () => EditorView.editorAttributes.of({ 'data-good': 'yes' }) })
} })`

/** A feature whose decoration source throws once the note reaches `when`, not a widget. */
const decorationsAddon = (
  presentation,
  when = `view.state.doc.toString().includes('Q')`,
) => `export default (sdk) => ({ start(context) {
  const { Decoration, EditorView } = sdk.codeMirror.view
  context.editor.${registerIn(presentation)}({ id: 'bad', create: () => EditorView.decorations.of((view) => {
    if (${when}) throw new Error('decorations boom')
    return Decoration.none
  }) })
} })`

async function open(
  t,
  {
    source,
    presentation = 'formatted',
    addon,
    code = addon && widgetAddon(presentation, addon),
    noAddons = false,
  },
) {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-widget-faults-'))
  const profile = join(folder, 'profile')
  const file = join(folder, 'note.md')
  await writeFile(file, source)
  if (!noAddons) {
    await install(profile, 'bad-ext', [presentation], code)
    await install(profile, 'good-ext', [presentation], goodAddon(presentation))
    await writeFile(
      join(profile, 'addons.json'),
      JSON.stringify({ 'bad-ext': true, 'good-ext': true }),
    )
  }
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
  // Opening the note clears what the startup note showed, and a toast closes.
  await page.waitForURL('app://hibi/', { waitUntil: 'commit' })
  await page.evaluate(() => {
    window.shownToasts = new Set()
    new MutationObserver(() => {
      for (const toast of document.querySelectorAll('.toast'))
        window.shownToasts.add(toast.textContent)
    }).observe(document, { childList: true, subtree: true })
  })
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

const editorReady = ({ page, pane }) =>
  page
    .locator(
      `.editor-panes[data-source-ready="true"] ${pane} .cm-content[contenteditable="true"]`,
    )
    .waitFor({ timeout: 20000 })

const named = (context, text) =>
  context.page.waitForFunction(
    (text) => [...window.shownToasts].some((shown) => shown.includes(text)),
    text,
    { timeout: 10000 },
  )

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
async function typingAndSavingWork(context, source, typed) {
  const expected = `${source}${typed}`
  await waitForAsync(
    context.page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    expected,
  )
  assert.equal(await shownText(context), typed)
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
      await named(context, 'bad-ext.bad: widget boom')
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
  // The pane's own scroll: no update, so CodeMirror draws it while it measures.
  await context.page.evaluate((pane) => {
    const scroller = document.querySelector(pane)
    scroller.scrollTop = scroller.scrollHeight
  }, context.pane)
  await named(context, 'bad-ext.bad: widget boom')
  await type(context, 'x')
  await typingAndSavingWork(context, source, 'x')
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

for (const presentation of ['formatted', 'source'])
  for (const [name, source] of [
    ['a plain note', plain],
    ['a note with a table, a footnote and a reference', withTable],
  ])
    test(`a ${presentation} decoration source that throws in ${name} is named and removed, and the rebuilt editor keeps the text, the caret and focus`, {
      timeout: 60000,
    }, async (t) => {
      const context = await open(t, {
        source,
        presentation,
        code: decorationsAddon(presentation),
      })
      await opened(context, source, presentation)
      await type(context, 'before ')
      await context.page.evaluate((pane) => {
        window.firstContent = document.querySelector(`${pane} .cm-content`)
        window.firstView = window.firstContent.cmTile.root.view
      }, context.pane)
      await type(context, 'Q')
      await named(context, 'bad-ext.bad: decorations boom')
      await answers(context)
      await editorReady(context)
      // The view that failed takes nothing more, from typing or from code.
      assert.deepEqual(
        await context.page.evaluate(
          async ({ pane, source }) => {
            window.firstView.dispatch({
              changes: { from: 0, insert: 'late ' },
            })
            return {
              replaced:
                window.firstContent !==
                document.querySelector(`${pane} .cm-content`),
              editable: window.firstContent.contentEditable,
              note: (await window.hibi.getDocument()).markdown.slice(
                0,
                source.length,
              ),
            }
          },
          { pane: context.pane, source },
        ),
        { replaced: true, editable: 'false', note: source },
      )
      // The caret and focus came back: this types with neither set again.
      await context.page.keyboard.insertText('more')
      await typingAndSavingWork(context, source, 'before Qmore')
      assert.equal(
        await context.page
          .locator(`${context.pane} .cm-editor[data-good]`)
          .count(),
        1,
      )
    })

test('keys typed right after a view fails are in the note and on screen, or in neither', {
  timeout: 60000,
}, async (t) => {
  const context = await open(t, {
    source: plain,
    code: decorationsAddon('formatted'),
  })
  await opened(context, plain)
  await type(context, 'before ')
  for (const key of 'Qmore') await context.page.keyboard.insertText(key)
  await named(context, 'bad-ext.bad: decorations boom')
  await editorReady(context)
  const note = (await context.page.evaluate(() => window.hibi.getDocument()))
    .markdown
  assert.ok(note.startsWith(`${plain}before Q`), note)
  await typingAndSavingWork(context, plain, note.slice(plain.length))
})

test('an addon plugin that dispatches while the view updates costs its own plugin, not the editor', {
  timeout: 60000,
}, async (t) => {
  const context = await open(t, {
    source: plain,
    code: `export default (sdk) => ({ start(context) {
      const { ViewPlugin } = sdk.codeMirror.view
      context.editor.registerFormatted({ id: 'bad', create: () => ViewPlugin.define(() => ({
        update(update) {
          if (update.state.doc.toString().includes('Q')) update.view.dispatch({ selection: { anchor: 0 } })
        },
      })) })
    } })`,
  })
  await opened(context, plain)
  await context.page.evaluate((pane) => {
    window.firstContent = document.querySelector(`${pane} .cm-content`)
  }, context.pane)
  await type(context, 'Qmore')
  await typingAndSavingWork(context, plain, 'Qmore')
  assert.equal(
    await context.page.evaluate(
      (pane) =>
        window.firstContent === document.querySelector(`${pane} .cm-content`),
      context.pane,
    ),
    true,
  )
})

test('a note already holding what a decoration source throws on opens, names it and saves', {
  timeout: 60000,
}, async (t) => {
  const source = `${withTable}Q held\n\n`
  const context = await open(t, { source, code: decorationsAddon('formatted') })
  await opened(context, source)
  await named(context, 'bad-ext.bad: decorations boom')
  await editorReady(context)
  // The view it failed in reports nothing more: no edit failed here.
  assert.equal(await context.page.locator('.document-notice').count(), 0)
  await type(context, 'x')
  await typingAndSavingWork(context, source, 'x')
})

test('a draw failure that going back one at a time does not bring out takes every feature out the next time, and ends', {
  timeout: 60000,
}, async (t) => {
  // The features go back before focus does.
  const context = await open(t, {
    source: plain,
    code: decorationsAddon(
      'formatted',
      `view.hasFocus && view.state.doc.toString().includes('Q')`,
    ),
  })
  await opened(context, plain)
  await type(context, 'before ')
  await context.page.keyboard.insertText('Q')
  await named(context, 'bad-ext.bad: decorations boom')
  await named(context, 'good-ext.good: decorations boom')
  await answers(context)
  await editorReady(context)
  await type(context, 'x')
  await typingAndSavingWork(context, plain, 'before Qx')
  assert.equal(
    await context.page.locator(`${context.pane} .cm-editor[data-good]`).count(),
    0,
  )
})

test('a decoration source that throws only for what scrolls into view is named and the editor comes back', {
  timeout: 60000,
}, async (t) => {
  const far = Array.from({ length: 400 }, (_, i) => `line ${i}\n\n`).join('')
  const source = `${far}end\n\n`
  const context = await open(t, {
    source,
    code: decorationsAddon(
      'formatted',
      'view.viewport.to === view.state.doc.length',
    ),
  })
  await opened(context, source)
  // The pane's own scroll: no update, so CodeMirror draws it while it measures.
  await context.page.evaluate((pane) => {
    const scroller = document.querySelector(pane)
    scroller.scrollTop = scroller.scrollHeight
  }, context.pane)
  await named(context, 'bad-ext.bad: decorations boom')
  await editorReady(context)
  await type(context, 'x')
  await typingAndSavingWork(context, source, 'x')
})

test('a widget that fails to draw is named and removed without a new editor, and what it replaced shows again', {
  timeout: 60000,
}, async (t) => {
  const context = await open(t, {
    source: plain,
    addon: { widget: throwing, deco: ', inclusive: false' },
  })
  await opened(context, plain)
  await context.page.evaluate((pane) => {
    window.firstContent = document.querySelector(`${pane} .cm-content`)
  }, context.pane)
  await type(context, 'Qmore')
  await named(context, 'bad-ext.bad: widget boom')
  await typingAndSavingWork(context, plain, 'Qmore')
  assert.equal(
    await context.page.evaluate(
      (pane) =>
        window.firstContent === document.querySelector(`${pane} .cm-content`),
      context.pane,
    ),
    true,
  )
  assert.equal(
    await context.page.locator(`${context.pane} .cm-editor[data-good]`).count(),
    1,
  )
  assert.equal(await context.page.locator('.document-notice').count(), 0)
})

for (const [name, withAddons] of [
  ['with no feature to take out', false],
  ['that stays once the features are out', true],
])
  test(`a draw failure ${name} ends in recovery, and the note is saved from there`, {
    timeout: 60000,
  }, async (t) => {
    const context = await open(t, {
      source: plain,
      ...(withAddons ? { addon: { widget: healthy } } : { noAddons: true }),
    })
    await opened(context, plain)
    // What a bug of the editor's own does: nothing an addon brought can be blamed.
    await context.page.evaluate((pane) => {
      const { docView } = document.querySelector(`${pane} .cm-content`).cmTile
        .root.view
      const prototype = Object.getPrototypeOf(docView)
      const { updateDeco } = prototype
      prototype.updateDeco = function (...args) {
        if (this.view.state.doc.toString().includes('Q'))
          throw new Error('editor boom')
        return updateDeco.apply(this, args)
      }
    }, context.pane)
    await type(context, 'before ')
    await context.page.keyboard.insertText('Q')
    await context.page
      .getByRole('button', { name: 'Save a copy' })
      .waitFor({ timeout: 10000 })
    await answers(context)
    const copy = `${context.file}.copy.md`
    await context.app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
    }, copy)
    await context.page.getByRole('button', { name: 'Save a copy' }).click()
    await context.page.getByText('Copy saved.').waitFor({ timeout: 10000 })
    assert.equal(await readFile(copy, 'utf8'), `${plain}before Q`)
  })

/** Addon code with the SDK's view names in scope, whose `extension` is its feature. */
const featureAddon = (
  presentation,
  body,
) => `export default (sdk) => ({ start(context) {
  const { StateField } = sdk.codeMirror.state
  const { BlockWrapper, Decoration, EditorView, WidgetType } = sdk.codeMirror.view
  ${body}
  context.editor.${registerIn(presentation)}({ id: 'bad', create: () => extension })
} })`

/** A field decorating as `decorate(state, at)` says, at each edit that leaves a `Q`. */
const qField = (decorate) => `
  const decorate = (state) => {
    const at = state.doc.toString().indexOf('Q')
    return at < 0 ? Decoration.none : Decoration.set([${decorate}])
  }
  const extension = StateField.define({
    create: decorate,
    update: (_, transaction) => decorate(transaction.state),
    provide: (self) => EditorView.decorations.from(self),
  })`

const drawFaults = {
  'line attributes with a bad name': qField(
    `Decoration.line({ attributes: { 'bad name': '1' } }).range(state.doc.lineAt(at).from)`,
  ),
  'mark attributes with a bad name': qField(
    `Decoration.mark({ attributes: { 'bad name': '1' } }).range(at, at + 1)`,
  ),
  'a mark with a bad tag': qField(
    `Decoration.mark({ tagName: 'bad tag' }).range(at, at + 1)`,
  ),
  'a block wrapper with a bad tag': `const extension = EditorView.blockWrappers.of((view) => {
    const at = view.state.doc.toString().indexOf('Q')
    if (at < 0) return BlockWrapper.set([])
    const line = view.state.doc.lineAt(at)
    return BlockWrapper.set([BlockWrapper.create({ tagName: 'bad tag' }).range(line.from, line.to)])
  })`,
  'a decoration function that throws': `const extension = EditorView.decorations.of((view) => {
    if (view.state.doc.toString().includes('Q')) throw new Error('decorations boom')
    return Decoration.none
  })`,
}

for (const [name, body] of Object.entries(drawFaults))
  for (const [presentation, kind, source] of [
    ['formatted', 'a plain note', plain],
    ['formatted', 'a note with a table', withTable],
    ['source', 'a note with a table', withTable],
  ])
    test(`${name} in a ${presentation} view of ${kind} is named, and typing, saving and the page keep working`, {
      timeout: 60000,
    }, async (t) => {
      const context = await open(t, {
        source,
        presentation,
        code: featureAddon(presentation, body),
      })
      await opened(context, source, presentation)
      await type(context, 'before ')
      await context.page.keyboard.insertText('Q')
      await named(context, 'bad-ext.bad: ')
      await answers(context)
      await editorReady(context)
      await type(context, 'more')
      await typingAndSavingWork(context, source, 'before Qmore')
      assert.equal(await context.page.locator('.document-notice').count(), 0)
    })

/** What a failure can be that does not turn into text. */
const unreadable = {
  'an object with no prototype': 'Object.create(null)',
  'an object whose toString throws': `{ toString() { throw new Error('no text') } }`,
  'an error whose message throws': `Object.defineProperty(new Error(), 'message', { get() { throw new Error('no text') } })`,
}

for (const [name, thrown] of Object.entries(unreadable))
  for (const [where, body] of [
    [
      'a widget',
      `class Bad extends WidgetType { toDOM() { throw ${thrown} } }
      ${qField('Decoration.widget({ widget: new Bad() }).range(at)')}`,
    ],
    [
      'a decoration function',
      `const extension = EditorView.decorations.of((view) => {
        if (view.state.doc.toString().includes('Q')) throw ${thrown}
        return Decoration.none
      })`,
    ],
  ])
    test(`${where} throwing ${name} is still named, and the note keeps working`, {
      timeout: 60000,
    }, async (t) => {
      const context = await open(t, {
        source: withTable,
        code: featureAddon('formatted', body),
      })
      await opened(context, withTable)
      await type(context, 'before ')
      await context.page.keyboard.insertText('Q')
      await named(context, 'bad-ext.bad: ')
      await answers(context)
      await editorReady(context)
      await type(context, 'more')
      await typingAndSavingWork(context, withTable, 'before Qmore')
    })

test('a very long error leaves the editor on screen', {
  timeout: 60000,
}, async (t) => {
  const context = await open(t, {
    source: plain,
    code: featureAddon(
      'formatted',
      `class Bad extends WidgetType { toDOM() { throw new Error('long '.repeat(4000)) } }
      ${qField('Decoration.widget({ widget: new Bad() }).range(at)')}`,
    ),
  })
  await opened(context, plain)
  await type(context, 'Q')
  await named(context, 'bad-ext.bad: long')
  const { top, height, longest } = await context.page.evaluate((pane) => {
    const box = document.querySelector(`${pane} .cm-editor`)
    return {
      top: box.getBoundingClientRect().top,
      height: window.innerHeight,
      longest: Math.max(
        ...[...window.shownToasts].map((toast) => toast.length),
        ...[...document.querySelectorAll('.document-notice')].map(
          (notice) => notice.textContent.length,
        ),
      ),
    }
  }, context.pane)
  assert.ok(top < height / 2, `editor top ${top} of ${height}`)
  assert.ok(longest < 600, `longest text ${longest}`)
})

test('a core widget that fails at the first draw of a note shows the notice', {
  timeout: 60000,
}, async (t) => {
  const source = '# Title\n\n- [ ] task\n\nend\n\n'
  const context = await open(t, { source: plain, noAddons: true })
  await opened(context, plain)
  const next = `${context.file}.next.md`
  await writeFile(next, source)
  await context.app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, next)
  await context.page.evaluate(() => {
    // The task checkbox's own draw, not the app's other inputs.
    const create = Document.prototype.createElement
    Document.prototype.createElement = function (tag, ...rest) {
      if (tag === 'input' && new Error().stack.includes('toDOM'))
        throw new Error('core widget boom')
      return create.call(this, tag, ...rest)
    }
  })
  await pressShortcut(context.app, `${mod}+o`)
  await context.page
    .locator('.document-notice')
    .filter({ hasText: 'core widget boom' })
    .waitFor({ timeout: 10000 })
  await answers(context)
})

test('a core widget that fails is not blamed on a healthy addon', {
  timeout: 60000,
}, async (t) => {
  const source = '# Title\n\n- [ ] task\n\nend\n\n'
  const context = await open(t, {
    source: plain,
    code: goodAddon('formatted').replace("'good'", "'other'"),
  })
  await opened(context, plain)
  const next = `${context.file}.next.md`
  await writeFile(next, source)
  await context.app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, next)
  await context.page.evaluate(() => {
    const create = Document.prototype.createElement
    Document.prototype.createElement = function (tag, ...rest) {
      if (tag === 'input' && new Error().stack.includes('toDOM'))
        throw new Error('core widget boom')
      return create.call(this, tag, ...rest)
    }
  })
  await pressShortcut(context.app, `${mod}+o`)
  await context.page
    .locator('.document-notice')
    .filter({ hasText: 'core widget boom' })
    .waitFor({ timeout: 10000 })
  await editorReady(context)
  // What goes wrong would be done by now: the features go back in a microtask.
  await context.page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  )
  assert.deepEqual(
    await context.page.evaluate(() =>
      [...window.shownToasts].filter((toast) => toast.includes('boom')),
    ),
    [],
  )
  assert.equal(
    await context.page.locator(`${context.pane} .cm-editor[data-good]`).count(),
    1,
  )
  await type(context, 'x')
  await typingAndSavingWork(context, source, 'x')
})

test('a source view that fails drawing what its own scroll brings in is named and comes back', {
  timeout: 60000,
}, async (t) => {
  const far = Array.from({ length: 400 }, (_, i) => `line ${i}\n\n`).join('')
  const source = `${far}end\n\n`
  const context = await open(t, {
    source,
    presentation: 'source',
    code: decorationsAddon(
      'source',
      'view.viewport.to === view.state.doc.length',
    ),
  })
  await opened(context, source, 'source')
  await context.page.evaluate((pane) => {
    const scroller = document.querySelector(`${pane} .cm-scroller`)
    scroller.scrollTop = scroller.scrollHeight
  }, context.pane)
  await named(context, 'bad-ext.bad: decorations boom')
  await editorReady(context)
  await type(context, 'x')
  await typingAndSavingWork(context, source, 'x')
})

for (const presentation of ['formatted', 'source'])
  test(`the rebuilt ${presentation} editor keeps the place being read`, {
    timeout: 60000,
  }, async (t) => {
    const far = Array.from({ length: 400 }, (_, i) => `line ${i}\n\n`).join('')
    const source = `${far}end\n\n`
    const context = await open(t, {
      source,
      presentation,
      code: decorationsAddon(presentation),
    })
    await opened(context, source, presentation)
    const at = source.indexOf('line 300')
    const lineTop = () =>
      context.page.evaluate(
        ({ pane, at }) => {
          const content = document.querySelector(`${pane} .cm-content`)
          const view = content.cmTile.root.view
          return view.coordsAtPos(at)?.top ?? null
        },
        { pane: context.pane, at },
      )
    await context.page.evaluate(
      ({ pane, at }) => {
        const view = document.querySelector(`${pane} .cm-content`).cmTile.root
          .view
        view.focus()
        view.dispatch({
          selection: { anchor: at + 8 },
          effects: view.constructor.scrollIntoView(at, { y: 'center' }),
        })
      },
      { pane: context.pane, at },
    )
    await context.page.waitForFunction(
      ({ pane, at }) => {
        const view = document.querySelector(`${pane} .cm-content`).cmTile.root
          .view
        return view.coordsAtPos(at) !== null
      },
      { pane: context.pane, at },
    )
    await context.page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    )
    const before = await lineTop()
    await context.page.keyboard.insertText('Q')
    await named(context, 'bad-ext.bad: decorations boom')
    await editorReady(context)
    await context.page.waitForFunction(
      ({ pane, at }) => {
        const view = document.querySelector(`${pane} .cm-content`).cmTile.root
          .view
        return view.coordsAtPos(at) !== null
      },
      { pane: context.pane, at },
      { timeout: 5000 },
    )
    const after = await lineTop()
    assert.ok(Math.abs(after - before) < 60, `line moved ${before} to ${after}`)
  })
