import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { sourceOperationLimits } from '../src/shared/source-operations.ts'
import {
  electron,
  stopElectronTree,
  waitForDocumentEditor,
} from './electron.mjs'
import { selectFormattedEngine } from './formatted-engine.mjs'
import { replaceSourceText } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('S01/S03/S07/J01: accepted rich transformations are savable before callbacks and rejected changes stay atomic', {
  timeout: 45000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-rich-source-'))
  const addon = join(profile, 'installed-addons', 'bridge-fixture'),
    file = join(profile, 'note.md')
  await mkdir(addon, { recursive: true })
  await writeFile(
    join(addon, 'hibi-addon.json'),
    JSON.stringify({
      id: 'bridge-fixture',
      name: 'Bridge fixture',
      description: 'Source observation fixture',
      kind: 'extension',
      apiVersion: 2,
      capabilities: [],
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
    'export default () => ({start(context) { window.bridgeContext = context; }});',
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'bridge-fixture': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  let stage = 'startup'
  const watchdog = setTimeout(() => {
    console.error(`rich source test stalled during ${stage}`)
    stopElectronTree(app.process())
  }, 30_000)
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
  await page.waitForFunction(() => !!window.bridgeContext)
  await app.evaluate(({ dialog, ipcMain }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
    const append = ipcMain._invokeHandlers.get('document:append')
    if (!append) throw new Error('The source append handler is not ready.')
    globalThis.bridgeOperations = []
    ipcMain.removeHandler('document:append')
    ipcMain.handle('document:append', (...args) => {
      globalThis.bridgeOperations.push(args[1])
      return append(...args)
    })
  }, file)
  stage = 'accepted append and immediate save'
  const initial = await page.evaluate(async () => {
    const editor = document.querySelector('.tiptap').editor,
      context = window.bridgeContext
    const state = {
      append: true,
      echoAppend: false,
      before: [],
      after: [],
      saved: null,
      original: context.editor.getDocument(),
    }
    window.bridgeFixture = state
    // Share the editor's installed PM runtime instead of bundling a second copy.
    const Plugin = editor.state.plugins[0].constructor
    editor.registerPlugin(
      new Plugin({
        filterTransaction: (transaction) =>
          !transaction.getMeta('rejectFixture'),
        appendTransaction(transactions, _old, current) {
          if (
            !state.append ||
            !transactions.some((tr) => tr.docChanged) ||
            transactions.some((tr) => tr.getMeta('fixtureAppend'))
          )
            return null
          if (
            !state.echoAppend &&
            transactions.some((tr) => tr.getMeta('preventUpdate'))
          )
            return null
          return current.tr
            .insertText('!', current.doc.content.size - 1)
            .setMeta('fixtureAppend', true)
        },
      }),
    )
    editor.on('beforeTransaction', ({ nextState }) => {
      state.before.push({
        source: context.editor.getDocument().markdown,
        version: context.editor.getDocument().contentVersion,
        candidate: nextState.doc.textContent,
        view: editor.state.doc.textContent,
      })
      state.saved ??= context.editor.runCommand('saveAs')
    })
    editor.on('transaction', () =>
      state.after.push({
        source: context.editor.getDocument().markdown,
        view: editor.state.doc.textContent,
      }),
    )
    editor.commands.insertContent('alpha')
    await state.saved
    return {
      before: state.before[0],
      after: state.after[0],
      original: state.original.markdown,
      current: context.editor.getDocument(),
    }
  })
  assert.deepEqual(initial.before, {
    source: 'alpha!',
    version: 1,
    candidate: 'alpha!',
    view: '',
  })
  assert.deepEqual(initial.after, { source: 'alpha!', view: 'alpha!' })
  assert.equal(initial.original, '')
  assert.equal(await readFile(file, 'utf8'), 'alpha!')
  assert.equal(initial.current.contentVersion, 1)

  stage = 'filter, dry-run history and transaction rejection'
  const result = await page.evaluate(async (insertLimit) => {
    const editor = document.querySelector('.tiptap').editor,
      context = window.bridgeContext,
      fixture = window.bridgeFixture
    const beforeFilter = context.editor.getDocument()
    editor.view.dispatch(
      editor.state.tr.insertText('bad', 1).setMeta('rejectFixture', true),
    )
    const filtered = context.editor.getDocument()
    fixture.append = false
    editor.commands.setContent('quiet', {
      contentType: 'markdown',
      emitUpdate: false,
    })
    const quiet = context.editor.getDocument()
    editor.can().keyboardShortcut('Mod-z')
    const afterCan = context.editor.getDocument()
    editor.commands.keyboardShortcut('Mod-z')
    const undone = context.editor.getDocument()
    editor.commands.keyboardShortcut('Mod-Shift-z')
    const redone = context.editor.getDocument()
    const observations = fixture.before.length
    editor.commands.setContent('x'.repeat(insertLimit + 1), {
      contentType: 'markdown',
    })
    const rejected = context.editor.getDocument()
    const rejectedView = editor.state.doc.textContent
    const rejectedObserved = fixture.before.length !== observations
    editor.commands.insertContent('z')
    const valid = context.editor.getDocument()
    await window.hibi.flushDocumentChanges()
    return {
      beforeFilter,
      filtered,
      quiet,
      afterCan,
      undone,
      redone,
      rejected,
      rejectedView,
      rejectedObserved,
      valid,
      view: editor.state.doc.textContent,
    }
  }, sourceOperationLimits.insertedUnits)
  assert.equal(
    result.filtered.contentVersion,
    result.beforeFilter.contentVersion,
  )
  assert.equal(result.filtered.markdown, 'alpha!')
  assert.equal(result.quiet.markdown, 'quiet')
  assert.equal(result.afterCan.contentVersion, result.quiet.contentVersion)
  assert.equal(result.afterCan.markdown, 'quiet')
  assert.equal(result.undone.markdown, 'alpha!')
  assert.equal(result.redone.markdown, 'quiet')
  assert.equal(result.rejected.contentVersion, result.redone.contentVersion)
  assert.equal(result.rejected.markdown, 'quiet')
  assert.equal(result.rejectedView, 'quiet')
  assert.equal(result.rejectedObserved, false)
  assert.equal(result.valid.markdown, result.view)
  assert.equal(result.valid.markdown.length, 6)
  const operations = await app.evaluate(() => globalThis.bridgeOperations)
  assert.deepEqual(
    operations.map((op) => op.contentVersion),
    [1, 2, 3, 4, 5],
  )
  assert.deepEqual(
    operations.map((op) => op.origin),
    ['visual', 'visual', 'undo', 'redo', 'visual'],
  )
  assert.ok(operations.every((op) => op.document && op.operationId))

  stage = 'source echo rejection and recovery'
  const failedEcho = await page.evaluate(async () => {
    window.bridgeFixture.append = true
    window.bridgeFixture.echoAppend = true
    await window.bridgeContext.editor.runCommand('undo')
    const before = window.bridgeContext.editor.getDocument()
    document.querySelector('.tiptap').editor.commands.insertContent('unsafe')
    const after = window.bridgeContext.editor.getDocument()
    window.bridgeFixture.append = false
    window.bridgeFixture.echoAppend = false
    return { before, after }
  })
  assert.equal(failedEcho.before.markdown, 'quiet')
  assert.equal(
    failedEcho.after.contentVersion,
    failedEcho.before.contentVersion,
  )
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await page.waitForFunction(
    () =>
      document.querySelector('.tiptap').editor.state.doc.textContent ===
      'quiet',
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'quiet',
  )

  stage = 'failed source echo stays read-only until retry'
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  await replaceSourceText(
    page,
    page.getByRole('textbox', { name: 'Markdown editor', exact: true }),
    'source echo fixture',
  )
  await waitForAsync(
    page,
    async () =>
      (await window.hibi.getDocument()).markdown === 'source echo fixture',
  )
  await page.evaluate(() => {
    const editor = document.querySelector('.tiptap').editor
    const rejectOnce = ({ transaction }) => {
      if (transaction.doc.textContent !== 'source echo fixture') return
      editor.off('transaction', rejectOnce)
      throw new Error('Fixture rejected the source echo after rendering.')
    }
    editor.on('transaction', rejectOnce)
  })
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await page
    .getByText('Fixture rejected the source echo after rendering.')
    .waitFor()
  const failedSync = await page.evaluate(async () => {
    const rich = document.querySelector('.tiptap')
    return {
      source: (await window.hibi.getDocument()).markdown,
      rendered: rich.editor.state.doc.textContent,
      editable: rich.isContentEditable,
      readonly: rich.getAttribute('aria-readonly'),
    }
  })
  assert.deepEqual(failedSync, {
    source: 'source echo fixture',
    rendered: 'source echo fixture',
    editable: false,
    readonly: 'true',
  })
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await page.waitForFunction(
    () => document.querySelector('.tiptap')?.isContentEditable,
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'source echo fixture',
  )
})

test('codemirror: accepted transformations are immediately savable and rejected changes stay atomic', {
  timeout: 45000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-cm-rich-source-'))
  const addon = join(profile, 'installed-addons', 'bridge-fixture'),
    file = join(profile, 'note.md')
  await mkdir(addon, { recursive: true })
  await writeFile(
    join(addon, 'hibi-addon.json'),
    JSON.stringify({
      id: 'bridge-fixture',
      name: 'Bridge fixture',
      description: 'Source observation fixture',
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
    'export default sdk => ({start(context) { window.bridgeContext = context; window.bridgeSdk = sdk; }});',
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'bridge-fixture': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  let stage = 'startup'
  const watchdog = setTimeout(() => {
    console.error(`rich source test stalled during ${stage}`)
    stopElectronTree(app.process())
  }, 30_000)
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
  await selectFormattedEngine(app, page, 'codemirror')
  await page.waitForFunction(() => !!window.bridgeContext)
  await app.evaluate(({ dialog, ipcMain }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
    const append = ipcMain._invokeHandlers.get('document:append')
    if (!append) throw new Error('The source append handler is not ready.')
    globalThis.bridgeOperations = []
    ipcMain.removeHandler('document:append')
    ipcMain.handle('document:append', (...args) => {
      globalThis.bridgeOperations.push(args[1])
      return append(...args)
    })
  }, file)

  stage = 'accepted transformation and observer save'
  const initial = await page.evaluate(async () => {
    const { state, view: views } = window.bridgeSdk.codeMirror
    const context = window.bridgeContext
    const view = views.EditorView.findFromDOM(
      document.querySelector('.rich-pane .cm-content'),
    )
    const fixture = {
      view,
      append: true,
      observations: [],
      saved: null,
      reject: state.Annotation.define(),
    }
    window.cmBridge = fixture
    view.dispatch({
      effects: state.StateEffect.appendConfig.of([
        state.EditorState.transactionFilter.of((tr) => {
          if (tr.annotation(fixture.reject)) return []
          if (!tr.docChanged || !fixture.append) return tr
          return [
            tr,
            {
              changes: { from: tr.newDoc.length, insert: '!' },
              sequential: true,
            },
          ]
        }),
        views.EditorView.updateListener.of((update) => {
          if (!update.docChanged) return
          const current = context.editor.getDocument()
          fixture.observations.push({
            source: current.markdown,
            version: current.contentVersion,
            view: update.state.doc.toString(),
          })
          fixture.saved ??= context.editor.runCommand('saveAs')
        }),
      ]),
    })
    view.dispatch({
      changes: { from: 0, insert: 'alpha' },
      selection: { anchor: 5 },
      userEvent: 'input.type',
    })
    await fixture.saved
    return {
      observed: fixture.observations[0],
      current: context.editor.getDocument(),
      text: view.state.doc.toString(),
    }
  })
  assert.deepEqual(initial.observed, {
    source: 'alpha!',
    version: 1,
    view: 'alpha!',
  })
  assert.equal(initial.text, 'alpha!')
  assert.equal(initial.current.markdown, 'alpha!')
  assert.equal(initial.current.contentVersion, 1)
  assert.equal(await readFile(file, 'utf8'), 'alpha!')

  stage = 'filter, dry-run history and operation limit rejection'
  const result = await page.evaluate(async (insertLimit) => {
    const fixture = window.cmBridge
    const { view } = fixture
    const context = window.bridgeContext
    const commands = window.bridgeSdk.codeMirror.commands
    const beforeFilter = context.editor.getDocument()
    view.dispatch({
      changes: { from: 1, insert: 'bad' },
      annotations: fixture.reject.of(true),
    })
    const filtered = context.editor.getDocument()
    fixture.append = false
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: 'quiet' },
      selection: { anchor: 5 },
      userEvent: 'input.fixture',
    })
    const quiet = context.editor.getDocument()
    const canUndo = commands.undoDepth(view.state) > 0
    const afterCan = context.editor.getDocument()
    commands.undo(view)
    const undone = context.editor.getDocument()
    commands.redo(view)
    const redone = context.editor.getDocument()
    const observations = fixture.observations.length
    const beforeReject = view.state
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: 'x'.repeat(insertLimit + 1),
      },
      userEvent: 'input.fixture',
    })
    const rejected = context.editor.getDocument()
    const rejectedView = view.state.doc.toString()
    const rejectedObserved = fixture.observations.length !== observations
    const sameSelection = view.state.selection.eq(beforeReject.selection)
    const sameDocument = view.state.doc === beforeReject.doc
    view.dispatch({
      changes: { from: view.state.doc.length, insert: 'z' },
      selection: { anchor: view.state.doc.length + 1 },
      userEvent: 'input.type',
    })
    await window.hibi.flushDocumentChanges()
    return {
      beforeFilter,
      filtered,
      quiet,
      canUndo,
      afterCan,
      undone,
      redone,
      rejected,
      rejectedView,
      rejectedObserved,
      sameSelection,
      sameDocument,
      valid: context.editor.getDocument(),
      text: view.state.doc.toString(),
    }
  }, sourceOperationLimits.insertedUnits)
  t.diagnostic(
    JSON.stringify({
      stage: 'codemirror admission and history',
      canUndo: result.canUndo,
      snapshots: Object.fromEntries(
        [
          'filtered',
          'quiet',
          'afterCan',
          'undone',
          'redone',
          'rejected',
          'valid',
        ].map((name) => [
          name,
          {
            length: result[name].markdown.length,
            text: result[name].markdown.slice(0, 80),
            version: result[name].contentVersion,
          },
        ]),
      ),
      rejectedObserved: result.rejectedObserved,
      sameSelection: result.sameSelection,
      sameDocument: result.sameDocument,
    }),
  )
  assert.equal(
    result.filtered.contentVersion,
    result.beforeFilter.contentVersion,
  )
  assert.equal(result.filtered.markdown, 'alpha!')
  assert.equal(result.quiet.markdown, 'quiet')
  assert.equal(result.canUndo, true)
  assert.equal(result.afterCan.contentVersion, result.quiet.contentVersion)
  assert.equal(result.afterCan.markdown, 'quiet')
  assert.equal(result.undone.markdown, 'alpha!')
  assert.equal(result.redone.markdown, 'quiet')
  assert.equal(result.rejected.contentVersion, result.redone.contentVersion)
  assert.equal(result.rejected.markdown, 'quiet')
  assert.equal(result.rejectedView, 'quiet')
  assert.equal(result.rejectedObserved, false)
  assert.equal(result.sameSelection, true)
  assert.equal(result.sameDocument, true)
  assert.equal(result.valid.markdown, 'quietz')
  assert.equal(result.text, 'quietz')
  const operations = await app.evaluate(() => globalThis.bridgeOperations)
  assert.deepEqual(
    operations.map((op) => op.contentVersion),
    [1, 2, 3, 4, 5],
  )
  assert.equal(operations[2].origin, 'undo')
  assert.equal(operations[3].origin, 'redo')
  assert.ok(operations.every((op) => op.document && op.operationId))

  stage = 'source echoes bypass formatted transaction transformations'
  await page.evaluate(() => {
    window.cmBridge.append = true
  })
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  await replaceSourceText(
    page,
    page.getByRole('textbox', { name: 'Markdown editor', exact: true }),
    'unaltered source echo',
  )
  await waitForAsync(
    page,
    async () =>
      (await window.hibi.getDocument()).markdown === 'unaltered source echo',
  )
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await waitForDocumentEditor(app, page)
  assert.equal(
    await page.evaluate(() => window.cmBridge.view.state.doc.toString()),
    'unaltered source echo',
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'unaltered source echo',
  )
  await page.evaluate(() => {
    window.cmBridge.append = false
  })

  stage = 'failed source echo stays read-only until retry'
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  await page.evaluate(() => {
    const { view } = window.cmBridge
    window.cmBridge.echoFaultFired = false
    const update = view.update
    view.update = function (transactions) {
      update.call(this, transactions)
      if (
        transactions.some((tr) => tr.docChanged) &&
        this.state.doc.toString() === 'source echo fixture'
      ) {
        window.cmBridge.echoFaultFired = true
        view.update = update
        throw new Error('Fixture rejected the source echo after rendering.')
      }
    }
  })
  try {
    await replaceSourceText(
      page,
      page.getByRole('textbox', { name: 'Markdown editor', exact: true }),
      'source echo fixture',
    )
    await waitForAsync(
      page,
      async () =>
        (await window.hibi.getDocument()).markdown === 'source echo fixture',
    )
    await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
    await page
      .getByText('Fixture rejected the source echo after rendering.', {
        exact: true,
      })
      .waitFor()
  } catch (error) {
    t.diagnostic(
      JSON.stringify(
        await page.evaluate(async () => {
          const element = document.querySelector('.rich-pane .cm-content')
          return {
            stage: 'source echo failure',
            faultFired: window.cmBridge.echoFaultFired,
            source: (await window.hibi.getDocument()).markdown,
            rendered: element?.innerText,
            editable: element?.isContentEditable,
            notices: [
              ...document.querySelectorAll(
                '[role="alert"], [role="status"], .document-notice',
              ),
            ].map((notice) => notice.textContent),
          }
        }),
      ),
    )
    throw error
  }
  const failed = await page.evaluate(async () => {
    const element = document.querySelector('.rich-pane .cm-content')
    return {
      source: (await window.hibi.getDocument()).markdown,
      text: element.cmTile.root.view.state.doc.toString(),
      editable: element.isContentEditable,
      readonly: element.getAttribute('aria-readonly'),
    }
  })
  assert.deepEqual(failed, {
    source: 'source echo fixture',
    text: 'source echo fixture',
    editable: false,
    readonly: 'true',
  })
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await waitForDocumentEditor(app, page)
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'source echo fixture',
  )
  stage = 'source echo rejection blocks further input until Retry'
  const message = 'Fixture rejected the source echo before rendering.'
  await page.evaluate((message) => {
    const view = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    const update = view.update
    view.update = function (transactions) {
      if (transactions.some((tr) => tr.docChanged)) {
        view.update = update
        throw new Error(message)
      }
      update.call(this, transactions)
    }
  }, message)
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  await replaceSourceText(
    page,
    page.getByRole('textbox', { name: 'Markdown editor', exact: true }),
    'rejected echo',
  )
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).markdown === 'rejected echo',
  )
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await page.getByText(message, { exact: true }).waitFor()
  const rejectedEcho = await page.evaluate(async () => {
    const element = document.querySelector('.rich-pane .cm-content')
    const view = element.cmTile.root.view
    const before = await window.hibi.getDocument()
    view.dispatch({
      changes: { from: 0, insert: 'unsafe' },
      userEvent: 'input.type',
    })
    return {
      before,
      after: await window.hibi.getDocument(),
      editable: element.isContentEditable,
    }
  })
  await t.test(
    'a rejected source echo refuses further edits without advancing canonical version',
    () => {
      assert.equal(rejectedEcho.before.markdown, 'rejected echo')
      assert.equal(rejectedEcho.after.markdown, 'rejected echo')
      assert.equal(
        rejectedEcho.after.contentVersion,
        rejectedEcho.before.contentVersion,
      )
      assert.equal(rejectedEcho.editable, false)
    },
  )
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await waitForDocumentEditor(app, page)
  assert.equal(
    await page.locator('.rich-pane .cm-content').textContent(),
    'rejected echo',
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'rejected echo',
  )
})
