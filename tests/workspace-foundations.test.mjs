import assert from 'node:assert/strict'
import { renameSync, symlinkSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import { WorkspaceChangeStream } from '../src/main/workspace-change-stream.ts'
import { createExclusiveText } from '../src/main/workspace-exclusive-create.ts'
import { resolveWorkspaceEntry } from '../src/main/workspace-paths.ts'

test('workspace stream snapshot handoff and ordered generation changes', () => {
  const stream = new WorkspaceChangeStream()
  const oldTarget = { workspaceId: 'old', workspaceGeneration: 1 }
  const newTarget = { workspaceId: 'new', workspaceGeneration: 2 }
  stream.replace(oldTarget)
  const seen = []
  const entries = [{ path: 'note.md', name: 'note.md', kind: 'file' }]
  const subscription = stream.subscribe((event) => seen.push(event), entries, {
    stale: false,
    complete: true,
    capReached: false,
  })
  assert.deepEqual(subscription.snapshot.target, oldTarget)
  assert.equal(subscription.snapshot.sequence, 0)
  assert.equal(subscription.snapshot.complete, true)
  assert.equal(subscription.snapshot.stale, false)
  entries[0].name = 'changed after snapshot'
  assert.equal(subscription.snapshot.entries[0].name, 'note.md')
  stream.publish('content', ['note.md'])
  stream.publish('tree', ['other.md'])
  stream.replace(newTarget)
  stream.publish('resync', null)
  assert.deepEqual(
    seen.map(({ workspaceId, workspaceGeneration, sequence, kind }) => [
      workspaceId,
      workspaceGeneration,
      sequence,
      kind,
    ]),
    [
      ['old', 1, 1, 'content'],
      ['old', 1, 2, 'tree'],
      ['old', 1, 3, 'resync'],
      ['new', 2, 1, 'resync'],
    ],
  )
  subscription.dispose()
  subscription.dispose()
  stream.publish('content', ['later.md'])
  assert.equal(seen.length, 4)
})

test('workspace stream isolates throwing and self-removing listeners', async () => {
  const stream = new WorkspaceChangeStream()
  stream.replace({ workspaceId: 'workspace', workspaceGeneration: 1 })
  const seen = []
  const status = { stale: false, complete: true, capReached: false }
  const originalError = console.error
  console.error = () => {}
  try {
    stream.subscribe(
      () => {
        throw new Error('broken addon')
      },
      [],
      status,
    )
    stream.subscribe(
      async () => {
        throw new Error('rejected addon')
      },
      [],
      status,
    )
    const own = stream.subscribe(
      () => {
        seen.push('once')
        own.dispose()
      },
      [],
      status,
    )
    stream.subscribe(() => seen.push('healthy'), [], status)
    stream.publish('content', ['a.md'])
    stream.publish('content', ['b.md'])
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(seen, ['once', 'healthy', 'healthy'])
  } finally {
    console.error = originalError
  }
})

test('workspace stream preserves order when a listener publishes again', () => {
  const stream = new WorkspaceChangeStream()
  stream.replace({ workspaceId: 'workspace', workspaceGeneration: 1 })
  const status = { stale: false, complete: true, capReached: false }
  const seen = []
  stream.subscribe(
    (event) => {
      if (event.sequence === 1) stream.publish('content', ['nested.md'])
    },
    [],
    status,
  )
  stream.subscribe((event) => seen.push(event.sequence), [], status)
  stream.publish('content', ['first.md'])
  assert.deepEqual(seen, [1, 2])
})

test('recursive workspace publisher is disabled and subscribers resync', () => {
  const stream = new WorkspaceChangeStream()
  stream.replace({ workspaceId: 'workspace', workspaceGeneration: 1 })
  const status = { stale: false, complete: true, capReached: false }
  let resyncs = 0
  const originalError = console.error
  console.error = () => {}
  try {
    stream.subscribe(() => stream.publish('content', ['again.md']), [], status)
    stream.subscribe(
      (event) => {
        if (event.kind === 'resync') resyncs++
      },
      [],
      status,
    )
    stream.publish('content', ['first.md'])
    assert.equal(resyncs, 1)
  } finally {
    console.error = originalError
  }
})

test('workspace paths reject traversal and symlinks; create is exclusive', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-workspace-foundations-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, '新しい.md')
  assert.equal(await resolveWorkspaceEntry(root, '新しい.md', true), file)
  for (const invalid of [
    '../outside.md',
    '/tmp/outside.md',
    'C:\\outside.md',
    '.hidden',
    'con.md',
  ])
    await assert.rejects(resolveWorkspaceEntry(root, invalid, true))
  assert.deepEqual(await createExclusiveText(file, 'first', () => true), {
    directorySynced: process.platform !== 'win32',
    atomicVisibility: true,
  })
  await assert.rejects(
    createExclusiveText(file, 'second', () => true),
    { code: 'EEXIST' },
  )
  assert.equal(await readFile(file, 'utf8'), 'first')
  assert.equal(
    await createExclusiveText(join(root, 'stale.md'), 'stale', () => false),
    false,
  )
  await assert.rejects(readFile(join(root, 'stale.md')), { code: 'ENOENT' })
  await symlink(file, join(root, 'link.md'))
  await assert.rejects(resolveWorkspaceEntry(root, 'link.md'))
  await writeFile(join(root, 'existing.md'), 'saved')
  await assert.rejects(
    createExclusiveText(join(root, 'existing.md'), 'new', () => true),
    { code: 'EEXIST' },
  )
  assert.equal(await readFile(join(root, 'existing.md'), 'utf8'), 'saved')
  assert.equal(
    (await readdir(root)).filter((name) => name.endsWith('.tmp')).length,
    0,
  )
})

