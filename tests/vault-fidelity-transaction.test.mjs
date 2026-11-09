import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import * as links from '../src/main/workspace-obsidian-links.ts'
import { recoverObsidianRename } from '../src/main/workspace-obsidian-transaction.ts'
import { diffVault, snapshotVault } from './vault-fidelity.mjs'

async function vault(t) {
  const home = await realpath(
    await mkdtemp(join(tmpdir(), 'hibi-fidelity-transaction-')),
  )
  t.after(() => rm(home, { recursive: true, force: true }))
  const root = join(home, 'vault'),
    data = join(home, 'profile')
  await mkdir(join(root, '.obsidian'), { recursive: true })
  await mkdir(join(root, 'a'))
  await mkdir(join(root, 'z'))
  await writeFile(join(root, '.obsidian/app.json'), '{}\r\n')
  await writeFile(
    join(root, 'Target.md'),
    '\ufeff[[Target#self]]\r\n[one](a/one.md)\r\n',
  )
  await writeFile(join(root, 'a/one.md'), '\ufeff[[Target|a]]\r\n')
  await writeFile(join(root, 'z/two.md'), '[[Target#H]]\r\n')
  await writeFile(join(root, 'keep.bin'), Buffer.from([0, 255, 128]))
  return { root, data }
}
function moves(root) {
  return [
    () => rename(join(root, 'Target.md'), join(root, 'New.md')),
    () => rename(join(root, 'New.md'), join(root, 'Target.md')),
  ]
}

test('rename transaction rewrites source and N referrers with exact protected bytes and no staging leftovers', async (t) => {
  const { root, data } = await vault(t)
  const before = await snapshotVault(root)
  const plan = await links.prepareObsidianLinkUpdates(
    root,
    'Target.md',
    'New.md',
  )
  const changed = await plan.run(...moves(root), data)
  assert.deepEqual(
    new Set(changed),
    new Set(['New.md', 'a/one.md', 'z/two.md']),
  )
  assert.deepEqual(
    diffVault(before, await snapshotVault(root), {
      'Target.md': null,
      'New.md': {
        kind: 'file',
        bytes: Buffer.from('\ufeff[[New#self]]\r\n[one](a/one.md)\r\n'),
      },
      'a/one.md': { kind: 'file', bytes: Buffer.from('\ufeff[[New|a]]\r\n') },
      'z/two.md': { kind: 'file', bytes: Buffer.from('[[New#H]]\r\n') },
    }),
    [],
  )
})

test('preflight staging failure leaves rename and every referrer untouched', async (t) => {
  const { root, data } = await vault(t)
  const before = await snapshotVault(root)
  const plan = await links.prepareObsidianLinkUpdates(
    root,
    'Target.md',
    'New.md',
  )
  await chmod(join(root, 'z'), 0o555)
  try {
    let moved = false
    const [move, rollback] = moves(root)
    await assert.rejects(
      plan.run(
        async () => {
          moved = true
          await move()
        },
        rollback,
        data,
      ),
      /z\/two\.md/,
    )
    assert.equal(moved, false, 'no rename before every edit is staged')
    assert.deepEqual(diffVault(before, await snapshotVault(root)), [])
  } finally {
    await chmod(join(root, 'z'), 0o755)
  }
})

test('late dirty referrer rolls back all committed edits and original name', async (t) => {
  const { root, data } = await vault(t)
  const before = await snapshotVault(root)
  // Drive a version transition at the verification boundary, without timing a filesystem watcher.
  const openNotes = () =>
    readFileSync(join(root, 'a/one.md'), 'utf8').includes('[[New|')
      ? [{ file: join(root, 'z/two.md'), dirty: true }]
      : []
  const plan = await links.prepareObsidianLinkUpdates(
    root,
    'Target.md',
    'New.md',
    openNotes,
  )
  await assert.rejects(
    plan.run(...moves(root), data),
    /rolled back.*z\/two\.md|z\/two\.md.*rolled back/i,
  )
  assert.deepEqual(diffVault(before, await snapshotVault(root)), [])
})

