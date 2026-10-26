import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'
import { electron } from './electron.mjs'

const bundle = await build({
  entryPoints: ['src/main/workspace-refresh.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const { createScanCoordinator, watchNeedsScan } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
)

test('workspace scans finish current callers before coalesced follow-up callers', async () => {
  const scans = []
  const published = []
  const coordinator = createScanCoordinator(
    () =>
      new Promise((resolve) => {
        scans.push(resolve)
      }),
    (value) => published.push(value),
  )

  const first = coordinator.request()
  const second = coordinator.request()
  const third = coordinator.request()
  assert.equal(scans.length, 1)
  scans.shift()('first')
  assert.equal(await first, 'first')
  assert.equal(scans.length, 1)
  assert.deepEqual(published, ['first'])

  scans.shift()('follow-up')
  assert.deepEqual(await Promise.all([second, third]), [
    'follow-up',
    'follow-up',
  ])
  assert.deepEqual(published, ['first', 'follow-up'])
  coordinator.close()
})

test('closing a workspace prevents an in-flight scan from publishing', async () => {
  let complete
  const published = []
  const coordinator = createScanCoordinator(
    () => new Promise((resolve) => (complete = resolve)),
    (value) => published.push(value),
  )
  const pending = coordinator.request()
  coordinator.close()
  complete('old workspace')
  assert.equal(await pending, null)
  assert.deepEqual(published, [])
})

test('only closure aborts traversal and cancels queued requests', async () => {
  const scans = []
  const coordinator = createScanCoordinator(
    (signal) => new Promise((resolve) => scans.push({ signal, resolve })),
    () => {},
  )
  const pending = coordinator.request()
  const first = scans[0]
  const followUp = coordinator.request()
  assert.equal(first.signal.aborted, false)
  first.resolve('first')
  assert.equal(await pending, 'first')
  const next = scans[1]
  const queued = coordinator.request()
  assert.equal(next.signal.aborted, false)
  coordinator.close()
  assert.equal(next.signal.aborted, true)
  assert.equal(await queued, null)
  next.resolve('closed')
  assert.equal(await followUp, null)
  assert.equal(await coordinator.request(), null)
  assert.equal(scans.length, 2)
})

test('watcher rescans new, removed, and parent directory changes', () => {
  assert.equal(watchNeedsScan(null, 'file'), true)
  assert.equal(watchNeedsScan('file', null), true)
  assert.equal(watchNeedsScan('folder', 'folder'), true)
  assert.equal(watchNeedsScan('file', 'file'), false)
})

test('save emits content changes and rename publishes the updated tree', {
  timeout: 45000,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hibi-refresh-'))
  const root = join(directory, 'notes')
  await mkdir(root)
  await mkdir(join(root, '.git'))
  await writeFile(join(root, '.git', 'index'), 'before')
  await writeFile(join(root, 'one.md'), 'before')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(directory, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(directory, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await app.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] })
  }, root)
  await page.evaluate(() => window.hibi.openWorkspace())
  await page.evaluate(() => {
    window.workspaceChanges = []
    window.hibi.onWorkspaceChanged((_workspace, change) => {
      window.workspaceChanges.push(change)
    })
  })

  await page.evaluate(async () => {
    await window.hibi.openWorkspaceFile('one.md')
    window.hibi.updateDocument('after')
    await window.hibi.saveDocument(false)
  })
  await delay(450)
  const afterSave = await page.evaluate(() => window.workspaceChanges)
  assert.ok(
    afterSave.some(
      (change) =>
        change?.kind === 'content' && change.paths?.includes('one.md'),
    ),
  )
  await page.evaluate(() => {
    window.workspaceChanges = []
  })

  await page.evaluate(() =>
    window.hibi.workspaceAction({
      action: 'rename',
      path: 'one.md',
      destination: 'two.md',
    }),
  )
  await delay(450)
  const afterRename = await page.evaluate(() => window.workspaceChanges)
  assert.ok(
    afterRename.some(
      (change) =>
        change?.kind === 'tree' &&
        change.paths?.includes('one.md') &&
        change.paths?.includes('two.md'),
    ),
  )
  assert.deepEqual(
    (await page.evaluate(() => window.hibi.getWorkspace())).entries.map(
      (entry) => entry.path,
    ),
    ['two.md'],
  )

  await page.evaluate(() => {
    window.workspaceChanges = []
  })
  await page.evaluate(() =>
    window.hibi.updateWorkspaceSettings({ action: 'create-manifest' }),
  )
  await delay(450)
  const metadataTrees = (
    await page.evaluate(() => window.workspaceChanges)
  ).filter((change) => change?.kind === 'tree')
  assert.equal(metadataTrees.length, 1)
  assert.deepEqual(metadataTrees[0].paths, ['.hibi/workspace.json'])

  await page.evaluate(() => {
    window.workspaceChanges = []
  })
  await writeFile(join(root, '.git', 'index'), 'after')
  await page.waitForFunction(() =>
    window.workspaceChanges.some(
      (change) =>
        change?.kind === 'content' && change.paths?.includes('.git/index'),
    ),
  )
  assert.equal(
    (await page.evaluate(() => window.workspaceChanges)).filter(
      (change) => change?.kind === 'tree',
    ).length,
    0,
  )
})
