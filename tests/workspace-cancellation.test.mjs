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
const { scanWorkspace, loadWorkspace, cancelWorkspaceLoad, indexWorkspace } =
  module.exports
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

test('superseding a workspace stops its index collection after the pending read', async (t) => {
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
  const original = fs.open
  let release
  let started
  const reading = new Promise((resolve) => {
    started = resolve
  })
  const held = new Promise((resolve) => {
    release = resolve
  })
  let reads = 0
  fs.open = async (path, ...args) => {
    if (String(path).startsWith(notes) && String(path).endsWith('.md')) {
      reads++
      started()
      await held
    }
    return original(path, ...args)
  }
  syncBuiltinESMExports()
  try {
    const pending = indexWorkspace()
    await reading
    await loadWorkspace(next)
    release()
    assert.equal(await pending, null)
    assert.equal(reads, 1)
  } finally {
    release()
    cancelWorkspaceLoad()
    fs.open = original
    syncBuiltinESMExports()
  }
})
