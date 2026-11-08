import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import { diffVault, fixtureVault, snapshotVault } from './vault-fidelity.mjs'

const bundle = await build({
  entryPoints: ['src/main/workspace-trash.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  write: false,
})
const require = createRequire(import.meta.url)
async function fixture(t, settings) {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'hibi-trash-')))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const root = join(folder, 'vault')
  await fixtureVault(root, settings)
  let answer = 1
  const calls = []
  const module = { exports: {} }
  new Function('module', 'exports', 'require', bundle.outputFiles[0].text)(
    module,
    module.exports,
    (id) =>
      id === 'electron'
        ? {
            shell: {
              trashItem: async (path) => {
                calls.push(path)
                await rename(path, join(folder, 'system-trash'))
              },
            },
            dialog: { showMessageBox: async () => ({ response: answer }) },
          }
        : require(id),
  )
  return {
    root,
    folder,
    calls,
    answer: (next) => {
      answer = next
    },
    ...module.exports,
  }
}
test('local trash preserves bytes and handles filename collisions without overwriting', async (t) => {
  const f = await fixture(t, { trashOption: 'local' })
  await mkdir(join(f.root, '.trash'))
  await writeFile(join(f.root, '.trash/delete.md'), 'keep existing\r\n')
  const before = await snapshotVault(f.root)
  assert.equal(
    await f.trashWorkspaceEntry(null, f.root, join(f.root, 'delete.md')),
    true,
  )
  assert.deepEqual(f.calls, [])
  assert.deepEqual(
    diffVault(before, await snapshotVault(f.root), {
      'delete.md': null,
      '.trash/delete 2.md': before.get('delete.md'),
    }),
    [],
  )
})
test('permanent deletion requires deliberate confirmation; cancel keeps whole tree identical', async (t) => {
  const f = await fixture(t, { trashOption: 'none' })
  const before = await snapshotVault(f.root)
  assert.equal(
    await f.trashWorkspaceEntry(null, f.root, join(f.root, 'delete.md')),
    false,
  )
  assert.deepEqual(diffVault(before, await snapshotVault(f.root)), [])
  f.answer(0)
  assert.equal(
    await f.trashWorkspaceEntry(null, f.root, join(f.root, 'delete.md')),
    true,
  )
  assert.deepEqual(
    diffVault(before, await snapshotVault(f.root), { 'delete.md': null }),
    [],
  )
  assert.deepEqual(f.calls, [])
})
test('unknown trash option defaults to system trash', async (t) => {
  const f = await fixture(t, { trashOption: 'ambiguous' })
  const before = await snapshotVault(f.root)
  assert.equal(
    await f.trashWorkspaceEntry(null, f.root, join(f.root, 'delete.md')),
    true,
  )
  assert.deepEqual(f.calls, [join(f.root, 'delete.md')])
  assert.deepEqual(
    await readFile(join(f.folder, 'system-trash')),
    before.get('delete.md').bytes,
  )
  assert.deepEqual(
    diffVault(before, await snapshotVault(f.root), { 'delete.md': null }),
    [],
  )
})
test('local trash refuses symbolic link without touching its target', {
  skip: process.platform === 'win32',
}, async (t) => {
  const f = await fixture(t, { trashOption: 'local' })
  const outside = join(f.folder, 'outside')
  await mkdir(outside)
  await symlink(outside, join(f.root, '.trash'))
  const before = await snapshotVault(f.root)
  await assert.rejects(
    f.trashWorkspaceEntry(null, f.root, join(f.root, 'delete.md')),
  )
  assert.deepEqual(diffVault(before, await snapshotVault(f.root)), [])
  await assert.rejects(readFile(join(outside, 'delete.md')), { code: 'ENOENT' })
})
