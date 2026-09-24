import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { waitForAsync } from './poll.mjs'

test('note indexes include drafts, exclude media/symlinks, and coexist with saves and snapshots', {
  timeout: 30000,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hibi-note-index-'))
  const root = join(directory, 'notes')
  await mkdir(root)
  await writeFile(join(directory, 'private.md'), '# private')
  await symlink(join(directory, 'private.md'), join(root, 'linked.md'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(directory, 'profile')}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(directory, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  assert.equal(await page.evaluate(() => window.hibi.getWorkspaceIndex()), null)
  await app.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] })
  }, root)
  await page.evaluate(() => window.hibi.openWorkspace())
  assert.deepEqual(
    (await page.evaluate(() => window.hibi.getWorkspaceIndex())).pages,
    [],
  )
  const draft = await page.evaluate(() =>
    window.hibi.workspaceAction({ action: 'new-file', path: '' }),
  )
  const text = '# draft\n\n#work\n\n![image](missing.png)'
  await page.evaluate((text) => window.hibi.updateDocument(text), text)
  const index = await page.evaluate(() => window.hibi.getWorkspaceIndex())
  assert.deepEqual(
    index.pages.map((page) => page.path),
    [draft.path],
  )
  assert.equal(index.pages[0].markdown, text)
  assert.equal(index.pages[0].id, draft.document.id)
  assert.equal(index.pages[0].images, undefined)
  await assert.rejects(readFile(join(root, draft.path)), /ENOENT/)
  await app.evaluate(
    ({ dialog }, file) => {
      dialog.showSaveDialog = () =>
        new Promise((resolve) => {
          globalThis.releaseIndexSave = () =>
            resolve({ canceled: false, filePath: file })
        })
    },
    join(root, 'saved.md'),
  )
  const save = page.evaluate(() => window.hibi.saveDocument(true))
  await waitForAsync(
    app,
    () => typeof globalThis.releaseIndexSave === 'function',
  )
  const reads = page.evaluate(() =>
    Promise.all([
      window.hibi.getWorkspaceIndex(),
      window.hibi.getWorkspaceSnapshot(),
    ]),
  )
  await app.evaluate(() => globalThis.releaseIndexSave())
  await save
  await reads
  await page.evaluate(() => window.hibi.refreshWorkspace())
  const concurrent = await page.evaluate(() =>
    Promise.all([
      window.hibi.getWorkspaceIndex(),
      window.hibi.getWorkspaceSnapshot(),
      window.hibi.saveDocument(false),
    ]),
  )
  assert.equal(concurrent[0].pages[0].markdown, text)
  assert.equal(concurrent[1].pages[0].markdown, text)
  assert.equal(await readFile(join(root, 'saved.md'), 'utf8'), text)

  const extra = join(root, 'extra.md')
  await writeFile(extra, '# extra')
  await page.evaluate(() => window.hibi.refreshWorkspace())
  const added = await page.evaluate(() =>
    Promise.all([
      window.hibi.getWorkspaceIndex(),
      window.hibi.getWorkspaceIndex(),
    ]),
  )
  assert.deepEqual(
    added.map((index) => index.pages.map((page) => page.path)),
    [
      ['extra.md', 'saved.md'],
      ['extra.md', 'saved.md'],
    ],
  )
  const changedText = `${text}\nchanged`
  await writeFile(join(root, 'saved.md'), changedText)
  const changed = await page.evaluate(() => window.hibi.getWorkspaceIndex(true))
  assert.equal(
    changed.pages.find((page) => page.path === 'saved.md').markdown,
    changedText,
  )
  await rm(extra)
  await page.evaluate(() => window.hibi.refreshWorkspace())
  assert.deepEqual(
    (await page.evaluate(() => window.hibi.getWorkspaceIndex())).pages.map(
      (page) => page.path,
    ),
    ['saved.md'],
  )
})
