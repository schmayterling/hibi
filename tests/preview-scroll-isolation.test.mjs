import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  electron,
  openInDocumentEditor,
  waitForDocumentEditor,
} from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
// A source extension whose decorations throw once the view reaches the end.
const addon = `export default (sdk) => ({ start(context) {
  const { Decoration, EditorView } = sdk.codeMirror.view
  context.editor.registerSource({ id: 'bad', create: () => EditorView.decorations.of((view) => {
    if (view.viewport.to === view.state.doc.length) throw new Error('decorations boom')
    return Decoration.none
  }) })
} })`

test('after an unlinked alignment ends, a failing source extension still rebuilds the view', {
  timeout: 90000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-preview-isolation-'))
  const profile = join(folder, 'profile')
  const file = join(folder, 'note.md')
  const far = Array.from({ length: 400 }, (_, i) => `line ${i}\n\n`).join('')
  await writeFile(file, `${far}end\n\n`)
  const installed = join(profile, 'installed-addons', 'bad-ext')
  await mkdir(installed, { recursive: true })
  await writeFile(
    join(installed, 'hibi-addon.json'),
    JSON.stringify({
      id: 'bad-ext',
      name: 'bad-ext',
      description: 'fixture',
      apiVersion: 3,
      capabilities: ['source'],
      version: '1.0.0',
      kind: 'extension',
      authors: [{ displayName: 'Test' }],
      entry: 'index.js',
    }),
  )
  await writeFile(join(installed, 'index.js'), addon)
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
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await waitForDocumentEditor(app, page)
  await page.evaluate(() =>
    localStorage.setItem('sync-preview-scroll', 'false'),
  )
  await page.reload()
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await openInDocumentEditor(app, page, () => pressShortcut(app, `${mod}+o`))
  await page.getByRole('button', { name: /^side-by-side$/i }).click()
  await page
    .locator(
      '.editor-panes[data-source-ready="true"] .source-pane .cm-content[contenteditable="true"]',
    )
    .waitFor()
  const first = await page.evaluateHandle(
    () => document.querySelector('.source-pane .cm-content').cmTile.root.view,
  )
  // A caret move aligns the panes; a script scrolling the preview ends it.
  await first.evaluate((view) => {
    view.focus()
    view.dispatch({ selection: { anchor: 20 } })
  })
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  )
  await page.evaluate(() => {
    document.querySelector('.rich-pane').scrollTop += 5
  })
  // The source's own measure, reaching the end, meets the failing extension.
  await page.evaluate(() => {
    const pane = document.querySelector('.source-pane .cm-scroller')
    pane.scrollTop = pane.scrollHeight
  })
  await page
    .locator('.toast', { hasText: 'bad-ext.bad: decorations boom' })
    .waitFor()
  await page.waitForFunction(
    (first) =>
      document.querySelector('.source-pane .cm-content')?.cmTile?.root?.view !==
      first,
    first,
  )
  assert.equal(
    await page.evaluate(() =>
      document
        .querySelector('.source-pane .cm-content')
        .getAttribute('contenteditable'),
    ),
    'true',
  )
})