test('external writer at next commit is never overwritten; earlier edits and move roll back', async (t) => {
  const { root, data } = await vault(t)
  const before = await snapshotVault(root)
  let changed = false
  const openNotes = () => {
    if (
      !changed &&
      readFileSync(join(root, 'a/one.md'), 'utf8').includes('[[New|')
    ) {
      changed = true
      writeFileSync(join(root, 'z/two.md'), 'external writer\r\n')
    }
    return []
  }
  const plan = await links.prepareObsidianLinkUpdates(
    root,
    'Target.md',
    'New.md',
    openNotes,
  )
  await assert.rejects(
    plan.run(...moves(root), data),
    /z\/two\.md.*journal|journal.*z\/two\.md/i,
  )
  assert.deepEqual(
    diffVault(before, await snapshotVault(root), {
      'z/two.md': { kind: 'file', bytes: Buffer.from('external writer\r\n') },
    }),
    [],
  )
  assert.equal(existsSync(join(root, 'Target.md')), true)
  assert.equal(
    await readFile(join(root, 'z/two.md'), 'utf8'),
    'external writer\r\n',
  )
})

test('dirty outgoing moved-note edits refuse before disk mutation with named note', async (t) => {
  const { root } = await vault(t)
  const before = await snapshotVault(root)
  await assert.rejects(
    links.prepareObsidianLinkUpdates(root, 'Target.md', 'New.md', () => [
      { file: join(root, 'Target.md'), dirty: true },
    ]),
    /Target\.md.*Save|Save.*Target\.md/,
  )
  assert.deepEqual(diffVault(before, await snapshotVault(root)), [])
})

for (const phase of ['before-move', 'after-move', 'after-first-edit']) {
  test(`crash recovery restores complete group at ${phase}`, async (t) => {
    const { root, data } = await vault(t)
    const before = await snapshotVault(root)
    const module = new URL(
      '../src/main/workspace-obsidian-links.ts',
      import.meta.url,
    ).href
    const script = [
      `import {prepareObsidianLinkUpdates} from ${JSON.stringify(module)}`,
      "import {readFileSync} from 'node:fs'",
      "import {rename} from 'node:fs/promises'",
      "import {join} from 'node:path'",
      `const root = ${JSON.stringify(root)}, data = ${JSON.stringify(data)}, phase = ${JSON.stringify(phase)}`,
      "const openNotes = () => { if(phase === 'after-first-edit' && readFileSync(join(root,'a/one.md'),'utf8').includes('[[New|')) process.exit(73); return [] }",
      "const plan = await prepareObsidianLinkUpdates(root,'Target.md','New.md',openNotes)",
      "await plan.run(async () => { if(phase === 'before-move')process.exit(73); await rename(join(root,'Target.md'),join(root,'New.md')); if(phase === 'after-move')process.exit(73) },async()=>{},data)",
    ].join('\n')
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', script],
      { encoding: 'utf8' },
    )
    assert.equal(result.status, 73, result.stderr)
    assert.match(await recoverObsidianRename(root, data), /rolled back/)
    assert.deepEqual(diffVault(before, await snapshotVault(root)), [])
    assert.equal(await recoverObsidianRename(root, data), null)
  })
}

test('folder move keeps outgoing links, hidden bytes, and relative staging paths valid', async (t) => {
  const { root, data } = await vault(t)
  await writeFile(join(root, 'a/.keep'), Buffer.from([0, 255]))
  await writeFile(
    join(root, 'a/one.md'),
    '\ufeff[up](../Target.md#H) [[../Target|alias]]\r\n',
  )
  await mkdir(join(root, 'deep'))
  const before = await snapshotVault(root)
  const plan = await links.prepareObsidianLinkUpdates(root, 'a', 'deep/moved')
  await plan.run(
    () => rename(join(root, 'a'), join(root, 'deep/moved')),
    () => rename(join(root, 'deep/moved'), join(root, 'a')),
    data,
  )
  assert.deepEqual(
    diffVault(before, await snapshotVault(root), {
      a: null,
      'a/one.md': null,
      'a/.keep': null,
      'deep/moved': { kind: 'directory' },
      'deep/moved/one.md': {
        kind: 'file',
        bytes: Buffer.from(
          '\ufeff[up](../../Target.md#H) [[../../Target|alias]]\r\n',
        ),
      },
      'deep/moved/.keep': before.get('a/.keep'),
      'Target.md': {
        kind: 'file',
        bytes: Buffer.from(
          '\ufeff[[Target#self]]\r\n[one](deep/moved/one.md)\r\n',
        ),
      },
    }),
    [],
  )
})

