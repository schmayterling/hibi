import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'
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
  return { page, pane, errors }
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

async function type(page, pane, keys) {
  for (const key of keys) {
    await ready(page, pane)
    // The caret goes to the end of the note's last line.
    await page.evaluate((pane) => {
      const view = document.querySelector(`${pane} .cm-content`).cmTile.root
        .view
      const { doc } = view.state
      view.dispatch({
        selection: { anchor: doc.lineAt(doc.toString().lastIndexOf('end')).to },
      })
      view.focus()
    }, pane)
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
