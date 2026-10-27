import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

async function install(profile, id, presentation, code) {
  const folder = join(profile, 'installed-addons', id)
  await mkdir(folder, { recursive: true })
  await writeFile(
    join(folder, 'hibi-addon.json'),
    JSON.stringify({
      id,
      name: id === 'bad-ext' ? 'Bad ext' : 'Good ext',
      description: 'Editor extension fault fixture',
      apiVersion: 3,
      capabilities: [presentation],
      version: '1.0.0',
      kind: 'extension',
      authors: [{ displayName: 'Test' }],
      entry: 'index.js',
    }),
  )
  await writeFile(join(folder, 'index.js'), code)
  await writeFile(
    join(folder, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['hibi-addon.json', 'index.js'],
      source: 'local',
    }),
  )
}

const register = (presentation) =>
  presentation === 'formatted' ? 'registerFormatted' : 'registerSource'

/** A state field that fails on any edit that leaves a `Q` in the note. */
const failingField = (
  presentation,
) => `export default (sdk) => ({ start(context) {
  const { StateField } = sdk.codeMirror.state
  context.editor.${register(presentation)}({ id: 'bad', create: () => StateField.define({
    create: () => 0,
    update(value, transaction) {
      if (transaction.docChanged && transaction.newDoc.toString().includes('Q')) throw new Error('field boom')
      return value
    },
  }) })
} })`

const failingCreate = (
  presentation,
) => `export default () => ({ start(context) {
  context.editor.${register(presentation)}({ id: 'bad', create() { throw new Error('create boom') } })
} })`

/**
 * Opens `source` with a failing addon feature and a healthy addon's
 * feature in the given pane.
 */
async function open(t, { source, presentation, engine, code }) {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-extension-faults-'))
  const profile = join(folder, 'profile')
  const file = join(folder, 'note.md')
  await writeFile(file, source)
  await install(profile, 'bad-ext', presentation, code(presentation))
  await install(
    profile,
    'good-ext',
    presentation,
    `export default (sdk) => ({ start(context) {
      const { EditorView } = sdk.codeMirror.view
      context.editor.${register(presentation)}({ id: 'good', create: () => EditorView.editorAttributes.of({ 'data-good': 'yes' }) })
    } })`,
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'bad-ext': true, 'good-ext': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  if (engine === 'codemirror') {
    await waitForDocumentEditor(app, page)
    await page.evaluate(() =>
      localStorage.setItem('hibi:formatted-engine', 'codemirror'),
    )
    await page.reload()
  }
  // The failing feature leaves the startup note editable.
  await waitForDocumentEditor(app, page, { timeout: 20000 })
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await pressShortcut(app, `${mod}+o`)
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    source,
  )
  const pane = presentation === 'formatted' ? '.rich-pane' : '.source-pane'
  if (presentation === 'source')
    await page.getByRole('button', { name: 'Source view', exact: true }).click()
  // Renderer focus stays inside a hidden test window.
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  return { app, page, pane, errors, cdp }
}

const ready = (page, pane) =>
  page
    .locator(
      `.editor-panes[data-source-ready="true"] ${pane} .cm-content[contenteditable="true"]`,
    )
    .waitFor({ timeout: 20000 })

const frame = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  )

/** Puts the caret at the end of the note's last line. */
async function caret(page, pane) {
  await ready(page, pane)
  await page.evaluate((pane) => {
    const view = document.querySelector(`${pane} .cm-content`).cmTile.root.view
    const { doc } = view.state
    view.dispatch({
      selection: { anchor: doc.lineAt(doc.toString().lastIndexOf('end')).to },
    })
    view.focus()
  }, pane)
}

async function type(page, pane, keys) {
  for (const key of keys) {
    await caret(page, pane)
    await page.keyboard.insertText(key)
    await frame(page)
  }
}

const state = (page, pane) =>
  page.evaluate(async (pane) => {
    const content = document.querySelector(`${pane} .cm-content`)
    return {
      canonical: (await window.hibi.getDocument()).markdown,
      view: content.cmTile.root.view.state.doc.toString(),
      shown: [...content.querySelectorAll('.cm-line')]
        .map((line) => line.textContent)
        .filter((text) => text.startsWith('end')),
      good: !!document.querySelector(`${pane} [data-good]`),
    }
  }, pane)

