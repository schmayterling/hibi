import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { selectFormattedEngine } from './formatted-engine.mjs'
import { pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('tiptap: rich source edits preserve exact source and one-step undo and reject stale projections', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-rich-edits-'))
  const directory = join(profile, 'installed-addons', 'review-fixture')
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'hibi-addon.json'),
    JSON.stringify({
      id: 'review-fixture',
      name: 'Review fixture',
      description: 'Review API test',
      kind: 'extension',
      apiVersion: 2,
      version: '1.0.0',
      authors: [{ displayName: 'Test' }],
      entry: 'index.js',
    }),
  )
  await writeFile(
    join(directory, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['index.js', 'hibi-addon.json'],
      source: 'local',
    }),
  )
  await writeFile(
    join(directory, 'index.js'),
    `export default () => ({ start(context) {
      window.richReview = context.editor;
      context.editor.registerRich({ id: 'append', attach(editor) {
        const Plugin = editor.state.plugins[0].constructor;
        const plugin = new Plugin({ appendTransaction(transactions, oldState, state) {
          if (window.appendDuringReview && transactions.some(tr => tr.docChanged) && !transactions.some(tr => tr.getMeta('reviewAppend')))
            return state.tr.insertText('!', state.doc.content.size - 1).setMeta('reviewAppend', true);
        }});
        editor.registerPlugin(plugin);
        return () => editor.unregisterPlugin(plugin.key);
      }});
    } });`,
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'review-fixture': true }),
  )
  const source =
    '---\ntitle: review\n---\n\n# A note\n\nvery very **teh** 😀 é and [teh](https://example.com/teh).\n'
  const file = join(profile, 'review.md')
  await writeFile(file, source)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`, file],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await selectFormattedEngine(app, page, 'tiptap')
  await page.waitForFunction(() =>
    window.richReview?.getTextProjection()?.text.includes('teh'),
  )
  const result = await page.evaluate(async () => {
    const api = window.richReview
    const editor = document.querySelector('.tiptap').editor
    const current = api.getDocument(),
      projection = api.getTextProjection()
    const first = current.markdown.indexOf('very very'),
      typo = current.markdown.indexOf('teh')
    const request = {
      requestId: 'fix',
      tabId: current.tabId,
      revision: current.revision,
      contentVersion: current.contentVersion,
      projectionId: projection.id,
      changes: [
        { from: first, to: first + 5, insert: '', expectedText: 'very ' },
        { from: typo, to: typo + 3, insert: 'the', expectedText: 'teh' },
      ],
    }
    const applied = api.applySourceEdits(request)
    const corrected = (await window.hibi.getDocument()).markdown
    const duplicate = api.applySourceEdits(request)
    editor.commands.undo()
    const undone = api.getDocument().markdown
    editor.commands.redo()
    const redone = api.getDocument().markdown
    const stale = api.applySourceEdits({
      ...request,
      requestId: 'stale',
      contentVersion: api.getDocument().contentVersion,
    })
    const now = api.getDocument(),
      at = now.markdown.indexOf('**the**')
    const markup = api.applySourceEdits({
      requestId: 'markup',
      tabId: now.tabId,
      revision: now.revision,
      contentVersion: now.contentVersion,
      changes: [{ from: at, to: at + 2, insert: '', expectedText: '**' }],
    })
    Object.defineProperty(editor.view, 'composing', {
      configurable: true,
      value: true,
    })
    const composing = api.applySourceEdits({
      requestId: 'ime',
      tabId: now.tabId,
      revision: now.revision,
      contentVersion: now.contentVersion,
      changes: [
        { from: at + 2, to: at + 5, insert: 'our', expectedText: 'the' },
      ],
    })
    delete editor.view.composing
    window.appendDuringReview = true
    const appended = api.applySourceEdits({
      requestId: 'appended',
      tabId: now.tabId,
      revision: now.revision,
      contentVersion: now.contentVersion,
      changes: [
        { from: at + 2, to: at + 5, insert: 'our', expectedText: 'the' },
      ],
    })
    window.appendDuringReview = false
    const afterAppended = api.getDocument().markdown
    return {
      applied,
      corrected,
      duplicate,
      undone,
      redone,
      stale,
      markup,
      composing,
      appended,
      afterAppended,
    }
  })
  assert.equal(result.applied.status, 'applied')
  assert.equal(
    result.corrected,
    source.replace('very very', 'very').replace('**teh**', '**the**'),
  )
  assert.deepEqual(result.duplicate, result.applied)
  assert.equal(result.undone, source)
  assert.equal(result.redone, result.corrected)
  assert.equal(result.stale.status, 'stale')
  assert.equal(result.markup.status, 'unsupported-view')
  assert.equal(result.composing.status, 'composing')
  assert.equal(result.appended.status, 'unsupported-view')
  assert.equal(result.afterAppended, result.corrected)
})

test('codemirror: api 2 source edits preserve canonical source, history and projection guards', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-formatted-edits-'))
  const directory = join(profile, 'installed-addons', 'review-fixture')
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'hibi-addon.json'),
    JSON.stringify({
      id: 'review-fixture',
      name: 'Review fixture',
      description: 'Canonical source edit test',
      kind: 'extension',
      apiVersion: 2,
      version: '1.0.0',
      capabilities: [],
      authors: [{ displayName: 'Test' }],
      entry: 'index.js',
    }),
  )
  await writeFile(
    join(directory, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['index.js', 'hibi-addon.json'],
      source: 'local',
    }),
  )
  await writeFile(
    join(directory, 'index.js'),
    'export default () => ({ start(context) { window.sourceReview = context.editor; } });',
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'review-fixture': true }),
  )
  const source =
    '---\ntitle: review\n---\n\n# A note\n\nvery very **teh** 😀 é and [teh](https://example.com/teh).\n'
  const file = join(profile, 'review.md')
  await writeFile(file, source)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`, file],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  const editor = await selectFormattedEngine(app, page, 'codemirror')
  await page.waitForFunction(() =>
    window.sourceReview?.getTextProjection()?.text.includes('teh'),
  )
  const result = await page.evaluate(async () => {
    const api = window.sourceReview
    const current = api.getDocument()
    const projection = api.getTextProjection()
    const first = current.markdown.indexOf('very very')
    const typo = current.markdown.indexOf('teh')
    const request = {
      requestId: 'fix',
      tabId: current.tabId,
      revision: current.revision,
      contentVersion: current.contentVersion,
      projectionId: projection.id,
      changes: [
        { from: first, to: first + 5, insert: '', expectedText: 'very ' },
        { from: typo, to: typo + 3, insert: 'the', expectedText: 'teh' },
      ],
    }
    window.sourceReviewRequest = request
    const applied = api.applySourceEdits(request)
    return {
      applied,
      duplicate: api.applySourceEdits(request),
      corrected: (await window.hibi.getDocument()).markdown,
    }
  })
  const corrected = source
    .replace('very very', 'very')
    .replace('**teh**', '**the**')
  assert.equal(result.applied.status, 'applied')
  assert.deepEqual(result.duplicate, result.applied)
  assert.equal(result.corrected, corrected)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await pressShortcut(app, `${mod}+z`)
  await waitForAsync(
    page,
    async (source) => (await window.hibi.getDocument()).markdown === source,
    source,
  )
  await pressShortcut(
    app,
    process.platform === 'win32' ? 'Control+y' : `${mod}+Shift+z`,
  )
  await waitForAsync(
    page,
    async (source) => (await window.hibi.getDocument()).markdown === source,
    corrected,
  )
  const stale = await page.evaluate(() =>
    window.sourceReview.applySourceEdits({
      ...window.sourceReviewRequest,
      requestId: 'stale',
      contentVersion: window.sourceReview.getDocument().contentVersion,
    }),
  )
  assert.equal(stale.status, 'stale')

  const markup = await page.evaluate(() => {
    const api = window.sourceReview
    const now = api.getDocument()
    const at = now.markdown.indexOf('**the**')
    return api.applySourceEdits({
      requestId: 'markup',
      tabId: now.tabId,
      revision: now.revision,
      contentVersion: now.contentVersion,
      changes: [{ from: at, to: at + 2, insert: '', expectedText: '**' }],
    })
  })
  await t.test(
    'rich source edits reject a structural markup change',
    {
      todo: 'formatted gap api-005: rich source edits must reject structural markup changes',
    },
    async () => {
      assert.equal(markup.status, 'unsupported-view')
      assert.equal(
        (await page.evaluate(() => window.hibi.getDocument())).markdown,
        corrected,
      )
    },
  )
  if (markup.status === 'applied') await pressShortcut(app, `${mod}+z`)
  await waitForAsync(
    page,
    async (source) => (await window.hibi.getDocument()).markdown === source,
    corrected,
  )

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await editor.focus()
  await editor.press('ControlOrMeta+a')
  await editor.press('ArrowRight')
  await cdp.send('Input.imeSetComposition', {
    text: '仮',
    selectionStart: 1,
    selectionEnd: 1,
  })
  const composing = await page.evaluate(() => {
    const api = window.sourceReview
    const now = api.getDocument()
    const at = now.markdown.indexOf('the')
    return api.applySourceEdits({
      requestId: 'ime',
      tabId: now.tabId,
      revision: now.revision,
      contentVersion: now.contentVersion,
      changes: [{ from: at, to: at + 3, insert: 'our', expectedText: 'the' }],
    })
  })
  assert.equal(composing.status, 'composing')
  await cdp.send('Input.imeSetComposition', {
    text: '',
    selectionStart: 0,
    selectionEnd: 0,
  })
  await waitForAsync(
    page,
    async (source) => (await window.hibi.getDocument()).markdown === source,
    corrected,
  )
  await cdp.detach()
})
