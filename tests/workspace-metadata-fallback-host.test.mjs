import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'

test('a timed-out note keeps useful backlinks, tags and paged headings and is named in the sidebar', {
  timeout: 30000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-metadata-fallback-'))
  const notes = join(root, 'notes')
  await mkdir(notes)
  await writeFile(join(notes, 'target.md'), '# Target')
  await writeFile(
    join(notes, 'slow.md'),
    '# slow\n' +
      '*a '.repeat(16384) +
      '\n[Target](target.md) #retained\n## later',
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  })
  t.after(async () => {
    await app.evaluate(() => {
      const state = globalThis.fallbackProbe
      if (state)
        process.getBuiltinModule(
          'node:worker_threads',
        ).Worker.prototype.postMessage = state.postMessage
    })
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(6500)
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ dialog, ipcMain }, notes) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [notes],
    })
    const Worker = process.getBuiltinModule('node:worker_threads').Worker
    const state = {
      postMessage: Worker.prototype.postMessage,
      slow: new WeakSet(),
      injected: 0,
      fallback: 0,
      syntax: null,
    }
    globalThis.fallbackProbe = state
    Worker.prototype.postMessage = function (message, ...args) {
      if (message.kind === 'fileStart') {
        if (message.input.path === 'slow.md') state.slow.add(this)
        else state.slow.delete(this)
      }
      if (message.kind === 'parseEnd' && state.slow.has(this)) {
        if (message.fallback) state.fallback++
        else {
          state.injected++
          queueMicrotask(() =>
            this.emit(
              'error',
              Object.assign(new Error('metadata watchdog fixture'), {
                code: 'ERR_METADATA_TIMEOUT',
              }),
            ),
          )
          return
        }
      }
      return state.postMessage.call(this, message, ...args)
    }
    const handler = ipcMain._invokeHandlers.get('workspace:query-references')
    ipcMain._invokeHandlers.set(
      'workspace:query-references',
      (event, request) => {
        if (request.kind === 'backlinks') state.syntax = request.syntaxSnapshot
        return handler(event, request)
      },
    )
  }, notes)
  await page.evaluate(() => window.hibi.openWorkspace(false))
  const targetRow = page.getByRole('treeitem', {
    name: 'target.md',
    exact: true,
  })
  if (!(await targetRow.isVisible()))
    await page
      .getByRole('button', { name: /toggle workspace sidebar/i })
      .click()
  await targetRow.click()
  await waitForDocumentEditor(app, page)
  await page.getByRole('button', { name: 'Toggle right sidebar' }).click()
  await page.getByRole('button', { name: 'Right sidebar views' }).click()
  await page.getByRole('menuitem', { name: 'Backlinks' }).click()
  const sidebar = page.getByRole('complementary', { name: 'Backlinks' })
  const status = sidebar.getByRole('status')
  await status.waitFor()
  assert.match(await status.textContent(), /incomplete.*slow\.md/i)
  await sidebar.getByText('slow.md', { exact: true }).waitFor()
  const before = await app.evaluate(() => ({
    injected: globalThis.fallbackProbe.injected,
    fallback: globalThis.fallbackProbe.fallback,
    syntax: globalThis.fallbackProbe.syntax,
  }))
  assert.ok(before.injected > 0)
  assert.equal(before.fallback, before.injected)
  const headings = await page.evaluate(async (syntaxSnapshot) => {
    const header = await window.hibi.getWorkspaceHeader()
    return window.hibi.queryWorkspaceReferences({
      target: header.target,
      kind: 'headings',
      path: 'slow.md',
      syntaxSnapshot,
      limit: 100,
    })
  }, before.syntax)
  assert.equal(headings.ok, true)
  assert.equal(headings.value.complete, false)
  assert.deepEqual(headings.value.items, [
    { depth: 1, text: 'slow' },
    { depth: 2, text: 'later' },
  ])
  assert.deepEqual(headings.value.incompletePaths, ['slow.md'])
  const tags = await page.evaluate(async (syntaxSnapshot) => {
    const header = await window.hibi.getWorkspaceHeader()
    return window.hibi.queryWorkspaceReferences({
      target: header.target,
      kind: 'tags',
      syntaxSnapshot,
      limit: 100,
    })
  }, before.syntax)
  assert.equal(tags.ok, true)
  assert.equal(tags.value.complete, false)
  assert.deepEqual(tags.value.items, [{ tag: 'retained', count: 1 }])
  assert.deepEqual(tags.value.incompletePaths, ['slow.md'])
  assert.equal(
    await app.evaluate(() => globalThis.fallbackProbe.fallback),
    before.fallback,
  )
})