const reported = (page, text) =>
  page
    .locator('.toast')
    .filter({ hasText: text })
    .first()
    .waitFor({ timeout: 10000 })

const plain = '# Title\n\n**strong** text\n\nend\n'
const withFrontmatter = `---\ntitle: Probe\n---\n${plain}`

const fieldCases = [
  { presentation: 'formatted', engine: 'codemirror', source: plain },
  { presentation: 'formatted', engine: 'codemirror', source: withFrontmatter },
  { presentation: 'source', engine: 'codemirror', source: plain },
  { presentation: 'source', engine: 'tiptap', source: plain },
]
for (const { presentation, engine, source } of fieldCases)
  test(`an addon ${presentation} state field that fails on input is removed and typing stays on screen and in the note (${engine}${source === plain ? '' : ', frontmatter'})`, {
    timeout: 120000,
  }, async (t) => {
    const { page, pane, errors } = await open(t, {
      source,
      presentation,
      engine,
      code: failingField,
    })
    await type(page, pane, ['a', 'Q'])
    const rejected = await state(page, pane)
    t.diagnostic(JSON.stringify({ rejected, errors }))
    // The edit it failed on is rejected on screen too, and its owner reported.
    assert.equal(rejected.canonical, source.replace(/end\n$/, 'enda\n'))
    assert.equal(rejected.view, rejected.canonical)
    assert.deepEqual(rejected.shown, ['enda'])
    await reported(page, 'bad-ext.bad: field boom')
    await type(page, pane, ['b', 'Q'])
    const after = await state(page, pane)
    t.diagnostic(JSON.stringify({ after, errors }))
    // Without it, the same input lands; the healthy addon stays.
    assert.equal(after.canonical, source.replace(/end\n$/, 'endabQ\n'))
    assert.equal(after.view, after.canonical)
    assert.deepEqual(after.shown, ['endabQ'])
    assert.equal(after.good, true)
    assert.deepEqual(errors, [])
  })

for (const presentation of ['formatted', 'source'])
  test(`an addon ${presentation} state field that fails during composition is removed and the composed text lands once (codemirror)`, {
    timeout: 120000,
  }, async (t) => {
    const { page, pane, errors, cdp } = await open(t, {
      source: withFrontmatter,
      presentation,
      engine: 'codemirror',
      code: failingField,
    })
    await caret(page, pane)
    // The second candidate fails; the next one replaces it.
    for (const text of ['日', '日Q', '日本']) {
      await cdp.send('Input.imeSetComposition', {
        text,
        selectionStart: text.length,
        selectionEnd: text.length,
      })
      await frame(page)
    }
    await cdp.send('Input.insertText', { text: '日本語' })
    await frame(page)
    await reported(page, 'bad-ext.bad: field boom')
    const composed = await state(page, pane)
    t.diagnostic(JSON.stringify({ composed, errors }))
    assert.equal(
      composed.canonical,
      withFrontmatter.replace(/end\n$/, 'end日本語\n'),
    )
    assert.equal(composed.view, composed.canonical)
    assert.deepEqual(composed.shown, ['end日本語'])
    assert.equal(composed.good, true)
    // One undo takes the composed text back.
    await page.keyboard.press(`${mod}+z`)
    await frame(page)
    const undone = await state(page, pane)
    t.diagnostic(JSON.stringify({ undone, errors }))
    assert.equal(undone.canonical, withFrontmatter)
    assert.equal(undone.view, undone.canonical)
    assert.deepEqual(undone.shown, ['end'])
    assert.deepEqual(errors, [])
  })

/** A feature with a command whose edits carry an annotation its field fails on. */
const failingCommand = (
  presentation,
) => `export default (sdk) => ({ start(context) {
  const { Annotation, StateField } = sdk.codeMirror.state
  const { EditorView, keymap } = sdk.codeMirror.view
  const own = Annotation.define()
  context.editor.${register(presentation)}({ id: 'bad', create: () => [
    StateField.define({
      create: () => 0,
      update(value, transaction) {
        if (transaction.annotation(own)) throw new Error('command boom')
        return value
      },
    }),
    EditorView.editorAttributes.of({ 'data-bad': 'yes' }),
    keymap.of([{ key: 'F8', run(view) {
      view.dispatch({ changes: { from: view.state.selection.main.head, insert: 'x' }, annotations: own.of(true), userEvent: 'input.type' })
      return true
    } }]),
  ] })
} })`

