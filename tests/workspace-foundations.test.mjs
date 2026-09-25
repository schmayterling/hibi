import assert from 'node:assert/strict'
import { renameSync, symlinkSync } from 'node:fs'
import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
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

test('scoped text service guards reads, creates and closed-file updates', async (t) => {
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
    onRefresh: null,
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
                 host().changed.push(paths); host().onRefresh?.()
                 return { id: host().target.workspaceId }
               }
               export const notifyWorkspaceContent = async (paths) => {
                 host().changed.push(paths); host().onRefresh?.()
                 return { id: host().target.workspaceId }
               }`,
              loader: 'js',
            }),
          )
        },
      },
    ],
  })
  const { createWorkspaceText, readWorkspaceText, updateWorkspaceText } =
    await import(
      `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
    )
  const updateText = (target, path, version, markdown, owner) =>
    updateWorkspaceText(
      target,
      path,
      version,
      markdown,
      { allowMetadataReset: true },
      owner,
    )
  const created = await createWorkspaceText(target, 'note.md', 'first')
  assert.equal(created.ok, true)
  assert.equal(created.value.persisted, true)
  assert.equal(created.value.indexed, true)
  assert.deepEqual(host.changed, [['note.md']])
  const longName = `${'x'.repeat(240)}.md`
  assert.equal((await createWorkspaceText(target, longName, 'long')).ok, true)
  let ownerChecks = 0
  const disabled = await createWorkspaceText(
    target,
    'disabled.md',
    'text',
    () => ++ownerChecks < 4,
  )
  assert.equal(disabled.code, 'disposed')
  await assert.rejects(readFile(join(root, 'disabled.md')), { code: 'ENOENT' })
  let ownerActive = true
  host.onRefresh = () => {
    ownerActive = false
  }
  const committedAfterDisable = await createWorkspaceText(
    target,
    'committed.md',
    'text',
    () => ownerActive,
  )
  assert.equal(committedAfterDisable.ok, true)
  assert.equal(committedAfterDisable.value.persisted, true)
  assert.equal(committedAfterDisable.value.ownerActiveAfterCommit, false)
  assert.equal(await readFile(join(root, 'committed.md'), 'utf8'), 'text')
  host.onRefresh = null
  const originalRead = await readWorkspaceText(target, 'note.md')
  assert.equal(originalRead.ok, true)
  assert.deepEqual(
    [
      originalRead.value.target,
      originalRead.value.path,
      originalRead.value.markdown,
      originalRead.value.source,
    ],
    [target, 'note.md', 'first', 'disk'],
  )
  assert.match(originalRead.value.version, /^[a-f0-9]{64}$/)
  assert.equal(
    (
      await updateWorkspaceText(
        target,
        'note.md',
        originalRead.value.version,
        'not authorized',
      )
    ).code,
    'unsupported',
  )
  let finalNoteText = 'first'
  if (process.platform === 'win32') {
    assert.equal(
      (await updateText(target, 'note.md', originalRead.value.version, 'text'))
        .code,
      'unsupported',
    )
  } else {
    const firstUpdate = await updateText(
      target,
      'note.md',
      originalRead.value.version,
      'second',
    )
    assert.equal(firstUpdate.ok, true)
    assert.equal(firstUpdate.value.metadataPreserved, false)
    assert.equal((await stat(join(root, 'note.md'))).mode & 0o777, 0o600)
    assert.equal(await readFile(join(root, 'note.md'), 'utf8'), 'second')
    assert.equal(
      (await updateText(target, 'note.md', originalRead.value.version, 'third'))
        .code,
      'conflict',
    )
    const alternate = await realpath(join(root, 'NOTE.md')).catch(() => null)
    if (alternate === join(root, 'note.md')) {
      const aliasRead = await readWorkspaceText(target, 'NOTE.md')
      assert.equal(aliasRead.value.path, 'note.md')
      host.openDocuments = [{ file: join(root, 'note.md') }]
      assert.equal(
        (
          await updateText(
            target,
            'NOTE.md',
            aliasRead.value.version,
            'must not bypass open document',
          )
        ).code,
        'conflict',
      )
      host.openDocuments = []
    }
    assert.equal(await readFile(join(root, 'note.md'), 'utf8'), 'second')
    const currentRead = await readWorkspaceText(target, 'note.md')
    host.openDocuments = [{ file: join(root, 'note.md') }]
    assert.equal(
      (await updateText(target, 'note.md', currentRead.value.version, 'open'))
        .code,
      'conflict',
    )
    host.openDocuments = []
    await writeFile(join(root, 'note.md'), 'external')
    assert.equal(
      (await updateText(target, 'note.md', currentRead.value.version, 'lost'))
        .code,
      'conflict',
    )
    assert.equal(await readFile(join(root, 'note.md'), 'utf8'), 'external')
    const concurrentRead = await readWorkspaceText(target, 'note.md')
    const concurrent = await Promise.all([
      updateText(target, 'note.md', concurrentRead.value.version, 'one'),
      updateText(target, 'note.md', concurrentRead.value.version, 'two'),
    ])
    assert.equal(concurrent.filter((result) => result.ok).length, 1)
    const winner = concurrent.findIndex((result) => result.ok)
    assert.equal(concurrent[1 - winner].code, 'conflict')
    assert.equal(concurrent[winner].value.persisted, true)
    assert.equal(concurrent[winner].value.atomicVisibility, true)
    assert.match(concurrent[winner].value.version, /^[a-f0-9]{64}$/)
    assert.equal(
      await readFile(join(root, 'note.md'), 'utf8'),
      winner === 0 ? 'one' : 'two',
    )
    assert.equal(
      (await updateText(target, 'note.md', 'bad-token', 'invalid')).code,
      'unsupported',
    )
    await link(join(root, 'note.md'), join(root, 'linked.md'))
    const linkedRead = await readWorkspaceText(target, 'note.md')
    assert.equal(
      (await updateText(target, 'note.md', linkedRead.value.version, 'linked'))
        .code,
      'unsupported',
    )
    await rm(join(root, 'linked.md'))
    const beforeDisable = await readWorkspaceText(target, 'note.md')
    ownerActive = true
    host.onRefresh = () => {
      ownerActive = false
    }
    const updatedAfterDisable = await updateText(
      target,
      'note.md',
      beforeDisable.value.version,
      'committed update',
      () => ownerActive,
    )
    assert.equal(updatedAfterDisable.ok, true)
    assert.equal(updatedAfterDisable.value.persisted, true)
    assert.equal(updatedAfterDisable.value.ownerActiveAfterCommit, false)
    assert.match(updatedAfterDisable.value.version, /^[a-f0-9]{64}$/)
    assert.equal(
      await readFile(join(root, 'note.md'), 'utf8'),
      'committed update',
    )
    host.onRefresh = null
    let updateOwnerChecks = 0
    const ownerStoppedDuringStage = await updateText(
      target,
      'note.md',
      updatedAfterDisable.value.version,
      'must not commit',
      () => ++updateOwnerChecks < 6,
    )
    assert.equal(ownerStoppedDuringStage.code, 'disposed')
    assert.equal(
      await readFile(join(root, 'note.md'), 'utf8'),
      'committed update',
    )
    assert.equal(
      (await readdir(root)).filter((name) => name.endsWith('.tmp')).length,
      0,
    )
    await writeFile(join(root, 'replacement.md'), 'committed update')
    renameSync(join(root, 'replacement.md'), join(root, 'note.md'))
    const replacedRead = await readWorkspaceText(target, 'note.md')
    assert.notEqual(
      replacedRead.value.version,
      updatedAfterDisable.value.version,
    )
    assert.equal(
      (
        await updateText(
          target,
          'note.md',
          updatedAfterDisable.value.version,
          'must not replace newer inode',
        )
      ).code,
      'conflict',
    )
    finalNoteText = 'committed update'
  }
  assert.equal(
    (await createWorkspaceText(target, 'note.md', 'second')).code,
    'conflict',
  )
  assert.equal(await readFile(join(root, 'note.md'), 'utf8'), finalNoteText)
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