test('folder crash recovers relocated staging files and outgoing link edits', async (t) => {
  const { root, data } = await vault(t)
  await writeFile(
    join(root, 'a/one.md'),
    '[up](../Target.md) [[../Target]]\r\n',
  )
  await mkdir(join(root, 'deep'))
  await writeFile(join(root, 'z/two.md'), '[[a/one]]\r\n')
  const before = await snapshotVault(root)
  const module = new URL(
    '../src/main/workspace-obsidian-links.ts',
    import.meta.url,
  ).href
  const script = [
    'import {prepareObsidianLinkUpdates} from ' + JSON.stringify(module),
    "import {rename} from 'node:fs/promises'",
    "import {readFileSync} from 'node:fs'",
    'const root=' + JSON.stringify(root) + ',data=' + JSON.stringify(data),
    "const notes=()=>{try{if(readFileSync(root+'/deep/moved/one.md','utf8').includes('../../Target'))process.exit(73)}catch{}return[]}",
    "const p=await prepareObsidianLinkUpdates(root,'a','deep/moved',notes)",
    "await p.run(()=>rename(root+'/a',root+'/deep/moved'),async()=>{},data)",
  ].join('\n')
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', script],
    { encoding: 'utf8' },
  )
  assert.equal(result.status, 73, result.stderr)
  assert.match(await recoverObsidianRename(root, data), /rolled back/)
  assert.deepEqual(diffVault(before, await snapshotVault(root)), [])
})

test('normalization-equivalent source path keeps self and incoming unicode references valid', async (t) => {
  const { root, data } = await vault(t)
  const source = 'cafe\u0301.md'
  await writeFile(join(root, source), '\ufeff[[café#H]]\r\n')
  await writeFile(join(root, 'unicode-ref.md'), '[[CAFÉ#H|alias]]\r\n')
  if (!existsSync(join(root, 'café.md'))) {
    t.skip('filesystem distinguishes unicode normalization')
    return
  }
  const before = await snapshotVault(root)
  const plan = await links.prepareObsidianLinkUpdates(root, 'café.md', 'Été.md')
  await plan.run(
    () => rename(join(root, 'café.md'), join(root, 'Été.md')),
    () => rename(join(root, 'Été.md'), join(root, source)),
    data,
  )
  assert.deepEqual(
    diffVault(before, await snapshotVault(root), {
      [source]: null,
      'Été.md': { kind: 'file', bytes: Buffer.from('\ufeff[[Été#H]]\r\n') },
      'unicode-ref.md': {
        kind: 'file',
        bytes: Buffer.from('[[Été#H|alias]]\r\n'),
      },
    }),
    [],
  )
})

test('late read-only referrer rolls back group and preserves its bytes and permission', async (t) => {
  const { root, data } = await vault(t)
  const before = await snapshotVault(root)
  let changed = false
  const notes = () => {
    if (
      !changed &&
      readFileSync(join(root, 'a/one.md'), 'utf8').includes('[[New|')
    ) {
      changed = true
      chmodSync(join(root, 'z/two.md'), 0o444)
    }
    return []
  }
  const plan = await links.prepareObsidianLinkUpdates(
    root,
    'Target.md',
    'New.md',
    notes,
  )
  try {
    await assert.rejects(
      plan.run(...moves(root), data),
      /rolled back.*z\/two\.md.*read-only/i,
    )
    assert.equal(changed, true)
    assert.deepEqual(diffVault(before, await snapshotVault(root)), [])
    const { stat } = await import('node:fs/promises')
    assert.equal((await stat(join(root, 'z/two.md'))).mode & 0o777, 0o444)
  } finally {
    await chmod(join(root, 'z/two.md'), 0o644)
  }
})