test('an addon feature that fails on its own annotated edit is named and removed (codemirror)', {
  timeout: 120000,
}, async (t) => {
  const { page, pane, errors } = await open(t, {
    source: plain,
    presentation: 'source',
    engine: 'codemirror',
    code: failingCommand,
  })
  await caret(page, pane)
  await page.keyboard.press('F8')
  await reported(page, 'bad-ext.bad: command boom')
  await page.locator(`${pane} [data-bad]`).waitFor({ state: 'detached' })
  const rejected = await state(page, pane)
  t.diagnostic(JSON.stringify({ rejected, errors }))
  assert.equal(rejected.canonical, plain)
  assert.equal(rejected.view, rejected.canonical)
  assert.deepEqual(rejected.shown, ['end'])
  await type(page, pane, ['x'])
  const after = await state(page, pane)
  assert.equal(after.canonical, plain.replace(/end\n$/, 'endx\n'))
  assert.equal(after.view, after.canonical)
  assert.deepEqual(after.shown, ['endx'])
  assert.equal(after.good, true)
  assert.deepEqual(errors, [])
})

/** A state field that fails once, so replaying the edit cannot name it. */
const failingOnce = (
  presentation,
) => `export default (sdk) => ({ start(context) {
  const { StateField } = sdk.codeMirror.state
  const { EditorView } = sdk.codeMirror.view
  let failed = false
  context.editor.${register(presentation)}({ id: 'bad', create: () => [
    StateField.define({
      create: () => 0,
      update(value, transaction) {
        if (!failed && transaction.docChanged && transaction.newDoc.toString().includes('Q')) {
          failed = true
          throw new Error('once boom')
        }
        return value
      },
    }),
    EditorView.editorAttributes.of({ 'data-bad': 'yes' }),
  ] })
} })`

test('an edit that fails without naming a feature is rejected on screen and reported, and input continues (codemirror)', {
  timeout: 120000,
}, async (t) => {
  const { page, pane, errors } = await open(t, {
    source: plain,
    presentation: 'source',
    engine: 'codemirror',
    code: failingOnce,
  })
  await type(page, pane, ['a', 'Q'])
  const rejected = await state(page, pane)
  t.diagnostic(JSON.stringify({ rejected, errors }))
  assert.equal(rejected.canonical, plain.replace(/end\n$/, 'enda\n'))
  assert.equal(rejected.view, rejected.canonical)
  assert.deepEqual(rejected.shown, ['enda'])
  const notice = page
    .locator(`${pane} .document-notice`)
    .filter({ hasText: 'Edit could not be applied' })
  await notice.filter({ hasText: 'once boom' }).waitFor({ timeout: 10000 })
  assert.equal(await page.locator(`${pane} [data-bad]`).count(), 1)
  await type(page, pane, ['Q'])
  const after = await state(page, pane)
  t.diagnostic(JSON.stringify({ after, errors }))
  assert.equal(after.canonical, plain.replace(/end\n$/, 'endaQ\n'))
  assert.equal(after.view, after.canonical)
  assert.deepEqual(after.shown, ['endaQ'])
  assert.equal(await notice.count(), 0)
  assert.equal(
    await page.locator('.toast').filter({ hasText: 'bad-ext' }).count(),
    0,
  )
  assert.deepEqual(errors, [])
})

/** A state field that fails on `Q`, read by its own extender. */
const readFailingField = (
  presentation,
) => `export default (sdk) => ({ start(context) {
  const { EditorState, StateField } = sdk.codeMirror.state
  const { EditorView } = sdk.codeMirror.view
  const field = StateField.define({
    create: () => 0,
    update(value, transaction) {
      if (transaction.docChanged && transaction.newDoc.toString().includes('Q')) throw new Error('field boom')
      return value
    },
  })
  context.editor.${register(presentation)}({ id: 'bad', create: () => [
    field,
    EditorState.transactionExtender.of((transaction) => {
      transaction.state.field(field)
      return null
    }),
    EditorView.editorAttributes.of({ 'data-bad': 'yes' }),
  ] })
} })`

