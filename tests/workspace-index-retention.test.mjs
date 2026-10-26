import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: ['src/main/recent-workspaces.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  external: ['electron'],
})
async function fixture(t) {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-index-retention-'))
  t.after(() => rm(profile, { recursive: true, force: true }))
  const module = { exports: {} },
    native = createRequire(import.meta.url)
  new Function('module', 'exports', 'require', bundle.outputFiles[0].text)(
    module,
    module.exports,
    (name) =>
      name === 'electron' ? { app: { getPath: () => profile } } : native(name),
  )
  const root = join(profile, 'notes')
  const id = createHash('sha256').update(root).digest('hex')
  const directory = join(profile, 'workspace-index-cache', id)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'text-v1.sqlite'), 'derived index')
  return { profile, root, id, directory, ...module.exports }
}

test('startup prunes unknown cache ids but preserves known, foreign and linked directories', async (t) => {
  const f = await fixture(t)
  await writeFile(
    join(f.profile, 'recent-workspaces.json'),
    JSON.stringify([f.root]),
  )
  const unknown = join(f.profile, 'workspace-index-cache', 'a'.repeat(64))
  const foreign = join(f.profile, 'workspace-index-cache', 'other-application')
  const outside = join(f.profile, 'outside')
  await mkdir(unknown)
  await mkdir(foreign)
  await mkdir(outside)
  await writeFile(join(outside, 'marker'), 'untouched')
  if (process.platform !== 'win32')
    await symlink(
      outside,
      join(f.profile, 'workspace-index-cache', 'c'.repeat(64)),
    )
  await f.getKnownWorkspaces()
  await access(f.directory)
  await access(foreign)
  assert.equal(await readFile(join(outside, 'marker'), 'utf8'), 'untouched')
  await assert.rejects(access(unknown), { code: 'ENOENT' })
  await f.setKnownWorkspace(f.id, 'hide')
  await access(f.directory)
})

test('forget waits for cache users before deleting derived files', async (t) => {
  const f = await fixture(t)
  await f.rememberWorkspace(f.root)
  let release, observed
  const blocked = new Promise((resolve) => {
    release = resolve
  })
  const reached = new Promise((resolve) => {
    observed = resolve
  })
  f.observeKnownWorkspaces(async (known) => {
    if (!known.some((item) => item.id === f.id)) {
      observed()
      await blocked
    }
  })
  let finished = false
  const forgetting = f.forgetWorkspace(f.root).then(() => {
    finished = true
  })
  await reached
  try {
    await access(f.directory)
    assert.equal(finished, false)
  } finally {
    release()
  }
  await forgetting
  await f.workspaceIndexCacheReady()
  await assert.rejects(access(f.directory), { code: 'ENOENT' })
})

test('an unreadable workspace list does not authorize cache pruning', async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.profile, 'recent-workspaces.json'), '{broken')
  assert.deepEqual(await f.getKnownWorkspaces(), [])
  await access(f.directory)
})
