import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { replaceRichText } from './keyboard.mjs'

test('atomic source operations cross preload barriers, save exact text and recover after reload', {
  timeout: 30_000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-atomic-native-'))
  const destination = join(profile, 'saved.md')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }, destination) => {
    dialog.showSaveDialog = async () => ({
      canceled: false,
      filePath: destination,
    })
    dialog.showMessageBox = async () => ({ response: 1 })
  }, destination)
  const page = await app.firstWindow()
  await waitForDocumentEditor(app, page)
  await replaceRichText(
    page,
    page.getByRole('textbox', { name: /document editor/i }),
    'abcdef',
  )
  const result = await page.evaluate(async () => {
    const before = await window.hibi.getDocument()
    const operation = {
      document: { tabId: before.tabId, revision: before.revision },
      operationId: 'native-batch',
      baseVersion: before.contentVersion,
      contentVersion: before.contentVersion + 1,
      origin: 'visual',
      historyGroup: 'format',
      changes: [
        { from: 0, to: 1, insert: 'A' },
        { from: 5, to: 6, insert: 'F' },
      ],
    }
    return { before, operation }
  })
  assert.equal(result.before.markdown, 'abcdef')
  const saved = await page.evaluate(async (operation) => {
    const pending = window.hibi.appendSourceOperation(operation)
    const document = await window.hibi.saveDocument(false)
    const ack = await pending
    return { document, ack }
  }, result.operation)
  assert.equal(saved.ack.operationId, 'native-batch')
  assert.equal(saved.document.saveReceipt, true)
  assert.equal(saved.document.savedVersion, result.operation.contentVersion)
  assert.equal(saved.document.contentVersion, result.operation.contentVersion)
  assert.equal('markdown' in saved.document, false)
  assert.equal(saved.document.dirty, false)
  assert.equal(await readFile(destination, 'utf8'), 'AbcdeF')
  // Raw journal appends bypass the renderer session; reload adopts their source.
  await page.reload()
  await waitForDocumentEditor(app, page)
  const restored = await page.evaluate(() => window.hibi.getDocument())
  assert.equal(restored.markdown, 'AbcdeF')
  assert.equal(restored.savedMarkdown, 'AbcdeF')
  assert.equal(restored.dirty, false)
  assert.equal(restored.contentVersion, result.operation.contentVersion)
  if (process.platform === 'darwin') {
    const editor = page.getByRole('textbox', { name: /document editor/i })
    await replaceRichText(page, editor, 'XbcdeF')
    await page.evaluate(() => window.hibi.flushDocumentChanges())
    assert.equal(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isDocumentEdited(),
      ),
      true,
    )
    await replaceRichText(page, editor, 'AbcdeF')
    await page.evaluate(() => window.hibi.flushDocumentChanges())
    let edited = true
    for (let attempt = 0; attempt < 50 && edited; attempt++) {
      edited = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isDocumentEdited(),
      )
      if (edited) await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(
      edited,
      false,
      'Returning to saved source clears the native dirty indicator.',
    )
  }
})
