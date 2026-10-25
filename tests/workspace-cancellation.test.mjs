import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: ['src/main/workspace.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  plugins: [
    {
      name: 'workspace-host',
      setup(build) {
        build.onResolve({ filter: /^electron$/ }, () => ({
          path: 'electron',
          namespace: 'workspace-host',
        }))
        build.onLoad({ filter: /.*/, namespace: 'workspace-host' }, () => ({
          contents: `export const app = { getPath: () => globalThis.__workspaceProfile }
          export const dialog = {}
          export const shell = {}`,
          loader: 'js',
        }))
      },
    },
  ],
})
const module = { exports: {} }
new Function('module', 'exports', 'require', bundle.outputFiles[0].text)(
  module,
  module.exports,
  createRequire(import.meta.url),
)
const {
  scanWorkspace,
  loadWorkspace,
  cancelWorkspaceSelection,
  indexWorkspace,
  observeWorkspace,
  workspaceRoot,
} = module.exports
const fs = process.getBuiltinModule('node:fs/promises')

test('aborting traversal closes its directory iterator before reading later entries', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'hibi-scan-cancel-'))
  globalThis.__workspaceProfile = base
  t.after(() => rm(base, { recursive: true, force: true }))
  const original = fs.opendir
  const controller = new AbortController()
  let read = 0
  let closed = 0
  fs.opendir = async (path, ...args) =>
    path !== base
      ? original(path, ...args)
      : {
          async *[Symbol.asyncIterator]() {
            try {
              for (let i = 0; i < 1000; i++) {
                read++
                if (read === 5) controller.abort()
                yield {
                  name: `note-${i}.md`,
                  isDirectory: () => false,
                  isSymbolicLink: () => false,
                  isFile: () => true,
                }
              }
            } finally {
              closed++
            }
          },
        }
  syncBuiltinESMExports()
  try {
    await assert.rejects(scanWorkspace(base, false, controller.signal), {
      name: 'AbortError',
    })
    assert.equal(read, 5)
    assert.equal(closed, 1)
  } finally {
    fs.opendir = original
    syncBuiltinESMExports()
  }
})

for (const phase of ['realpath', 'stat']) {
  test(`superseding during ${phase} starts no markdown read`, async (t) => {
    const base = await realpath(
      await mkdtemp(join(tmpdir(), 'hibi-index-cancel-')),
    )
    globalThis.__workspaceProfile = base
    const notes = join(base, 'notes')
    const next = join(base, 'next')
    await mkdir(notes)
    await mkdir(next)
    await writeFile(join(notes, 'one.md'), '# one')
    await writeFile(join(notes, 'two.md'), '# two')
    t.after(() => rm(base, { recursive: true, force: true }))
    await loadWorkspace(notes)
    const original = fs[phase]
    const open = fs.open
    let release
    let started
    const reading = new Promise((resolve) => {
      started = resolve
    })
    const held = new Promise((resolve) => {
      release = resolve
    })
    let reads = 0
    fs[phase] = async (path, ...args) => {
      if (String(path).startsWith(notes) && String(path).endsWith('.md')) {
        started()
        await held
      }
      return original(path, ...args)
    }
    fs.open = (...args) => {
      if (String(args[0]).startsWith(notes) && String(args[0]).endsWith('.md'))
        reads++
      return open(...args)
    }
    syncBuiltinESMExports()
    try {
      const pending = indexWorkspace()
      await reading
      await loadWorkspace(next)
      release()
      assert.equal(await pending, null)
      assert.equal(reads, 0)
    } finally {
      release()
      fs[phase] = original
      fs.open = open
      syncBuiltinESMExports()
    }
  })
}

test('a committed selection still remembers and publishes when another open intent arrives', async (t) => {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'hibi-committed-open-')),
  )
  globalThis.__workspaceProfile = base
  const notes = join(base, 'notes')
  await mkdir(notes)
  t.after(() => rm(base, { recursive: true, force: true }))
  const original = fs.writeFile
  let release
  let started
  const writing = new Promise((resolve) => {
    started = resolve
  })
  const held = new Promise((resolve) => {
    release = resolve
  })
  const changes = []
  observeWorkspace((change) => changes.push(change))
  fs.writeFile = async (path, ...args) => {
    if (path === join(base, 'recent-workspaces.json.tmp')) {
      started()
      await held
    }
    return original(path, ...args)
  }
  syncBuiltinESMExports()
  try {
    const pending = loadWorkspace(notes, true)
    await writing
    cancelWorkspaceSelection()
    release()
    assert.equal((await pending).name, 'notes')
    assert.equal(workspaceRoot(), notes)
    assert.equal(changes.filter((change) => change.kind === 'tree').length, 1)
  } finally {
    release()
    observeWorkspace(() => {})
    fs.writeFile = original
    syncBuiltinESMExports()
  }
})