for (const presentation of ['formatted', 'source'])
  test(`an addon ${presentation} extender that reads its failing field cannot leave rejected input on screen, and the feature is named and removed (codemirror)`, {
    timeout: 120000,
  }, async (t) => {
    const { page, pane, errors } = await open(t, {
      source: plain,
      presentation,
      engine: 'codemirror',
      code: readFailingField,
    })
    await type(page, pane, ['a', 'Q'])
    const rejected = await state(page, pane)
    const notices = await page.locator('.document-notice').allTextContents()
    t.diagnostic(JSON.stringify({ rejected, notices, errors }))
    assert.equal(rejected.canonical, plain.replace(/end\n$/, 'enda\n'))
    assert.equal(rejected.view, rejected.canonical)
    assert.deepEqual(rejected.shown, ['enda'])
    await reported(page, 'bad-ext.bad: field boom')
    await page.locator(`${pane} [data-bad]`).waitFor({ state: 'detached' })
    await type(page, pane, ['b', 'Q'])
    const after = await state(page, pane)
    t.diagnostic(JSON.stringify({ after, errors }))
    assert.equal(after.canonical, plain.replace(/end\n$/, 'endabQ\n'))
    assert.equal(after.view, after.canonical)
    assert.deepEqual(after.shown, ['endabQ'])
    assert.equal(after.good, true)
    assert.deepEqual(errors, [])
  })

test('an addon source state field that fails on a pasted edit is removed and the paste is rejected on screen and in the note (codemirror)', {
  timeout: 120000,
}, async (t) => {
  const { app, page, pane, errors } = await open(t, {
    source: plain,
    presentation: 'source',
    engine: 'codemirror',
    code: failingField,
  })
  await caret(page, pane)
  await app.evaluate(({ BrowserWindow, clipboard }) => {
    clipboard.writeText('paste Q\nnew line')
    BrowserWindow.getAllWindows()[0].webContents.paste()
  })
  await reported(page, 'bad-ext.bad: field boom')
  const pasted = await state(page, pane)
  t.diagnostic(JSON.stringify({ pasted, errors }))
  assert.equal(pasted.canonical, plain)
  assert.equal(pasted.view, pasted.canonical)
  assert.deepEqual(pasted.shown, ['end'])
  await type(page, pane, ['Q'])
  const after = await state(page, pane)
  assert.equal(after.canonical, plain.replace(/end\n$/, 'endQ\n'))
  assert.equal(after.view, after.canonical)
  assert.deepEqual(after.shown, ['endQ'])
  assert.equal(after.good, true)
  assert.deepEqual(errors, [])
})

/** A failing state field with a filter that rebuilds every transaction from its parts, without annotations. */
const rebuildingFilter = (
  presentation,
) => `export default (sdk) => ({ start(context) {
  const { EditorState, StateField } = sdk.codeMirror.state
  const { EditorView } = sdk.codeMirror.view
  context.editor.${register(presentation)}({ id: 'bad', create: () => [
    StateField.define({
      create: () => 0,
      update(value, transaction) {
        if (transaction.docChanged && transaction.newDoc.toString().includes('Q')) throw new Error('field boom')
        return value
      },
    }),
    EditorState.transactionFilter.of((transaction) => ({
      changes: transaction.changes,
      selection: transaction.selection,
      effects: transaction.effects,
      scrollIntoView: transaction.scrollIntoView,
    })),
    EditorView.editorAttributes.of({ 'data-bad': 'yes' }),
  ] })
} })`

