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

/** Composes `日`, `日Q` (which fails), `日本` and commits `日本語`, then undoes once. */
const composeOverFailure = (presentation, code) => async (t) => {
  const { page, pane, errors, cdp } = await open(t, {
    source: withFrontmatter,
    presentation,
    engine: 'codemirror',
    code,
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
  assert.equal(await page.locator(`${pane} [data-bad]`).count(), 0)
  // One undo takes the composed text back.
  await page.keyboard.press(`${mod}+z`)
  await frame(page)
  const undone = await state(page, pane)
  t.diagnostic(JSON.stringify({ undone, errors }))
  assert.equal(undone.canonical, withFrontmatter)
  assert.equal(undone.view, undone.canonical)
  assert.deepEqual(undone.shown, ['end'])
  assert.deepEqual(errors, [])
}

for (const presentation of ['formatted', 'source'])
  test(
    `an addon ${presentation} state field that fails during composition is removed and the composed text lands once (codemirror)`,
    {
      timeout: 120000,
    },
    composeOverFailure(presentation, failingField),
  )

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

for (const presentation of ['formatted', 'source'])
  test(
    `an addon ${presentation} state field read by its own extender that fails during composition is removed and the composed text lands once (codemirror)`,
    {
      timeout: 120000,
    },
    composeOverFailure(presentation, readFailingField),
  )

/** A feature that fails on `Q` while the edit is made: an extender that throws, or a change filter that reads a field that throws. */
const failingWhileMade = (hook) => (presentation) =>
  `export default (sdk) => ({ start(context) {
  const { EditorState, StateField } = sdk.codeMirror.state
  const { EditorView } = sdk.codeMirror.view
  context.editor.${register(presentation)}({ id: 'bad', create: () => [
    ${
      hook === 'extender'
        ? `EditorState.transactionExtender.of((transaction) => {
      if (transaction.docChanged && transaction.newDoc.toString().includes('Q')) throw new Error('made boom')
      return null
    })`
        : `StateField.define({
      create: () => 0,
      update(value, transaction) {
        if (transaction.docChanged && transaction.newDoc.toString().includes('Q')) throw new Error('made boom')
        return value
      },
    }),
    EditorState.changeFilter.of((transaction) => {
      transaction.state
      return true
    })`
    },
    EditorView.editorAttributes.of({ 'data-bad': 'yes' }),
  ] })
} })`

for (const presentation of ['formatted', 'source'])
  for (const hook of ['extender', 'changeFilter'])
    test(`an addon ${presentation} ${hook} that fails while a composition is made into an edit is removed, and the screen follows the note through the rest of the composition (codemirror)`, {
      timeout: 120000,
    }, async (t) => {
      const { page, pane, errors, cdp } = await open(t, {
        source: plain,
        presentation,
        engine: 'codemirror',
        code: failingWhileMade(hook),
      })
      await caret(page, pane)
      const converged = () =>
        page.waitForFunction(
          (pane) => {
            const content = document.querySelector(`${pane} .cm-content`)
            const lines = (text) =>
              text.split('\n').filter((line) => line.startsWith('end'))
            return (
              JSON.stringify(
                lines(
                  [...content.querySelectorAll('.cm-line')]
                    .map((line) => line.textContent)
                    .join('\n'),
                ),
              ) ===
              JSON.stringify(
                lines(content.cmTile.root.view.state.doc.toString()),
              )
            )
          },
          pane,
          { polling: 100 },
        )
      for (const text of ['日', '日Q']) {
        await cdp.send('Input.imeSetComposition', {
          text,
          selectionStart: text.length,
          selectionEnd: text.length,
        })
        await frame(page)
      }
      await reported(page, 'bad-ext.bad: made boom')
      await converged()
      await cdp.send('Input.insertText', { text: '日Q' })
      await converged()
      // The composition after it lands as well.
      await cdp.send('Input.imeSetComposition', {
        text: '日本',
        selectionStart: 2,
        selectionEnd: 2,
      })
      await cdp.send('Input.insertText', { text: '日本語' })
      await frame(page)
      await converged()
      const after = await state(page, pane)
      t.diagnostic(JSON.stringify({ after, errors }))
      assert.equal(after.canonical, plain.replace(/end\n$/, 'end日Q日本語\n'))
      assert.equal(after.view, after.canonical)
      assert.deepEqual(after.shown, ['end日Q日本語'])
      assert.equal(await page.locator(`${pane} [data-bad]`).count(), 0)
      assert.deepEqual(errors, [])
    })

/** An extender that fails on `Q`, next to a feature of the same addon that allows several selections. */
const failingWithCursors = (
  presentation,
) => `export default (sdk) => ({ start(context) {
  window.faultSdk = sdk
  const { EditorState } = sdk.codeMirror.state
  const { EditorView } = sdk.codeMirror.view
  context.editor.${register(presentation)}({ id: 'cursors', create: () => EditorState.allowMultipleSelections.of(true) })
  context.editor.${register(presentation)}({ id: 'bad', create: () => [
    EditorState.transactionExtender.of((transaction) => {
      if (transaction.docChanged && transaction.newDoc.toString().includes('Q')) throw new Error('cursors boom')
      return null
    }),
    EditorView.editorAttributes.of({ 'data-bad': 'yes' }),
  ] })
} })`

for (const presentation of ['formatted', 'source'])
  test(`an addon ${presentation} extender that fails while a composition at two cursors is made into an edit is removed, and the composition lands at both (codemirror)`, {
    timeout: 120000,
  }, async (t) => {
    const { page, pane, errors, cdp } = await open(t, {
      source: plain,
      presentation,
      engine: 'codemirror',
      code: failingWithCursors,
    })
    await ready(page, pane)
    await page.evaluate((pane) => {
      const view = document.querySelector(`${pane} .cm-content`).cmTile.root
        .view
      const { EditorSelection } = window.faultSdk.codeMirror.state
      const text = view.state.doc.toString()
      view.dispatch({
        selection: EditorSelection.create(
          [
            EditorSelection.cursor(text.indexOf('text') + 4),
            EditorSelection.cursor(text.lastIndexOf('end') + 3),
          ],
          1,
        ),
      })
      view.focus()
    }, pane)
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
    await reported(page, 'bad-ext.bad: cursors boom')
    const after = await state(page, pane)
    const ranges = await page
      .locator(`${pane} .cm-content`)
      .evaluate(
        (content) => content.cmTile.root.view.state.selection.ranges.length,
      )
    t.diagnostic(JSON.stringify({ after, ranges, errors }))
    assert.equal(
      after.canonical,
      plain.replace('text\n', 'text日本語\n').replace(/end\n$/, 'end日本語\n'),
    )
    assert.equal(after.view, after.canonical)
    assert.deepEqual(after.shown, ['end日本語'])
    assert.equal(ranges, 2)
    assert.equal(await page.locator(`${pane} [data-bad]`).count(), 0)
    assert.deepEqual(errors, [])
  })

/** An extender that throws once, on the first edit that leaves a `Q`, so a replay cannot name it. */
const throwingOnce = (
  presentation,
) => `export default (sdk) => ({ start(context) {
  const { EditorState } = sdk.codeMirror.state
  const { EditorView } = sdk.codeMirror.view
  let thrown = false
  context.editor.${register(presentation)}({ id: 'bad', create: () => [
    EditorState.transactionExtender.of((transaction) => {
      if (!thrown && transaction.docChanged && transaction.newDoc.toString().includes('Q')) {
        thrown = true
        throw new Error('once boom')
      }
      return null
    }),
    EditorView.editorAttributes.of({ 'data-bad': 'yes' }),
  ] })
} })`

for (const presentation of ['formatted', 'source'])
  test(`a composed edit that fails without naming an addon ${presentation} feature ends the composition, and the screen follows the note (codemirror)`, {
    timeout: 120000,
  }, async (t) => {
    const { page, pane, errors, cdp } = await open(t, {
      source: plain,
      presentation,
      engine: 'codemirror',
      code: throwingOnce,
    })
    await caret(page, pane)
    const converged = () =>
      page.waitForFunction(
        (pane) => {
          const content = document.querySelector(`${pane} .cm-content`)
          const view = content.cmTile.root.view
          const shown = [...content.querySelectorAll('.cm-line')]
            .map((line) => line.textContent)
            .filter((line) => line.startsWith('end'))
          const lines = view.state.doc
            .toString()
            .split('\n')
            .filter((line) => line.startsWith('end'))
          return JSON.stringify(shown) === JSON.stringify(lines)
        },
        pane,
        { polling: 100 },
      )
    for (const text of ['日', '日Q']) {
      await cdp.send('Input.imeSetComposition', {
        text,
        selectionStart: text.length,
        selectionEnd: text.length,
      })
      await frame(page)
    }
    await page
      .locator(`${pane} .document-notice`)
      .filter({ hasText: 'once boom' })
      .waitFor({ timeout: 10000 })
    await converged()
    const rejected = await state(page, pane)
    const ended = await page
      .locator(`${pane} .cm-content`)
      .evaluate((content) => !content.cmTile.root.view.compositionStarted)
    t.diagnostic(JSON.stringify({ rejected, ended, errors }))
    assert.equal(rejected.canonical, plain.replace(/end\n$/, 'end日\n'))
    assert.equal(rejected.view, rejected.canonical)
    assert.equal(ended, true)
    assert.equal(await page.locator(`${pane} [data-bad]`).count(), 1)
    // The IME composes on; what it commits lands as shown.
    await cdp.send('Input.imeSetComposition', {
      text: '日本',
      selectionStart: 2,
      selectionEnd: 2,
    })
    await cdp.send('Input.insertText', { text: '日本語' })
    await frame(page)
    await converged()
    const after = await state(page, pane)
    t.diagnostic(JSON.stringify({ after, errors }))
    assert.equal(after.view, after.canonical)
    assert.ok(after.canonical.includes('日本語'))
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

/** A failing field with a command that dispatches two transactions, the second of which it fails on. */
const failingBatch = (
  presentation,
) => `export default (sdk) => ({ start(context) {
  const { StateField } = sdk.codeMirror.state
  const { EditorView, keymap } = sdk.codeMirror.view
  context.editor.${register(presentation)}({ id: 'bad', create: () => [
    StateField.define({
      create: () => 0,
      update(value, transaction) {
        if (transaction.docChanged && transaction.newDoc.toString().includes('Q')) throw new Error('batch boom')
        return value
      },
    }),
    EditorView.editorAttributes.of({ 'data-bad': 'yes' }),
    keymap.of([{ key: 'F8', run(view) {
      const at = view.state.selection.main.head
      const first = view.state.update({ changes: { from: at, insert: 'a' }, userEvent: 'input.type' })
      const second = first.state.update({ changes: { from: at + 1, insert: 'Q' }, userEvent: 'input.type' })
      view.dispatch([first, second])
      return true
    } }]),
  ] })
} })`

for (const presentation of ['formatted', 'source'])
  test(`an addon ${presentation} field that fails on the second transaction of a dispatch is named and removed, and the dispatch is rejected (codemirror)`, {
    timeout: 120000,
  }, async (t) => {
    const { page, pane, errors } = await open(t, {
      source: plain,
      presentation,
      engine: 'codemirror',
      code: failingBatch,
    })
    await caret(page, pane)
    await page.keyboard.press('F8')
    await reported(page, 'bad-ext.bad: batch boom')
    await page.locator(`${pane} [data-bad]`).waitFor({ state: 'detached' })
    const rejected = await state(page, pane)
    t.diagnostic(JSON.stringify({ rejected, errors }))
    assert.equal(rejected.canonical, plain)
    assert.equal(rejected.view, rejected.canonical)
    assert.deepEqual(rejected.shown, ['end'])
    await type(page, pane, ['Q'])
    const after = await state(page, pane)
    assert.equal(after.canonical, plain.replace(/end\n$/, 'endQ\n'))
    assert.equal(after.view, after.canonical)
    assert.deepEqual(after.shown, ['endQ'])
    assert.deepEqual(errors, [])
  })

/** A command that makes three edits, each from the state the one before reaches, and dispatches them together. */
const failingChain = (inserts) => (presentation) =>
  `export default (sdk) => ({ start(context) {
  const { StateField } = sdk.codeMirror.state
  const { EditorView, keymap } = sdk.codeMirror.view
  context.editor.${register(presentation)}({ id: 'bad', create: () => [
    StateField.define({
      create: () => 0,
      update(value, transaction) {
        if (transaction.docChanged && transaction.newDoc.toString().includes('Q')) throw new Error('chain boom')
        return value
      },
    }),
    EditorView.editorAttributes.of({ 'data-bad': 'yes' }),
    keymap.of([{ key: 'F8', run(view) {
      let state = view.state
      const transactions = []
      for (const insert of ${JSON.stringify(inserts)}) {
        const transaction = state.update({ changes: { from: state.doc.toString().lastIndexOf('end') + 3, insert }, userEvent: 'input.type' })
        transactions.push(transaction)
        state = transaction.state
      }
      view.dispatch(transactions)
      return true
    } }]),
  ] })
} })`

for (const presentation of ['formatted', 'source'])
  for (const inserts of [
    ['Q', 'a', 'b'],
    ['a', 'Q', 'b'],
  ])
    test(`an addon ${presentation} field that fails on edit ${inserts.indexOf('Q') + 1} of a dispatch whose next edit was made from it is named and removed (codemirror)`, {
      timeout: 120000,
    }, async (t) => {
      const { page, pane, errors } = await open(t, {
        source: plain,
        presentation,
        engine: 'codemirror',
        code: failingChain(inserts),
      })
      await caret(page, pane)
      await page.keyboard.press('F8')
      await reported(page, 'bad-ext.bad: chain boom')
      await page.locator(`${pane} [data-bad]`).waitFor({ state: 'detached' })
      const rejected = await state(page, pane)
      t.diagnostic(JSON.stringify({ rejected, errors }))
      assert.equal(rejected.canonical, plain)
      assert.equal(rejected.view, rejected.canonical)
      assert.deepEqual(rejected.shown, ['end'])
      assert.deepEqual(errors, [])
    })

/** Two features that fail on `A` and on `B`, and a command that makes both edits from one state but dispatches only `A`. */
const failingAlternatives = (
  presentation,
) => `export default (sdk) => ({ start(context) {
  const { StateField } = sdk.codeMirror.state
  const { EditorView, keymap } = sdk.codeMirror.view
  const register = context.editor.${register(presentation)}
  for (const letter of ['A', 'B'])
    register({ id: letter.toLowerCase(), create: () => [
      StateField.define({
        create: () => 0,
        update(value, transaction) {
          if (transaction.docChanged && transaction.newDoc.toString().includes(letter)) throw new Error(letter + ' failed')
          return value
        },
      }),
      EditorView.editorAttributes.of({ ['data-field-' + letter.toLowerCase()]: 'yes' }),
    ] })
  register({ id: 'command', create: () => keymap.of([{ key: 'F8', run(view) {
    const at = view.state.selection.main.head
    const chosen = view.state.update({ changes: { from: at, insert: 'A' }, userEvent: 'input.type' })
    view.state.update({ changes: { from: at, insert: 'B' }, userEvent: 'input.type' })
    view.dispatch(chosen)
    return true
  } }]) })
} })`

for (const presentation of ['formatted', 'source'])
  test(`of two failing edits an addon ${presentation} command makes from one state, the one it dispatches names its feature (codemirror)`, {
    timeout: 120000,
  }, async (t) => {
    const { page, pane, errors } = await open(t, {
      source: plain,
      presentation,
      engine: 'codemirror',
      code: failingAlternatives,
    })
    await caret(page, pane)
    await page.keyboard.press('F8')
    await reported(page, 'bad-ext.a: A failed')
    await page.locator(`${pane} [data-field-a]`).waitFor({ state: 'detached' })
    const after = await state(page, pane)
    const kept = await page.locator(`${pane} [data-field-b]`).count()
    const toasts = await page.locator('.toast').allTextContents()
    t.diagnostic(JSON.stringify({ after, kept, toasts, errors }))
    assert.equal(kept, 1)
    assert.equal(toasts.filter((text) => text.includes('B failed')).length, 0)
    assert.equal(after.canonical, plain)
    assert.equal(after.view, after.canonical)
    assert.deepEqual(after.shown, ['end'])
    assert.deepEqual(errors, [])
  })

/** A failing state field and a change filter that reads it and hides the failure. */
const swallowingFilter = (
  presentation,
) => `export default (sdk) => ({ start(context) {
  const { EditorState, StateField } = sdk.codeMirror.state
  const { EditorView } = sdk.codeMirror.view
  const field = StateField.define({
    create: () => 0,
    update(value, transaction) {
      if (transaction.docChanged && transaction.newDoc.toString().includes('Q')) throw new Error('swallowed boom')
      return value
    },
  })
  context.editor.${register(presentation)}({ id: 'bad', create: () => [
    field,
    EditorState.changeFilter.of((transaction) => {
      try {
        transaction.state.field(field)
      } catch {}
      return true
    }),
    EditorView.editorAttributes.of({ 'data-bad': 'yes' }),
  ] })
} })`

for (const presentation of ['formatted', 'source'])
  test(`an addon ${presentation} field failure that the addon's own change filter catches is still rejected, named and removed (codemirror)`, {
    timeout: 120000,
  }, async (t) => {
    const { page, pane, errors } = await open(t, {
      source: plain,
      presentation,
      engine: 'codemirror',
      code: swallowingFilter,
    })
    await type(page, pane, ['a', 'Q'])
    await reported(page, 'bad-ext.bad: swallowed boom')
    await page.locator(`${pane} [data-bad]`).waitFor({ state: 'detached' })
    const rejected = await state(page, pane)
    t.diagnostic(JSON.stringify({ rejected, errors }))
    assert.equal(rejected.canonical, plain.replace(/end\n$/, 'enda\n'))
    assert.equal(rejected.view, rejected.canonical)
    assert.deepEqual(rejected.shown, ['enda'])
    await type(page, pane, ['b', 'Q'])
    const after = await state(page, pane)
    assert.equal(after.canonical, plain.replace(/end\n$/, 'endabQ\n'))
    assert.equal(after.view, after.canonical)
    assert.deepEqual(after.shown, ['endabQ'])
    assert.deepEqual(errors, [])
  })

/**
 * A failure on `Q` that the addon's own change filter catches, from a field
 * another field provides, a field a facet enables, a facet value, or a field
 * behind precedence and a compartment.
 */
const swallowedNested = (mode) => (presentation) =>
  `export default (sdk) => ({ start(context) {
  const { Compartment, EditorState, Facet, Prec, StateField } = sdk.codeMirror.state
  const { EditorView } = sdk.codeMirror.view
  const failing = StateField.define({
    create: () => 0,
    update(value, transaction) {
      if (transaction.docChanged && transaction.newDoc.toString().includes('Q')) throw new Error('nested boom')
      return value
    },
  })
  const counted = Facet.define({ combine: (values) => values[0] ?? 0 })
  const extension = {
    provide: StateField.define({ create: () => 0, update: (value) => value, provide: () => failing }),
    enable: Facet.define({ enables: failing }).of(1),
    compute: counted.compute(['doc'], (state) => {
      if (state.doc.toString().includes('Q')) throw new Error('nested boom')
      return state.doc.length
    }),
    wrap: Prec.highest(new Compartment().of([Prec.lowest(failing)])),
  }[${JSON.stringify(mode)}]
  context.editor.${register(presentation)}({ id: 'bad', create: () => [
    extension,
    EditorView.editorAttributes.of({ 'data-bad': 'yes' }),
    EditorState.changeFilter.of((transaction) => {
      try {
        ${mode === 'compute' ? 'transaction.state.facet(counted)' : 'transaction.state.field(failing)'}
      } catch {}
      return true
    }),
  ] })
} })`

for (const presentation of ['formatted', 'source'])
  for (const mode of ['provide', 'enable', 'compute', 'wrap'])
    test(`an addon ${presentation} failure from a ${mode === 'provide' ? 'provided field' : mode === 'enable' ? 'facet-enabled field' : mode === 'compute' ? 'facet value' : 'wrapped field'} that its change filter catches is rejected, named and removed (codemirror)`, {
      timeout: 120000,
    }, async (t) => {
      const { page, pane, errors } = await open(t, {
        source: plain,
        presentation,
        engine: 'codemirror',
        code: swallowedNested(mode),
      })
      await type(page, pane, ['Q'])
      await reported(page, 'bad-ext.bad: nested boom')
      await page.locator(`${pane} [data-bad]`).waitFor({ state: 'detached' })
      const rejected = await state(page, pane)
      t.diagnostic(JSON.stringify({ rejected, errors }))
      assert.equal(rejected.canonical, plain)
      assert.equal(rejected.view, rejected.canonical)
      assert.deepEqual(rejected.shown, ['end'])
      assert.deepEqual(errors, [])
    })

/** A feature that adds a field failing on `Q` through its own compartment when F9 is pressed, and a change filter that reads it and catches the failure. */
const compartmentAdded = (
  presentation,
) => `export default (sdk) => ({ start(context) {
  const { Compartment, EditorState, StateField } = sdk.codeMirror.state
  const { EditorView, keymap } = sdk.codeMirror.view
  const failing = StateField.define({
    create: () => 0,
    update(value, transaction) {
      if (transaction.docChanged && transaction.newDoc.toString().includes('Q')) throw new Error('added boom')
      return value
    },
  })
  const compartment = new Compartment()
  context.editor.${register(presentation)}({ id: 'bad', create: () => [
    compartment.of([]),
    EditorState.changeFilter.of((transaction) => {
      try {
        transaction.state.field(failing)
      } catch {}
      return true
    }),
    keymap.of([{ key: 'F9', run(view) {
      view.dispatch({ effects: compartment.reconfigure(failing) })
      return true
    } }]),
    EditorView.editorAttributes.of({ 'data-bad': 'yes' }),
  ] })
} })`

for (const presentation of ['formatted', 'source'])
  test(`an addon ${presentation} field added later through the addon's compartment, whose failure its change filter catches, is rejected, named and removed (codemirror)`, {
    timeout: 120000,
  }, async (t) => {
    const { page, pane, errors } = await open(t, {
      source: plain,
      presentation,
      engine: 'codemirror',
      code: compartmentAdded,
    })
    await caret(page, pane)
    await page.keyboard.press('F9')
    await type(page, pane, ['a', 'Q'])
    await reported(page, 'bad-ext.bad: added boom')
    await page.locator(`${pane} [data-bad]`).waitFor({ state: 'detached' })
    const rejected = await state(page, pane)
    t.diagnostic(JSON.stringify({ rejected, errors }))
    assert.equal(rejected.canonical, plain.replace(/end\n$/, 'enda\n'))
    assert.equal(rejected.view, rejected.canonical)
    assert.deepEqual(rejected.shown, ['enda'])
    await type(page, pane, ['b', 'Q'])
    const after = await state(page, pane)
    assert.equal(after.canonical, plain.replace(/end\n$/, 'endabQ\n'))
    assert.equal(after.view, after.canonical)
    assert.deepEqual(errors, [])
  })

/** A healthy feature whose state field is frozen, with a field that fails on `Q`. */
const frozenField = (
  presentation,
) => `export default (sdk) => ({ start(context) {
  const { StateField } = sdk.codeMirror.state
  const { EditorView } = sdk.codeMirror.view
  context.editor.${register(presentation)}({ id: 'frozen', create: () => Object.freeze(StateField.define({ create: () => 0, update: (value) => value + 1 })) })
  context.editor.${register(presentation)}({ id: 'bad', create: () => [
    StateField.define({
      create: () => 0,
      update(value, transaction) {
        if (transaction.docChanged && transaction.newDoc.toString().includes('Q')) throw new Error('frozen boom')
        return value
      },
    }),
    EditorView.editorAttributes.of({ 'data-bad': 'yes' }),
  ] })
} })`

for (const presentation of ['formatted', 'source'])
  test(`an addon ${presentation} feature with a frozen state field installs and typing works next to a failing one (codemirror)`, {
    timeout: 120000,
  }, async (t) => {
    const { page, pane, errors } = await open(t, {
      source: plain,
      presentation,
      engine: 'codemirror',
      code: frozenField,
    })
    await type(page, pane, ['a', 'Q'])
    await reported(page, 'bad-ext.bad: frozen boom')
    await type(page, pane, ['b'])
    const after = await state(page, pane)
    t.diagnostic(JSON.stringify({ after, errors }))
    assert.equal(after.canonical, plain.replace(/end\n$/, 'endab\n'))
    assert.equal(after.view, after.canonical)
    assert.deepEqual(after.shown, ['endab'])
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

for (const made of ['typing', 'a command'])
  test(`an addon extender that fails while ${made} is made into an edit is named and removed, and the edit is rejected (codemirror)`, {
    timeout: 120000,
  }, async (t) => {
    const { page, pane, errors } = await open(t, {
      source: plain,
      presentation: 'source',
      engine: 'codemirror',
      code: failingExtender,
    })
    if (made === 'typing') await type(page, pane, ['Z'])
    else {
      await caret(page, pane)
      await page.keyboard.press('F8')
    }
    await reported(page, 'bad-ext.bad: extender boom')
    await page.locator(`${pane} [data-bad]`).waitFor({ state: 'detached' })
    const rejected = await state(page, pane)
    t.diagnostic(JSON.stringify({ rejected, errors }))
    assert.equal(rejected.canonical, plain)
    assert.equal(rejected.view, rejected.canonical)
    assert.deepEqual(rejected.shown, ['end'])
    await type(page, pane, ['Z'])
    const after = await state(page, pane)
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
  await addWindowFeature(preview)
  await restartTextExtras(app, page)
  await page.locator('.rich-pane [data-window-fault]').waitFor()
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

/** Makes windows opened later hold failure messages while `window.holdFailures` is set. */
const holdFailures = (page) =>
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
  })

for (const late of ['while it is off', 'after it is on again'])
  test(`a failure from another window that arrives ${late} does not remove the feature from the addon's next run (codemirror)`, {
    timeout: 180000,
  }, async (t) => {
    const { app, page, pane, errors, preview, previewErrors, feature } =
      await openWindows(t, holdFailures)
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
    const release = () =>
      preview.evaluate(() => {
        window.holdFailures = false
        for (const receive of window.heldFailures.splice(0)) receive()
      })
    if (late === 'while it is off') await release()
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
    if (late === 'after it is on again') {
      await release()
      await frame(preview)
      await frame(preview)
    }
    const restored = {
      main: await feature(page),
      other: await feature(preview),
    }
    t.diagnostic(JSON.stringify({ restored, errors, previewErrors }))
    assert.deepEqual(restored, { main: 1, other: 1 })
    assert.deepEqual(errors, [])
    assert.deepEqual(previewErrors, [])
  })

test("a failure from the addon's next run still removes the feature from a window that learns of that run later (codemirror)", {
  timeout: 180000,
}, async (t) => {
  const { app, page, pane, errors, preview, previewErrors, feature } =
    await openWindows(t, holdFailures)
  await preview.evaluate(() => {
    window.holdFailures = true
  })
  // Main holds the addon states it sends to the other window.
  await app.evaluate(({ BrowserWindow }) => {
    const { webContents } = BrowserWindow.getAllWindows().find((window) =>
      window.webContents.getURL().endsWith('/addon-window.html'),
    )
    const send = webContents.send.bind(webContents)
    globalThis.heldStates = { webContents, send, states: [] }
    webContents.send = (channel, ...args) => {
      if (channel !== 'addon-windows:states-changed')
        return send(channel, ...args)
      globalThis.heldStates.states.push(args)
    }
  })
  try {
    await restartTextExtras(app, page)
    await page.locator('.rich-pane [data-window-fault]').waitFor()
    await type(page, pane, ['Q'])
    await reported(page, 'text-extras.window-fault: window boom')
    await preview.waitForFunction(() => window.heldFailures.length > 0)
  } finally {
    await app.evaluate(() => {
      const { webContents, send, states } = globalThis.heldStates
      webContents.send = send
      for (const args of states) send('addon-windows:states-changed', ...args)
    })
  }
  // The other window learns of the new run, then of its failure.
  await preview.locator('.rich-pane [data-window-fault]').waitFor()
  await preview.evaluate(() => {
    window.holdFailures = false
    for (const receive of window.heldFailures.splice(0)) receive()
  })
  await frame(preview)
  await frame(preview)
  const removed = { main: await feature(page), other: await feature(preview) }
  t.diagnostic(JSON.stringify({ removed, errors, previewErrors }))
  assert.deepEqual(removed, { main: 0, other: 0 })
  assert.deepEqual(errors, [])
  assert.deepEqual(previewErrors, [])
})

test('a failure keeps the activation of the run it happened in, even when main answers the window later (codemirror)', {
  timeout: 180000,
}, async (t) => {
  const { app, page, pane, errors, preview, previewErrors, feature } =
    await openWindows(t)
  // Main holds the next addon states request from the main window.
  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('addons:states')
    const main = BrowserWindow.getAllWindows().find(
      (window) => !window.webContents.getURL().endsWith('/addon-window.html'),
    ).webContents.id
    const gate = { original, armed: true, release: () => {} }
    globalThis.statesGate = gate
    ipcMain.removeHandler('addons:states')
    ipcMain.handle('addons:states', (event, ...args) => {
      if (!gate.armed || event.sender.id !== main)
        return original(event, ...args)
      gate.armed = false
      return new Promise((resolve) => {
        gate.release = () => resolve(original(event, ...args))
      })
    })
  })
  try {
    await type(page, pane, ['Q'])
    await reported(page, 'text-extras.window-fault: window boom')
    await restartTextExtras(app, page)
    await page.locator('.rich-pane [data-window-fault]').waitFor()
    await preview.locator('.rich-pane [data-window-fault]').waitFor()
  } finally {
    await app.evaluate(({ ipcMain }) => {
      const { original, release } = globalThis.statesGate
      ipcMain.removeHandler('addons:states')
      ipcMain.handle('addons:states', original)
      release()
    })
  }
  await frame(preview)
  await frame(preview)
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
