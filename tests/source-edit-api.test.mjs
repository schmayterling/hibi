import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('a review addon applies source edits atomically, preserves undo, and rejects stale or stopped requests', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-source-edits-'))
  const directory = join(profile, 'installed-addons', 'local-review')
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'hibi-addon.json'),
    JSON.stringify({
      id: 'local-review',
      name: 'Local review',
      description: 'Edit API fixture',
      kind: 'extension',
      apiVersion: 1,
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
    `export default sdk => ({start(context) {
    window.reviewFixture = { context, sdk, review() {
      const snapshot = context.editor.getDocument();
      const source = snapshot.markdown;
      const repeated = source.indexOf('very very');
      const typo = source.indexOf('teh');
      return { requestId: crypto.randomUUID(), tabId: snapshot.tabId, revision: snapshot.revision,
        contentVersion: snapshot.contentVersion, changes: [
          {from: repeated + 5, to: repeated + 10, insert: '', expectedText: 'very '},
          {from: typo, to: typo + 3, insert: 'the', expectedText: 'teh'},
        ] };
    }};
  }, stop() {
    window.reviewStopStatus = window.reviewFixture.context.editor.applySourceEdits(window.oldProposal).status;
  }});`,
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'local-review': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(6000)
  const original = 'very very good and teh note'
  const corrected = 'very good and the note'
  await page
    .getByRole('textbox', { name: 'Document editor', exact: true })
    .fill(original)
  const richResult = await page.evaluate(() => {
    const { context, review } = window.reviewFixture
    return context.editor.applySourceEdits(review())
  })
  assert.equal(richResult.status, 'applied')
  await page.evaluate(() =>
    document.querySelector('.tiptap').editor.commands.undo(),
  )
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await page.waitForFunction(
    () => document.querySelector('.cm-content')?.isContentEditable,
  )
  const result = await page.evaluate(async () => {
    const { context, sdk, review } = window.reviewFixture
    const view = sdk.codeMirror.view.EditorView.findFromDOM(
      document.querySelector('.cm-content'),
    )
    const type = (text) =>
      view.dispatch({
        changes: { from: view.state.doc.length, insert: text },
        annotations:
          sdk.codeMirror.state.Transaction.userEvent.of('input.type'),
      })
    type('!')
    const proposal = review()
    const applied = context.editor.applySourceEdits(proposal)
    const immediate = context.editor.getDocument()
    const native = await window.hibi.getDocument()
    const duplicate = context.editor.applySourceEdits(proposal)
    const conflicting = context.editor.applySourceEdits({
      ...proposal,
      changes: [{ from: 0, to: 0, insert: 'x', expectedText: '' }],
    })
    type('?')
    sdk.codeMirror.commands.undo(view)
    const afterTypingUndo = context.editor.getDocument().markdown
    sdk.codeMirror.commands.undo(view)
    const undone = context.editor.getDocument().markdown
    sdk.codeMirror.commands.redo(view)
    const redone = context.editor.getDocument().markdown
    const stale = context.editor.applySourceEdits({
      ...proposal,
      requestId: crypto.randomUUID(),
    })
    const now = context.editor.getDocument()
    const insert = {
      ...proposal,
      requestId: crypto.randomUUID(),
      contentVersion: now.contentVersion,
      changes: [{ from: 0, to: 0, insert: 'x', expectedText: '' }],
    }
    Object.defineProperty(view, 'composing', {
      configurable: true,
      value: true,
    })
    const composing = context.editor.applySourceEdits(insert)
    delete view.composing
    window.oldProposal = proposal
    return {
      applied,
      immediate,
      native,
      duplicate,
      conflicting,
      afterTypingUndo,
      undone,
      redone,
      stale,
      composing,
    }
  })
  assert.equal(result.applied.status, 'applied')
  assert.equal(result.immediate.markdown, `${corrected}!`)
  assert.equal(result.immediate.contentVersion, result.applied.contentVersion)
  assert.equal(result.native.markdown, `${corrected}!`)
  assert.deepEqual(result.duplicate, result.applied)
  assert.equal(result.conflicting.status, 'invalid')
  assert.equal(result.afterTypingUndo, `${corrected}!`)
  assert.equal(result.undone, `${original}!`)
  assert.equal(result.redone, `${corrected}!`)
  assert.equal(result.stale.status, 'stale')
  assert.equal(result.composing.status, 'composing')
  await page.evaluate(() =>
    window.reviewFixture.context.editor.updateMarkdown(
      () => '😀\r\nteh note\r\n',
    ),
  )
  await page.waitForFunction(() =>
    document.querySelector('.cm-content')?.textContent.includes('teh note'),
  )
  const lineEndings = await page.evaluate(() => {
    const { context, sdk } = window.reviewFixture
    const view = sdk.codeMirror.view.EditorView.findFromDOM(
      document.querySelector('.cm-content'),
    )
    const snapshot = context.editor.getDocument()
    const request = (changes) => ({
      requestId: crypto.randomUUID(),
      tabId: snapshot.tabId,
      revision: snapshot.revision,
      contentVersion: snapshot.contentVersion,
      changes,
    })
    const split = context.editor.applySourceEdits(
      request([{ from: 3, to: 3, insert: 'x', expectedText: '' }]),
    )
    const applied = context.editor.applySourceEdits(
      request([{ from: 4, to: 7, insert: 'the', expectedText: 'teh' }]),
    )
    const corrected = context.editor.getDocument().markdown
    sdk.codeMirror.commands.undo(view)
    const undone = context.editor.getDocument().markdown
    sdk.codeMirror.commands.redo(view)
    return {
      split,
      applied,
      corrected,
      undone,
      redone: context.editor.getDocument().markdown,
    }
  })
  assert.equal(lineEndings.split.status, 'invalid')
  assert.equal(lineEndings.applied.status, 'applied')
  assert.equal(lineEndings.corrected, '😀\r\nthe note\r\n')
  assert.equal(lineEndings.undone, '😀\r\nteh note\r\n')
  assert.equal(lineEndings.redone, lineEndings.corrected)
  await app.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => ({ canceled: true })
  })
  const busy = await page.evaluate(async () => {
    const { context } = window.reviewFixture
    const current = context.editor.getDocument()
    const save = context.editor.runCommand('save')
    const result = context.editor.applySourceEdits({
      requestId: crypto.randomUUID(),
      tabId: current.tabId,
      revision: current.revision,
      contentVersion: current.contentVersion,
      changes: [{ from: 0, to: 0, insert: 'x', expectedText: '' }],
    })
    await save
    return result
  })
  assert.equal(busy.status, 'busy')
  await clickMenu(app, 'New')
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).markdown === '',
  )
  assert.equal(
    await page.evaluate(
      () =>
        window.reviewFixture.context.editor.applySourceEdits({
          ...window.oldProposal,
          requestId: crypto.randomUUID(),
        }).status,
    ),
    'stale',
  )
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  await page.locator('#addon-local-review').click()
  await page.waitForFunction(
    () => !document.querySelector('#addon-local-review').checked,
  )
  assert.equal(await page.evaluate(() => window.reviewStopStatus), 'disposed')
  assert.equal(
    await page.evaluate(
      () =>
        window.reviewFixture.context.editor.applySourceEdits(window.oldProposal)
          .status,
    ),
    'disposed',
  )
})