for (const presentation of ['formatted', 'source'])
  test(`an addon ${presentation} filter that rebuilds the rejected edit cannot hide its failing field (codemirror)`, {
    timeout: 120000,
  }, async (t) => {
    const { page, pane, errors } = await open(t, {
      source: plain,
      presentation,
      engine: 'codemirror',
      code: rebuildingFilter,
    })
    await type(page, pane, ['a', 'Q'])
    const rejected = await state(page, pane)
    t.diagnostic(JSON.stringify({ rejected, errors }))
    assert.equal(rejected.canonical, plain.replace(/end\n$/, 'enda\n'))
    assert.equal(rejected.view, rejected.canonical)
    assert.deepEqual(rejected.shown, ['enda'])
    await reported(page, 'bad-ext.bad: field boom')
    await page.locator(`${pane} [data-bad]`).waitFor({ state: 'detached' })
    await type(page, pane, ['b', 'Q'])
    const after = await state(page, pane)
    t.diagnostic(JSON.stringify({ after, errors }))
    assert.equal(after.canonical, plain.replace(/end\n$/, 'endabQ\n'))
    assert.equal(after.view, after.canonical)
    assert.deepEqual(after.shown, ['endabQ'])
    assert.deepEqual(errors, [])
  })

/** An extender that fails on `Z`, with a command that inserts one. */
const failingExtender = (
  presentation,
) => `export default (sdk) => ({ start(context) {
  const { EditorState } = sdk.codeMirror.state
  const { EditorView, keymap } = sdk.codeMirror.view
  context.editor.${register(presentation)}({ id: 'bad', create: () => [
    EditorState.transactionExtender.of((transaction) => {
      if (transaction.newDoc.toString().includes('Z')) throw new Error('extender boom')
      return null
    }),
    EditorView.editorAttributes.of({ 'data-bad': 'yes' }),
    keymap.of([{ key: 'F8', run(view) {
      view.dispatch({ changes: { from: view.state.selection.main.head, insert: 'Z' } })
      return true
    } }]),
  ] })
} })`

test('an addon extender that fails while typed input or a command is made into an edit is rejected, then named and removed (codemirror)', {
  timeout: 120000,
}, async (t) => {
  const { page, pane, errors } = await open(t, {
    source: plain,
    presentation: 'source',
    engine: 'codemirror',
    code: failingExtender,
  })
  // Typing reaches no edit to replay, so nothing is named.
  await type(page, pane, ['Z'])
  const typed = await state(page, pane)
  t.diagnostic(JSON.stringify({ typed, errors }))
  assert.equal(typed.canonical, plain)
  assert.equal(typed.view, typed.canonical)
  assert.deepEqual(typed.shown, ['end'])
  await page
    .locator(`${pane} .document-notice`)
    .filter({ hasText: 'extender boom' })
    .waitFor({ timeout: 10000 })
  assert.equal(await page.locator(`${pane} [data-bad]`).count(), 1)
  await caret(page, pane)
  await page.keyboard.press('F8')
  await reported(page, 'bad-ext.bad: extender boom')
  await page.locator(`${pane} [data-bad]`).waitFor({ state: 'detached' })
  await type(page, pane, ['Z'])
  const after = await state(page, pane)
  t.diagnostic(JSON.stringify({ after, errors }))
  assert.equal(after.canonical, plain.replace(/end\n$/, 'endZ\n'))
  assert.equal(after.view, after.canonical)
  assert.deepEqual(after.shown, ['endZ'])
  assert.deepEqual(errors, [])
})

/** Adds a formatted feature that fails on `Q` to the bundled text extras, in one window. */
async function addWindowFeature(page) {
  const chunks = JSON.parse(
    await readFile('out/renderer/startup-bundle.json', 'utf8'),
  )
  const chunk = (module) =>
    chunks.find((entry) => entry.modules.includes(module)).file
  await page.evaluate(
    async ({ registry, sdk }) => {
      const addons = Object.values(await import(`app://hibi/${registry}`)).find(
        (value) => value?.isInstalled && value?.snapshot,
      )
      const { state, view } = Object.values(
        await import(`app://hibi/${sdk}`),
      ).find((value) => value?.view?.EditorView)
      const addon = addons
        .snapshot()
        .find((entry) => entry.manifest.id === 'text-extras')
      const start = addon.start.bind(addon)
      addon.start = async (context) => {
        await start(context)
        context.editor.registerFormatted({
          id: 'window-fault',
          create: () => [
            state.StateField.define({
              create: () => 0,
              update(value, transaction) {
                if (
                  transaction.docChanged &&
                  transaction.newDoc.toString().includes('Q')
                )
                  throw new Error('window boom')
                return value
              },
            }),
            view.EditorView.editorAttributes.of({ 'data-window-fault': 'yes' }),
          ],
        })
      }
    },
    {
      registry: chunk('src/renderer/src/addon-registry.ts'),
      sdk: chunk('src/addons/sdk-source.ts'),
    },
  )
}

