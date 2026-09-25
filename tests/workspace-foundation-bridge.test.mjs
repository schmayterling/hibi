import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'

test('workspace addon bridge keeps scoped reads, creates, and changes together', {
  timeout: 60000,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hibi-workspace-bridge-'))
  const workspace = join(directory, 'notes')
  await mkdir(workspace)
  await writeFile(join(workspace, 'existing.md'), '# existing')
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
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, workspace)
  const page = await app.firstWindow()
  await page.locator('.titlebar').waitFor()
  await page.evaluate(() => window.hibi.openWorkspace())
  const snapshot = await page.evaluate(async () => {
    window.workspaceChanges = []
    window.workspaceSubscription = await window.hibi.subscribeWorkspaceChanges(
      (change) => window.workspaceChanges.push(change),
    )
    return window.workspaceSubscription.snapshot
  })
  assert.ok(snapshot.target)
  assert.equal(snapshot.complete, true)
  const target = snapshot.target
  const read = await page.evaluate(
    (captured) => window.hibi.readWorkspaceText(captured, 'existing.md'),
    target,
  )
  assert.deepEqual(read, {
    ok: true,
    value: {
      target,
      path: 'existing.md',
      markdown: '# existing',
      source: 'disk',
    },
  })
  const created = await page.evaluate(
    (captured) => window.hibi.createWorkspaceText(captured, 'new.md', '# new'),
    target,
  )
  assert.equal(created.ok, true)
  assert.equal(await readFile(join(workspace, 'new.md'), 'utf8'), '# new')
  await page.waitForFunction(() => window.workspaceChanges.length > 0)
  assert.equal(
    (await page.evaluate(() => window.workspaceChanges)).every(
      (change) =>
        change.workspaceId === target.workspaceId &&
        change.workspaceGeneration === target.workspaceGeneration,
    ),
    true,
  )
  const duplicate = await page.evaluate(
    (captured) =>
      window.hibi.createWorkspaceText(captured, 'new.md', 'overwrite'),
    target,
  )
  assert.deepEqual(duplicate, {
    ok: false,
    code: 'conflict',
    message: 'A file already exists at that path.',
  })
  await page.evaluate(() => window.workspaceSubscription.dispose())
})
