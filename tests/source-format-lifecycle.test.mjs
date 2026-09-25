import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, startupDiagnostics, stopElectronTree } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'

async function closeProbe(app, watchdog, fired, name, preserveFailure = false) {
  clearTimeout(watchdog)
  const watchdogFired = fired()
  const child = app.process()
  const started = performance.now()
  let error
  try {
    await app.close()
  } catch (failure) {
    error = failure
  }
  if (watchdogFired || error)
    console.error(
      'source format cleanup:',
      JSON.stringify({
        name,
        watchdogFired,
        closeError: error ? String(error).slice(0, 200) : null,
        closeMs: Math.round(performance.now() - started),
        pid: child.pid,
        exitCode: child.exitCode,
        signalCode: child.signalCode,
      }),
    )
  if (preserveFailure) return
  if (error) throw error
  if (watchdogFired) throw new Error(`${name} Electron watchdog expired.`)
}

test('lazy rich startup applies view attributes after mounting and accepts native input', {
  timeout: 40000,
}, async (t) => {
  const started = performance.now()
  const attempts = []
  let activeAttempt = -1
  let phase = 'setup'
  let attemptStarted = started
  const mark = (name) => {
    phase = name
    if (activeAttempt >= 0)
      attempts[activeAttempt][name] = Math.round(
        performance.now() - attemptStarted,
      )
  }
  const report = (reason) =>
    console.error(
      'source format startup phases:',
      JSON.stringify({
        reason,
        totalMs: Math.round(performance.now() - started),
        activeAttempt,
        phase,
        attempts,
      }),
    )
  const slow = setTimeout(() => report('30s'), 30000)
  slow.unref()
  const folder = await mkdtemp(join(tmpdir(), 'hibi-rich-startup-'))
  t.after(async () => {
    clearTimeout(slow)
    report('end')
    await rm(folder, { recursive: true, force: true })
  })
  for (let attempt = 0; attempt < 4; attempt++) {
    activeAttempt = attempt
    attemptStarted = performance.now()
    attempts.push({ attempt, launch: 0 })
    phase = 'launch'
    const app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${join(folder, String(attempt))}`],
    })
    mark('launched')
    let watchdogFired = false
    const watchdog = setTimeout(() => {
      watchdogFired = true
      stopElectronTree(app.process())
    }, 8000)
    let failed = false
    try {
      const page = await app.firstWindow()
      mark('firstWindow')
      page.setDefaultTimeout(5000)
      const editor = page.getByRole('textbox', {
        name: 'Document editor',
        exact: true,
      })
      await editor.waitFor({ timeout: 5000 })
      mark('editorReady')
      await page.waitForFunction(
        () =>
          document.querySelector('.tiptap')?.getAttribute('spellcheck') ===
          'true',
      )
      mark('spellcheckReady')
      await editor.fill(`ready ${attempt}`)
      mark('filled')
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
      mark('verified')
    } catch (error) {
      failed = true
      attempts[attempt].error = String(error).slice(0, 180)
      report('failure')
      throw error
    } finally {
      mark('cleanupStart')
      clearTimeout(watchdog)
      if (failed || watchdogFired) stopElectronTree(app.process())
      else
        await app
          .evaluate(({ dialog }) => {
            dialog.showMessageBox = async () => ({ response: 1 })
          })
          .catch(() => {})
      if (!failed && !watchdogFired) mark('dialogReady')
      await closeProbe(
        app,
        watchdog,
        () => watchdogFired,
        `rich ${attempt}`,
        failed,
      )
      mark('closed')
    }
  }
})

test('standalone source skips rich attachment and hidden previews while preserving view, history and saves', {
  timeout: 60000,
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
  let watchdogFired = false
  const watchdog = setTimeout(() => {
    watchdogFired = true
    stopElectronTree(app.process())
  }, 55000)
  t.after(async () => {
    clearTimeout(watchdog)
    if (!watchdogFired)
      await app
        .evaluate(({ dialog }) => {
          dialog.showMessageBox = async () => ({ response: 1 })
        })
        .catch(() => {})
    try {
      await closeProbe(app, watchdog, () => watchdogFired, 'standalone source')
    } finally {
      await rm(profile, { recursive: true, force: true })
    }
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  await page
    .getByRole('textbox', { name: 'Document editor', exact: true })
    .waitFor()
  await page.waitForFunction(() => window.sourceFormatFixture?.rich === 1)
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  // A stalled font load must not leave the source editor inert.
  await page.evaluate(() => {
    document.fonts.load = () => new Promise(() => {})
  })
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await clickMenu(app, 'Open…')
  try {
    await page
      .locator(
        '.editor-panes.mode-markdown[data-source-ready="true"] .source-pane:not([inert]) .cm-content[contenteditable="true"][aria-label="Probe editor"]',
      )
      .waitFor({ timeout: 30_000 })
  } catch (error) {
    let timer
    try {
      const source = page.evaluate(() => {
        const panes = document.querySelector('.editor-panes')
        const pane = document.querySelector('.source-pane')
        const content = pane?.querySelector('.cm-content')
        return {
          modeMarkdown: panes?.classList.contains('mode-markdown'),
          sourceReady: panes?.getAttribute('data-source-ready'),
          sourcePaneInert: pane?.inert,
          contentEditable: content?.getAttribute('contenteditable'),
          contentLabel: content?.getAttribute('aria-label'),
          fontStatus: document.fonts.status,
          fixtureRich: window.sourceFormatFixture?.rich,
          documentName:
            window.sourceFormatFixture?.context.editor.getDocument()?.name,
          alerts: Array.from(document.querySelectorAll('[role="alert"]'))
            .slice(0, 3)
            .map((alert) => alert.textContent?.slice(0, 200)),
        }
      })
      const [startup, state] = await Promise.all([
        startupDiagnostics(app, page),
        Promise.race([
          source.catch(() => ({ unavailable: true })),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve({ unavailable: true }), 1000)
          }),
        ]),
      ])
      console.error(
        'probe source readiness:',
        JSON.stringify({ startup, state }),
      )
    } catch {
      // Keep the original locator failure if diagnostics cannot run.
    } finally {
      clearTimeout(timer)
    }
    throw error
  }
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