/** Turns text extras off and on again in Settings. */
async function restartTextExtras(app, page) {
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  const toggle = page.locator('#addon-text-extras')
  await toggle.click()
  await page.waitForFunction(
    () => document.querySelector('#addon-text-extras')?.checked === false,
  )
  await toggle.click()
  await page.waitForFunction(
    () => document.querySelector('#addon-text-extras')?.checked === true,
  )
  await page.getByRole('button', { name: 'Back to app', exact: true }).click()
}

/**
 * Opens a note in the formatted view with a failing text extras feature,
 * and another editor window (an addon window) with the same feature.
 */
async function openWindows(t, beforeWindow = async () => {}) {
  const { app, page, pane, errors } = await open(t, {
    source: plain,
    presentation: 'formatted',
    engine: 'codemirror',
    code: () => 'export default () => ({ start() {} })',
  })
  await addWindowFeature(page)
  await restartTextExtras(app, page)
  const feature = (window) =>
    window.locator('.rich-pane [data-window-fault]').count()
  await page.locator('.rich-pane [data-window-fault]').waitFor()
  await beforeWindow(page)
  await page.evaluate(() => window.hibi.setAddonEnabled('ui-preview', true))
  await page.evaluate(() =>
    window.hibi.openAddonWindow('ui-preview', { id: 'editor' }),
  )
  const preview =
    app
      .windows()
      .find((window) => window.url().endsWith('/addon-window.html')) ??
    (await app.waitForEvent('window'))
  const previewErrors = []
  preview.on('pageerror', (error) => previewErrors.push(error.message))
  await (await preview.context().newCDPSession(preview)).send(
    'Emulation.setFocusEmulationEnabled',
    { enabled: true },
  )
  await preview
    .locator('.rich-pane .cm-content[contenteditable="true"]')
    .waitFor({ timeout: 20000 })
  // Only the other window restarts the addon here.
  await addWindowFeature(preview)
  await page.evaluate(() => window.hibi.setAddonEnabled('text-extras', false))
  await preview
    .locator('style[data-addon-style="text-extras.text-extras"]')
    .waitFor({ state: 'detached' })
  await page.evaluate(() => window.hibi.setAddonEnabled('text-extras', true))
  await preview.locator('.rich-pane [data-window-fault]').waitFor()
  return { app, page, pane, errors, preview, previewErrors, feature }
}

test('a failing formatted feature leaves the editors of every window, and turning its addon off and on restores it (codemirror)', {
  timeout: 180000,
}, async (t) => {
  const { app, page, pane, errors, preview, previewErrors, feature } =
    await openWindows(t)
  assert.equal(await feature(page), 1)
  await type(page, pane, ['Q'])
  await reported(page, 'text-extras.window-fault: window boom')
  await page
    .locator('.rich-pane [data-window-fault]')
    .waitFor({ state: 'detached' })
  await preview
    .locator('.rich-pane [data-window-fault]')
    .waitFor({ state: 'detached', timeout: 10000 })
    .catch(() => {})
  const removed = { main: await feature(page), other: await feature(preview) }
  t.diagnostic(JSON.stringify({ removed, errors, previewErrors }))
  assert.deepEqual(removed, { main: 0, other: 0 })
  await restartTextExtras(app, page)
  await page.locator('.rich-pane [data-window-fault]').waitFor()
  await preview.locator('.rich-pane [data-window-fault]').waitFor()
  // A failure in the other window leaves this one too.
  await preview.evaluate(() => {
    const view = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    view.dispatch({ selection: { anchor: view.state.doc.length } })
    view.focus()
  })
  await preview.keyboard.insertText('Q')
  await page
    .locator('.rich-pane [data-window-fault]')
    .waitFor({ state: 'detached', timeout: 10000 })
    .catch(() => {})
  const removedThere = {
    main: await feature(page),
    other: await feature(preview),
  }
  t.diagnostic(JSON.stringify({ removedThere, errors, previewErrors }))
  assert.deepEqual(removedThere, { main: 0, other: 0 })
  assert.deepEqual(errors, [])
  assert.deepEqual(previewErrors, [])
})

