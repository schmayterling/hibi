import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

test('the source view keeps its parse while flavors without syntax register and stop', {
  timeout: 180000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-source-flavor-parse-'))
  const profile = join(folder, 'profile')
  const file = join(folder, 'big.md')
  const paragraph =
    'Some **bold** text with a [link](https://example.com) and `code` and _emphasis_ here.\n\n'
  const source = `# Big\n\n${paragraph.repeat(Math.ceil((1024 * 1024) / paragraph.length))}`
  await writeFile(file, source)
  const addon = join(profile, 'installed-addons', 'flavor-toggle')
  await mkdir(addon, { recursive: true })
  await writeFile(
    join(addon, 'hibi-addon.json'),
    JSON.stringify({
      id: 'flavor-toggle',
      name: 'Flavor toggle',
      description: 'Flavor fixture',
      apiVersion: 3,
      capabilities: ['formatted'],
      version: '1.0.0',
      kind: 'extension',
      authors: [{ displayName: 'Test' }],
      entry: 'index.js',
    }),
  )
  await writeFile(
    join(addon, 'index.js'),
    `export default () => ({ start(context) {
      const flavor = (id, syntax) => ({ id, name: id, kind: 'syntax', description: 'Proof', detect: () => false, ...(syntax ? { syntax } : {}) })
      let plain = null
      window.addPlainFlavor = () => { plain = context.editor.registerFlavor(flavor('plain')) }
      window.removePlainFlavor = () => { plain?.(); plain = null }
      window.addSyntaxFlavor = () => context.editor.registerFlavor(flavor('syntax', { defineNodes: ['FlavorToggleProof'] }))
    } })`,
  )
  await writeFile(
    join(addon, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['hibi-addon.json', 'index.js'],
      source: 'local',
    }),
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'flavor-toggle': true }),
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
  await page.waitForFunction(() => typeof window.addPlainFlavor === 'function')
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await pressShortcut(app, `${mod}+o`)
  await waitForAsync(
    page,
    async (length) =>
      (await window.hibi.getDocument()).markdown.length === length,
    source.length,
  )
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await page.locator('.source-pane .cm-content').waitFor()
  // The background parse covers the note once its end has been shown.
  await page.evaluate(() => {
    const view = document.querySelector('.source-pane .cm-content').cmTile.root
      .view
    view.dispatch({
      selection: { anchor: view.state.doc.length },
      scrollIntoView: true,
    })
  })
  await page.waitForFunction(
    () => {
      const { state } = document.querySelector('.source-pane .cm-content')
        .cmTile.root.view
      return state.tree.length === state.doc.length
    },
    null,
    { timeout: 120000 },
  )
  const sample = () =>
    page.evaluate(() => {
      const { state } = document.querySelector('.source-pane .cm-content')
        .cmTile.root.view
      window.parsedTree ??= state.tree
      return {
        doc: state.doc.length,
        tree: state.tree.length,
        same: state.tree === window.parsedTree,
      }
    })
  const frame = () =>
    page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    )
  const parsed = await sample()
  await page.evaluate(() => window.addPlainFlavor())
  await frame()
  const added = await sample()
  await page.evaluate(() => window.removePlainFlavor())
  await frame()
  const removed = await sample()
  // A flavor that adds syntax still reconfigures the parser.
  await page.evaluate(() => window.addSyntaxFlavor())
  await page.waitForFunction(() => {
    const { state } = document.querySelector('.source-pane .cm-content').cmTile
      .root.view
    return state.tree !== window.parsedTree
  })
  t.diagnostic(JSON.stringify({ parsed, added, removed }))
  assert.equal(parsed.tree, source.length)
  assert.deepEqual(added, {
    doc: source.length,
    tree: source.length,
    same: true,
  })
  assert.deepEqual(removed, {
    doc: source.length,
    tree: source.length,
    same: true,
  })
})
