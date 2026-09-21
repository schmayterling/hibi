import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'

test('lazy rich startup applies view attributes after mounting and accepts native input', {
  timeout: 40000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-rich-startup-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  for (let attempt = 0; attempt < 4; attempt++) {
    const app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${join(folder, String(attempt))}`],
    })
    const watchdog = setTimeout(() => app.process().kill('SIGKILL'), 8000)
    try {
      const page = await app.firstWindow()
      page.setDefaultTimeout(5000)
      const editor = page.getByRole('textbox', {
        name: 'Document editor',
        exact: true,
      })
      await editor.waitFor({ timeout: 5000 })
      await page.waitForFunction(
        () =>
          document.querySelector('.tiptap')?.getAttribute('spellcheck') ===
          'true',
      )
      await editor.fill(`ready ${attempt}`)
      assert.equal(
        (await page.evaluate(() => window.hibi.getDocument())).markdown,
        `ready ${attempt}`,
      )
      assert.equal(
        await page
          .getByText('The editor stopped working', { exact: true })
          .count(),
        0,
      )
      assert.equal(
        (await page.consoleMessages()).some(
          (message) =>
            message.type() === 'error' &&
            message.text().includes('The editor view is not available'),
        ),
        false,
      )
    } finally {
      await app
        .evaluate(({ dialog }) => {
          dialog.showMessageBox = async () => ({ response: 1 })
        })
        .catch(() => {})
      await app.close().catch(() => {})
      clearTimeout(watchdog)
    }
  }
})

test('standalone source skips rich attachment and hidden previews while preserving view, history and saves', {
  timeout: 45000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-source-format-')),
    addon = join(profile, 'installed-addons', 'source-format-fixture'),
    file = join(profile, 'note.probe'),
    original = 'first\r\n' + 'needle paragraph\r\n'.repeat(10000)
  await mkdir(addon, { recursive: true })
  await writeFile(file, original)
  await writeFile(
    join(addon, 'hibi-addon.json'),
    JSON.stringify({
      id: 'source-format-fixture',
      name: 'Source format fixture',
      description: 'Editor lifecycle fixture',
      kind: 'extension',
      apiVersion: 2,
      capabilities: ['source', 'ui'],
      fileExtensions: ['probe'],
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
    `export default sdk => ({ start(context) {
    const state = window.sourceFormatFixture = { sdk, context, rich: 0, previews: 0, renders: 0, projections: 0, loads: 0 };
    context.editor.registerRich({ id: 'observe', attach() { state.rich++; return () => state.rich--; } });
    context.editor.registerMarkdown({ id: 'observe', parse() { state.projections++; return null; } });
    context.editor.registerDocumentFormat({ id: 'probe', name: 'Probe', extensions: ['probe'], views: ['side-by-side', 'markdown'],
      Preview: sdk.React.lazy(() => { state.loads++; return new Promise(resolve => { state.resolvePreview = () => resolve({ default: function Preview({ value }) { state.renders++; sdk.React.useEffect(() => { state.previews++; return () => state.previews--; }, []); return sdk.React.createElement('pre', { 'data-fixture-preview': true }, value); } }); }); }),
      render: async () => ({ html: '', css: '' }),
    });
  }});`,
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'source-format-fixture': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  const watchdog = setTimeout(() => app.process().kill('SIGKILL'), 40000)
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
  await page.waitForFunction(() => window.sourceFormatFixture?.rich === 1)
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await clickMenu(app, 'Open…')
  const source = page.getByRole('textbox', {
    name: 'Probe editor',
    exact: true,
  })
  await source.waitFor()
  await page.waitForFunction(() => window.sourceFormatFixture.rich === 0)
  assert.equal(await page.locator('.tiptap').count(), 0)
  const initial = await page.evaluate(() => {
    const f = window.sourceFormatFixture
    f.view = f.sdk.codeMirror.view.EditorView.findFromDOM(
      document.querySelector('.cm-content'),
    )
    f.view.dispatch({ selection: { anchor: 0 } })
    f.view.focus()
    f.projections = 0
    return { previews: f.previews, renders: f.renders, loads: f.loads }
  })
  assert.deepEqual(initial, { previews: 0, renders: 0, loads: 0 })
  await page.keyboard.insertText('!')
  await page.waitForFunction(
    () => window.sourceFormatFixture.context.editor.getDocument().dirty,
  )
  assert.equal(
    await page.evaluate(() => window.sourceFormatFixture.projections),
    0,
  )
  await page
    .getByRole('button', { name: /^side-by-side$/i, exact: true })
    .click()
  await page.waitForFunction(() => !!window.sourceFormatFixture.resolvePreview)
  const loading = await page.evaluate(() => {
    const f = window.sourceFormatFixture
    const view = f.sdk.codeMirror.view.EditorView.findFromDOM(
      document.querySelector('.cm-content'),
    )
    const state = {
      sameView: view === f.view,
      connected: view.dom.isConnected,
      loads: f.loads,
    }
    f.resolvePreview()
    return state
  })
  assert.deepEqual(loading, { sameView: true, connected: true, loads: 1 })
  await page.locator('[data-fixture-preview]').waitFor()
  await page.waitForFunction(() => window.sourceFormatFixture.previews === 1)
  assert.equal(await page.locator('.tiptap').count(), 0)
  assert.equal(
    await page.locator('[data-fixture-preview]').textContent(),
    '!' + original,
  )
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await page.waitForFunction(() => window.sourceFormatFixture.previews === 0)
  const before = await page.evaluate(() => {
    const f = window.sourceFormatFixture
    const view = f.sdk.codeMirror.view.EditorView.findFromDOM(
      document.querySelector('.cm-content'),
    )
    view.focus()
    return {
      sameView: view === f.view,
      head: view.state.selection.main.head,
      renders: f.renders,
    }
  })
  assert.equal(before.sameView, true)
  assert.equal(before.head, 1)
  await page.keyboard.insertText('?')
  await page.waitForFunction(
    () => window.sourceFormatFixture.view.state.doc.sliceString(0, 2) === '!?',
  )
  const after = await page.evaluate(() => {
    const f = window.sourceFormatFixture,
      view = f.view
    const text = view.state.doc.toString()
    f.sdk.codeMirror.commands.undo(view)
    const undone = view.state.doc.toString()
    f.sdk.codeMirror.commands.redo(view)
    return {
      restored: view.state.doc.toString() === text,
      changed: undone !== text,
      renders: f.renders,
      projections: f.projections,
      rich: f.rich,
    }
  })
  assert.deepEqual(after, {
    restored: true,
    changed: true,
    renders: before.renders,
    projections: 0,
    rich: 0,
  })
  await page.evaluate(() => window.hibi.saveDocument(false))
  assert.equal(await readFile(file, 'utf8'), '!?' + original)
  await pressShortcut(app, `${mod}+f`)
  const find = page.getByRole('textbox', {
    name: 'Find in document',
    exact: true,
  })
  await find.fill('needle')
  await page.waitForFunction(() =>
    /\/10000$/.test(document.querySelector('.find-count')?.textContent ?? ''),
  )
  await find.press('Escape')
  assert.equal(
    await page.evaluate(() => window.sourceFormatFixture.view.hasFocus),
    true,
  )
  assert.equal(await page.locator('.tiptap').count(), 0)
})