test('a failure another window reports after its addon was turned off does not remove the feature when it is turned on again (codemirror)', {
  timeout: 180000,
}, async (t) => {
  const { app, page, pane, errors, preview, previewErrors, feature } =
    await openWindows(t, (page) =>
      // The other window holds failure messages until the test releases them.
      page.context().addInitScript(() => {
        const Channel = window.BroadcastChannel
        window.heldFailures = []
        window.BroadcastChannel = class extends Channel {
          set onmessage(receive) {
            super.onmessage = (event) => {
              if (window.holdFailures && event.data)
                window.heldFailures.push(() => receive(event))
              else receive(event)
            }
          }
        }
      }),
    )
  await preview.evaluate(() => {
    window.holdFailures = true
  })
  await type(page, pane, ['Q'])
  await preview.waitForFunction(() => window.heldFailures.length > 0)
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  const toggle = page.locator('#addon-text-extras')
  await toggle.click()
  await preview
    .locator('style[data-addon-style="text-extras.text-extras"]')
    .waitFor({ state: 'detached' })
  await frame(preview)
  // It arrives while the addon is off.
  await preview.evaluate(() => {
    window.holdFailures = false
    for (const receive of window.heldFailures.splice(0)) receive()
  })
  await toggle.click()
  await page.waitForFunction(
    () => document.querySelector('#addon-text-extras')?.checked === true,
  )
  await page.getByRole('button', { name: 'Back to app', exact: true }).click()
  await page.locator('.rich-pane [data-window-fault]').waitFor()
  await preview
    .locator('.rich-pane [data-window-fault]')
    .waitFor({ timeout: 10000 })
    .catch(() => {})
  const restored = { main: await feature(page), other: await feature(preview) }
  t.diagnostic(JSON.stringify({ restored, errors, previewErrors }))
  assert.deepEqual(restored, { main: 1, other: 1 })
  assert.deepEqual(errors, [])
  assert.deepEqual(previewErrors, [])
})

/** A feature whose extension CodeMirror cannot install. */
const invalidExtension = (
  presentation,
) => `export default () => ({ start(context) {
  context.editor.${register(presentation)}({ id: 'bad', create: () => ({ not: 'an extension' }) })
} })`

const createCases = [
  { presentation: 'formatted', engine: 'codemirror', code: failingCreate },
  { presentation: 'source', engine: 'codemirror', code: failingCreate },
  { presentation: 'source', engine: 'tiptap', code: failingCreate },
  { presentation: 'formatted', engine: 'codemirror', code: invalidExtension },
  { presentation: 'source', engine: 'tiptap', code: invalidExtension },
]
for (const { presentation, engine, code } of createCases)
  test(`an addon ${presentation} feature that ${code === failingCreate ? 'fails to start' : 'cannot be installed'} is reported and the others install with input (${engine})`, {
    timeout: 120000,
  }, async (t) => {
    const { page, pane, errors } = await open(t, {
      source: plain,
      presentation,
      engine,
      code,
    })
    await reported(
      page,
      code === failingCreate
        ? `Bad ext could not start its ${presentation} editor feature.`
        : 'bad-ext.bad: Unrecognized extension value',
    )
    await type(page, pane, ['x'])
    const after = await state(page, pane)
    t.diagnostic(JSON.stringify({ after, errors }))
    assert.equal(after.canonical, plain.replace(/end\n$/, 'endx\n'))
    assert.equal(after.view, after.canonical)
    assert.deepEqual(after.shown, ['endx'])
    assert.equal(after.good, true)
    assert.equal(
      await page
        .locator(`${pane} .document-notice`)
        .filter({ hasText: 'Editor addon unavailable' })
        .count(),
      0,
    )
    assert.deepEqual(errors, [])
  })