test('scoped text service reads disk and rejects stale or conflicting creates', async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'hibi-workspace-service-')),
  )
  t.after(() => rm(root, { recursive: true, force: true }))
  const target = { workspaceId: 'workspace', workspaceGeneration: 1 }
  const host = {
    root,
    target,
    openDocuments: [],
    changed: [],
    guard: () => true,
  }
  globalThis.__hibiWorkspaceTestHost = host
  t.after(() => delete globalThis.__hibiWorkspaceTestHost)
  const bundle = await build({
    entryPoints: ['src/main/workspace-files.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    plugins: [
      {
        name: 'workspace-host',
        setup(build) {
          build.onResolve({ filter: /^\.\/(workspace|document)$/ }, (args) =>
            args.importer.endsWith('/workspace-files.ts')
              ? { path: args.path, namespace: 'workspace-host' }
              : null,
          )
          build.onLoad(
            { filter: /.*/, namespace: 'workspace-host' },
            (args) => ({
              contents:
                args.path === './document'
                  ? 'export const hasOpenDocumentPath = (file) => globalThis.__hibiWorkspaceTestHost.openDocuments.some((draft) => draft.file === file)'
                  : `const host = () => globalThis.__hibiWorkspaceTestHost
               export const workspaceRoot = () => host().root
               export const isCurrentWorkspaceTarget = (target) => host().guard() &&
                 host().target?.workspaceId === target?.workspaceId &&
                 host().target?.workspaceGeneration === target?.workspaceGeneration
               export const refreshWorkspace = async (paths) => {
                 host().changed.push(paths); return { id: host().target.workspaceId }
               }
               export const notifyWorkspaceContent = async (paths) => {
                 host().changed.push(paths); return { id: host().target.workspaceId }
               }`,
              loader: 'js',
            }),
          )
        },
      },
    ],
  })
  const { createWorkspaceText, readWorkspaceText } = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
  )
  const created = await createWorkspaceText(target, 'note.md', 'first')
  assert.equal(created.ok, true)
  assert.equal(created.value.persisted, true)
  assert.equal(created.value.indexed, true)
  assert.deepEqual(host.changed, [['note.md']])
  const longName = `${'x'.repeat(240)}.md`
  assert.equal((await createWorkspaceText(target, longName, 'long')).ok, true)
  assert.deepEqual((await readWorkspaceText(target, 'note.md')).value, {
    target,
    path: 'note.md',
    markdown: 'first',
    source: 'disk',
  })
  assert.equal(
    (await createWorkspaceText(target, 'note.md', 'second')).code,
    'conflict',
  )
  assert.equal(await readFile(join(root, 'note.md'), 'utf8'), 'first')
  assert.equal(
    (await readWorkspaceText(target, 'missing.md')).code,
    'not-found',
  )
  host.openDocuments = [{ file: join(root, 'pending.md') }]
  assert.equal(
    (await createWorkspaceText(target, 'pending.md', 'text')).code,
    'conflict',
  )
  await assert.rejects(readFile(join(root, 'pending.md')), { code: 'ENOENT' })
  host.openDocuments = []
  assert.equal(
    (await createWorkspaceText(target, '../bad.md', 'text')).code,
    'permission-denied',
  )
  assert.equal(
    (
      await createWorkspaceText(
        target,
        'huge.md',
        'x'.repeat(2 * 1024 * 1024 + 1),
      )
    ).code,
    'limit-exceeded',
  )
  let conflictChecks = 0
  host.guard = () => {
    if (++conflictChecks === 3)
      host.openDocuments = [{ file: join(root, 'late.md') }]
    return true
  }
  assert.equal(
    (await createWorkspaceText(target, 'late.md', 'text')).code,
    'conflict',
  )
  await assert.rejects(readFile(join(root, 'late.md')), { code: 'ENOENT' })
  host.openDocuments = []
  let checks = 0
  host.guard = () => ++checks < 3
  assert.equal(
    (await createWorkspaceText(target, 'stale.md', 'text')).code,
    'stale',
  )
  await assert.rejects(readFile(join(root, 'stale.md')), { code: 'ENOENT' })
  host.guard = () => true
  host.target = { workspaceId: 'workspace', workspaceGeneration: 2 }
  assert.equal((await readWorkspaceText(target, 'note.md')).code, 'stale')
  host.target = target
  const outside = await realpath(
    await mkdtemp(join(tmpdir(), 'hibi-workspace-outside-')),
  )
  t.after(() => rm(outside, { recursive: true, force: true }))
  await mkdir(join(root, 'safe'))
  await writeFile(join(root, 'safe', 'nested.md'), 'inside')
  await writeFile(join(outside, 'nested.md'), 'outside')
  let swapChecks = 0
  host.guard = () => {
    if (++swapChecks === 2) {
      renameSync(join(root, 'safe'), join(root, 'safe-moved'))
      symlinkSync(outside, join(root, 'safe'))
    }
    return true
  }
  const swapped = await readWorkspaceText(target, 'safe/nested.md')
  assert.equal(swapped.ok, false)
  assert.notEqual(swapped.value?.markdown, 'outside')
  host.guard = () => true
  await rm(join(root, 'safe'))
  renameSync(join(root, 'safe-moved'), join(root, 'safe'))
  swapChecks = 0
  host.guard = () => {
    if (++swapChecks === 2) {
      renameSync(join(root, 'safe'), join(root, 'safe-moved'))
      symlinkSync(outside, join(root, 'safe'))
    }
    return true
  }
  assert.equal(
    (await createWorkspaceText(target, 'safe/new.md', 'text')).ok,
    false,
  )
  await assert.rejects(readFile(join(outside, 'new.md')), { code: 'ENOENT' })
})
