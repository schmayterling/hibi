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
  await writeFile(join(workspace, 'other.md'), '# other')
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
  const firstPage = await page.evaluate(
    ({ target, sequence }) =>
      window.hibi.listWorkspaceEntryPage('markdown', {
        target,
        sequence,
        limit: 1,
      }),
    { target, sequence: snapshot.sequence },
  )
  assert.equal(firstPage.ok, true)
  assert.equal(firstPage.value.entries.length, 1)
  assert.ok(firstPage.value.nextCursor)
  const secondPage = await page.evaluate(
    ({ target, cursor }) =>
      window.hibi.listWorkspaceEntryPage('markdown', {
        target,
        cursor,
        limit: 1,
      }),
    { target, cursor: firstPage.value.nextCursor },
  )
  assert.equal(secondPage.ok, true)
  assert.notEqual(
    secondPage.value.entries[0].path,
    firstPage.value.entries[0].path,
  )
  const oldPage = await page.evaluate(
    ({ target, sequence }) =>
      window.hibi.listWorkspaceEntryPage('markdown', { target, sequence }),
    { target, sequence: snapshot.sequence + 1 },
  )
  assert.equal(oldPage.code, 'resync-needed')
  const read = await page.evaluate(
    (captured) =>
      window.hibi.readWorkspaceText('markdown', captured, 'existing.md'),
    target,
  )
  assert.equal(read.ok, true)
  assert.deepEqual(
    { ...read.value, version: undefined },
    {
      target,
      path: 'existing.md',
      markdown: '# existing',
      version: undefined,
      source: 'disk',
    },
  )
  assert.match(read.value.version, /^[a-f0-9]{64}$/)
  const withoutReset = await page.evaluate(
    ({ target, version }) =>
      window.hibi.updateWorkspaceText(
        'markdown',
        target,
        'existing.md',
        version,
        '# changed',
      ),
    { target, version: read.value.version },
  )
  assert.equal(withoutReset.code, 'unsupported')
  assert.equal(
    await readFile(join(workspace, 'existing.md'), 'utf8'),
    '# existing',
  )
  const updated = await page.evaluate(
    ({ target, version }) =>
      window.hibi.updateWorkspaceText(
        'markdown',
        target,
        'existing.md',
        version,
        '# changed',
        { allowMetadataReset: true },
      ),
    { target, version: read.value.version },
  )
  if (process.platform === 'win32') assert.equal(updated.code, 'unsupported')
  else {
    assert.equal(updated.ok, true)
    assert.equal(updated.value.metadataPreserved, false)
    assert.equal(
      await readFile(join(workspace, 'existing.md'), 'utf8'),
      '# changed',
    )
  }
  const created = await page.evaluate(
    (captured) =>
      window.hibi.createWorkspaceText('markdown', captured, 'new.md', '# new'),
    target,
  )
  assert.equal(created.ok, true)
  assert.equal(created.value.ownerActiveAfterCommit, true)
  assert.equal(await readFile(join(workspace, 'new.md'), 'utf8'), '# new')
  const disabled = await page.evaluate(
    (captured) =>
      window.hibi.createWorkspaceText(
        'not-installed',
        captured,
        'denied.md',
        '',
      ),
    target,
  )
  assert.equal(disabled.code, 'disposed')
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
      window.hibi.createWorkspaceText(
        'markdown',
        captured,
        'new.md',
        'overwrite',
      ),
    target,
  )
  assert.deepEqual(duplicate, {
    ok: false,
    code: 'conflict',
    message: 'A file already exists at that path.',
  })
  const attachment = await page.evaluate(
    (captured) =>
      window.hibi.createWorkspaceBinary(
        'markdown',
        captured,
        'image.bin',
        new Uint8Array([0, 255, 65]),
      ),
    target,
  )
  assert.equal(attachment.ok, true)
  const binary = await page.evaluate(
    (captured) =>
      window.hibi.readWorkspaceBinary('markdown', captured, 'image.bin'),
    target,
  )
  assert.equal(binary.ok, true)
  assert.deepEqual(Array.from(binary.value.bytes), [0, 255, 65])
  assert.match(binary.value.version, /^[a-f0-9]{64}$/)
  const newFile = await page.evaluate(
    (captured) => window.hibi.readWorkspaceText('markdown', captured, 'new.md'),
    target,
  )
  const moved = await page.evaluate(
    ({ target, version }) =>
      window.hibi.renameWorkspaceFile(
        'markdown',
        target,
        'new.md',
        'moved.md',
        version,
      ),
    { target, version: newFile.value.version },
  )
  assert.equal(moved.ok, true)
  assert.equal(moved.value.sourceRemoved, true)
  assert.equal(await readFile(join(workspace, 'moved.md'), 'utf8'), '# new')
  const unversionedTrash = await page.evaluate(
    (captured) =>
      window.hibi.trashWorkspaceFile('markdown', captured, 'moved.md', ''),
    target,
  )
  assert.equal(unversionedTrash.code, 'unsupported')
  await page.evaluate(() => window.workspaceSubscription.dispose())
})
