import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, stopElectronTree } from './electron.mjs'

test('ENG23/J01: fragmented source remains editable and savable across quiet-time storage maintenance', {
  timeout: 45000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-maintenance-'))
  const addon = join(profile, 'installed-addons', 'maintenance-fixture'),
    file = join(profile, 'note.md')
  await mkdir(addon, { recursive: true })
  await writeFile(
    join(addon, 'hibi-addon.json'),
    JSON.stringify({
      id: 'maintenance-fixture',
      name: 'Maintenance fixture',
      description: 'Storage lifecycle fixture',
      kind: 'extension',
      apiVersion: 2,
      capabilities: ['source'],
      version: '1.0.0',
      authors: [{ displayName: 'Test' }],
      entry: 'index.js',
    }),
  )
  await writeFile(
    join(addon, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['index.js', 'hibi-addon.json'],
      source: 'local',
    }),
  )
  await writeFile(
    join(addon, 'index.js'),
    'export default sdk => ({start(context) { window.maintenanceFixture = {sdk, context}; }});',
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'maintenance-fixture': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  const watchdog = setTimeout(() => stopElectronTree(app.process()), 40000)
  t.after(async () => {
    await app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1 })
      })
      .catch(() => {})
    await app.close().catch(() => {})
    clearTimeout(watchdog)
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  await page
    .getByRole('textbox', { name: 'Document editor', exact: true })
    .waitFor()
  await page.waitForFunction(() => !!window.maintenanceFixture)
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
  }, file)
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await page.waitForFunction(
    () => document.querySelector('.cm-content')?.isContentEditable,
  )
  const result = await page.evaluate(async () => {
    const { sdk, context } = window.maintenanceFixture
    const view = sdk.codeMirror.view.EditorView.findFromDOM(
      document.querySelector('.cm-content'),
    )
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: 'a'.repeat(80 * 4096),
      },
    })
    view.dispatch({
      changes: Array.from({ length: 80 }, (_, n) => ({
        from: n * 4096,
        to: (n + 1) * 4096 - 1,
        insert: '',
      })),
      selection: { anchor: 12, head: 15 },
    })
    view.focus()
    const saved = await window.hibi.saveDocument(true)
    const version = context.editor.getDocument().contentVersion
    const selection = view.state.selection.toJSON()
    // Exceed the 500 ms quiet threshold in both native and renderer stores.
    await new Promise((resolve) => setTimeout(resolve, 1100))
    const native = await window.hibi.getDocument()
    const stable = {
      version: context.editor.getDocument().contentVersion,
      selection: view.state.selection.toJSON(),
      focused: view.hasFocus,
      source: view.state.doc.toString(),
      dirty: native.dirty,
    }
    sdk.codeMirror.commands.undo(view)
    const undoLength = view.state.doc.length
    sdk.codeMirror.commands.redo(view)
    const redo = view.state.doc.toString()
    view.dispatch({
      changes: { from: 1, insert: '!' },
      selection: { anchor: 2 },
    })
    const final = await window.hibi.saveDocument(false)
    return {
      saved: saved.markdown,
      version,
      selection,
      stable,
      undoLength,
      redo,
      final: final.markdown,
      dirty: final.dirty,
    }
  })
  assert.equal(result.saved, 'a'.repeat(80))
  assert.deepEqual(result.stable, {
    version: result.version,
    selection: result.selection,
    focused: true,
    source: 'a'.repeat(80),
    dirty: false,
  })
  assert.equal(result.undoLength, 80 * 4096)
  assert.equal(result.redo, 'a'.repeat(80))
  assert.equal(result.final, `a!${'a'.repeat(79)}`)
  assert.equal(result.dirty, false)
  assert.equal(await readFile(file, 'utf8'), result.final)
  await page.reload()
  await page.waitForFunction(() => !!window.maintenanceFixture)
  assert.equal(
    await page.evaluate(async () => (await window.hibi.getDocument()).markdown),
    result.final,
  )
})
