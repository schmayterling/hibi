import assert from 'node:assert/strict'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import {
  listedTableLayout,
  storedTableLayout,
} from '../src/shared/table-layout.ts'

const bundle = await build({
  entryPoints: ['src/main/workspace-layout.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  write: false,
})
const require = createRequire(import.meta.url)
/** A fresh module, optionally with node:fs/promises functions replaced. */
function load(fs) {
  const module = { exports: {} }
  new Function('module', 'exports', 'require', bundle.outputFiles[0].text)(
    module,
    module.exports,
    (id) =>
      fs && id === 'node:fs/promises' ? { ...require(id), ...fs } : require(id),
  )
  return module.exports
}
const { readTableLayout, renameWithTableLayout, writeTableLayout } = load()
const move = (root, from, to) =>
  renameWithTableLayout(
    () => rename(join(root, from), join(root, to)),
    () => [root, from, to],
  )

const table = (key, columns = [120, 0], rows = null) => ({
  key,
  columns,
  rows,
})

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'hibi-layout-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'notes'))
  await writeFile(join(root, 'a.md'), '')
  await writeFile(join(root, 'notes/b.md'), '')
  return root
}

const stored = async (root) =>
  JSON.parse(await readFile(join(root, '.hibi/layout.json'), 'utf8'))

test('table layout updates change only their tables, on what is stored when they arrive', async (t) => {
  const root = await workspace(t)
  await writeTableLayout(root, 'a.md', [table('0:a'), table('1:b')])
  // Two windows update different tables from the same stale copy, at once.
  await Promise.all([
    writeTableLayout(root, 'a.md', {
      remove: ['0:a'],
      put: [table('0:a', [200, 0])],
    }),
    writeTableLayout(root, 'a.md', { remove: ['2:c'], put: [table('2:c')] }),
  ])
  assert.deepEqual(await readTableLayout(root, 'a.md'), [
    table('1:b'),
    table('0:a', [200, 0]),
    table('2:c'),
  ])
  // Removing a key drops its table; an update without sizes stores nothing.
  await writeTableLayout(root, 'a.md', {
    remove: ['1:b'],
    put: [table('3:d', [0, 0])],
  })
  assert.deepEqual(
    (await readTableLayout(root, 'a.md')).map((entry) => entry.key),
    ['0:a', '2:c'],
  )
  for (const bad of [
    { remove: 'x', put: [] },
    { remove: [1], put: [] },
    { remove: [], put: [{ key: 'x', columns: [-1], rows: null }] },
    null,
  ])
    await assert.rejects(writeTableLayout(root, 'a.md', bad), {
      message: 'The table layout is invalid.',
    })
})

test('long tables store rows past the first 1,000 by index, within bounds', async (t) => {
  const root = await workspace(t)
  // A table sized at row 1,500 of a long table, as the editors keep it.
  const rows = Array(1501).fill(0)
  rows[1] = 40
  rows[1500] = 90
  const stored = storedTableLayout({ key: '0:long', columns: null, rows })
  assert.deepEqual(stored.rows, [0, 40])
  assert.deepEqual(stored.rowsAfter, [[1500, 90]])
  await writeTableLayout(root, 'a.md', [stored])
  const [read] = await readTableLayout(root, 'a.md')
  assert.deepEqual(listedTableLayout(read).rows, rows)
  // Only sized rows past the listed ones are stored.
  assert.deepEqual(
    storedTableLayout({
      key: 'x',
      columns: null,
      rows: [...Array(5000).fill(0)],
    }),
    { key: 'x', columns: null, rows: null },
  )
  for (const rowsAfter of [
    [[999, 10]],
    [
      [1001, 10],
      [1000, 10],
    ],
    [[1000, 10001]],
    Array.from({ length: 1001 }, (_, i) => [1000 + i, 10]),
  ])
    await assert.rejects(
      writeTableLayout(root, 'a.md', [
        { key: 'x', columns: null, rows: null, rowsAfter },
      ]),
      { message: 'The table layout is invalid.' },
    )
})

test('table size updates from two windows change only their own sizes', async (t) => {
  const root = await workspace(t)
  await writeTableLayout(root, 'a.md', [table('0:a', [100, 0], [0, 40])])
  const set = (axis, index, size) =>
    writeTableLayout(root, 'a.md', {
      remove: [],
      put: [],
      set: [{ key: '0:a', axis, index, size }],
    })
  // One window widens a column while another heightens a row of the same table.
  await Promise.all([set('column', 0, 180), set('row', 1, 60)])
  assert.deepEqual(await readTableLayout(root, 'a.md'), [
    { key: '0:a', columns: [180], rows: [0, 60] },
  ])
  // Rows past the first 1,000 stay stored by index.
  await set('row', 1500, 90)
  assert.deepEqual(await readTableLayout(root, 'a.md'), [
    { key: '0:a', columns: [180], rows: [0, 60], rowsAfter: [[1500, 90]] },
  ])
  for (const change of [
    { key: '0:a', axis: 'column', index: 1000, size: 1 },
    { key: '0:a', axis: 'diagonal', index: 0, size: 1 },
    { key: '0:a', axis: 'row', index: 0, size: 10001 },
  ])
    await assert.rejects(
      writeTableLayout(root, 'a.md', { remove: [], put: [], set: [change] }),
      { message: 'The table layout is invalid.' },
    )
})

test('table layout is created lazily, read back, and pruned', async (t) => {
  const root = await workspace(t)
  await writeTableLayout(root, 'a.md', [])
  await assert.rejects(stat(join(root, '.hibi')), { code: 'ENOENT' })
  assert.deepEqual(await readTableLayout(root, 'a.md'), [])

  await writeTableLayout(root, 'a.md', [
    table('0:abc'),
    table('1:def', null, [0, 48]),
    table('2:auto', [0, 0], [0]),
  ])
  await writeTableLayout(root, 'notes/b.md', [table('0:b')])
  assert.deepEqual(await readTableLayout(root, 'a.md'), [
    table('0:abc'),
    table('1:def', null, [0, 48]),
  ])
  assert.deepEqual(Object.keys((await stored(root)).documents), [
    'a.md',
    'notes/b.md',
  ])

  await rm(join(root, 'notes/b.md'))
  await writeTableLayout(root, 'a.md', [table('0:abc', [90])])
  assert.deepEqual(await stored(root), {
    version: 1,
    documents: { 'a.md': { tables: [table('0:abc', [90])] } },
  })
  await writeTableLayout(root, 'a.md', [])
  assert.deepEqual(await stored(root), { version: 1, documents: {} })
})

test('table layout follows renames and moves inside the workspace', async (t) => {
  const root = await workspace(t)
  await writeTableLayout(root, 'a.md', [table('0:a')])
  await writeTableLayout(root, 'notes/b.md', [table('0:b')])
  await mkdir(join(root, 'archive'))
  await move(root, 'a.md', 'renamed.md')
  await move(root, 'notes', 'archive/notes')
  assert.deepEqual(Object.keys((await stored(root)).documents).sort(), [
    'archive/notes/b.md',
    'renamed.md',
  ])
  assert.deepEqual(await readTableLayout(root, 'renamed.md'), [table('0:a')])
})

test('table layout validates sizes and paths', async (t) => {
  const root = await workspace(t)
  for (const input of [
    null,
    [{ key: 1, columns: null, rows: null }],
    [table('0:a', [-1])],
    [table('0:a', [1.5])],
    [table('0:a', [10001])],
    [table('x'.repeat(65))],
  ])
    await assert.rejects(writeTableLayout(root, 'a.md', input), /invalid/)
  for (const path of ['', '../a.md', '/a.md', 'notes/../a.md', 'a\\b.md'])
    await assert.rejects(writeTableLayout(root, path, []), /workspace/)
  await assert.rejects(stat(join(root, '.hibi')), { code: 'ENOENT' })
})

test('table layout ignores damaged entries and refuses newer files', async (t) => {
  const root = await workspace(t)
  await mkdir(join(root, '.hibi'))
  await writeFile(
    join(root, '.hibi/layout.json'),
    JSON.stringify({
      version: 1,
      documents: {
        'a.md': { tables: [table('0:a')] },
        'notes/b.md': { tables: 'broken' },
        '../outside.md': { tables: [table('0:x')] },
      },
    }),
  )
  assert.deepEqual(await readTableLayout(root, 'a.md'), [table('0:a')])
  assert.deepEqual(await readTableLayout(root, 'notes/b.md'), [])
  await writeFile(join(root, '.hibi/layout.json'), '{')
  assert.deepEqual(await readTableLayout(root, 'a.md'), [])
  await writeFile(
    join(root, '.hibi/layout.json'),
    JSON.stringify({ version: 2, documents: {} }),
  )
  await assert.rejects(readTableLayout(root, 'a.md'), /newer version/)
  await assert.rejects(writeTableLayout(root, 'a.md', []), /newer version/)
})

test('table layout refuses a symbolic .hibi folder or layout file', async (t) => {
  const root = await workspace(t)
  const outside = await mkdtemp(join(tmpdir(), 'hibi-layout-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await symlink(outside, join(root, '.hibi'), 'dir')
  await assert.rejects(readTableLayout(root, 'a.md'), /symbolic link/)
  await assert.rejects(
    writeTableLayout(root, 'a.md', [table('0:a')]),
    /symbolic link/,
  )
  await assert.rejects(stat(join(outside, 'layout.json')), { code: 'ENOENT' })

  await rm(join(root, '.hibi'))
  await mkdir(join(root, '.hibi'))
  await writeFile(join(outside, 'layout.json'), '{"version":1,"documents":{}}')
  await symlink(join(outside, 'layout.json'), join(root, '.hibi/layout.json'))
  await assert.rejects(readTableLayout(root, 'a.md'), /Cannot read/)
})

test('concurrent table layout writes keep every document', async (t) => {
  const root = await workspace(t)
  await Promise.all([
    writeTableLayout(root, 'a.md', [table('0:a')]),
    writeTableLayout(root, 'notes/b.md', [table('0:b')]),
  ])
  assert.deepEqual(Object.keys((await stored(root)).documents).sort(), [
    'a.md',
    'notes/b.md',
  ])
})

test('table layout stores a document named __proto__', async (t) => {
  const root = await workspace(t)
  await writeFile(join(root, '__proto__'), '')
  await writeTableLayout(root, '__proto__', [table('0:p')])
  assert.deepEqual(await readTableLayout(root, '__proto__'), [table('0:p')])
  assert.deepEqual(await readTableLayout(root, 'a.md'), [])
  assert.deepEqual(Object.keys((await stored(root)).documents), ['__proto__'])
})

test('table layout stays under its read limit by dropping old documents', async (t) => {
  const root = await workspace(t)
  const names = Array.from({ length: 70 }, (_, index) => `${index}.md`)
  for (const name of names) await writeFile(join(root, name), '')
  const tall = (key) => [table(key, [120], Array(1000).fill(48))]
  for (const name of names) await writeTableLayout(root, name, tall(name))
  const { size } = await stat(join(root, '.hibi/layout.json'))
  assert.ok(size <= 1048576)
  const kept = Object.keys((await stored(root)).documents)
  assert.ok(kept.length < names.length)
  assert.deepEqual(kept, names.slice(-kept.length))
  assert.deepEqual(await readTableLayout(root, '69.md'), tall('69.md'))
  assert.deepEqual(await readTableLayout(root, '0.md'), [])

  const huge = Array.from({ length: 100 }, (_, index) =>
    table(`${index}:a`, [120], Array(1000).fill(48)),
  )
  await assert.rejects(writeTableLayout(root, 'a.md', huge), /too large/)
  assert.deepEqual(Object.keys((await stored(root)).documents), kept)
})

test('table layout eviction serializes the whole file a bounded number of times', async (t) => {
  const root = await workspace(t)
  await mkdir(join(root, '.hibi'))
  const documents = {}
  for (let index = 0; index < 4800; index++)
    documents[`notes/${index}.md`] = { tables: [table(`0:${index}`, [120])] }
  await writeFile(
    join(root, '.hibi/layout.json'),
    JSON.stringify({ version: 1, documents }, null, 2),
  )
  // Every stored document exists without creating thousands of files.
  const metadata = join(root, '.hibi')
  const fast = load({
    lstat: (path, ...rest) =>
      path.startsWith(metadata) ? lstat(path, ...rest) : Promise.resolve({}),
  })
  const tables = Array.from({ length: 45 }, (_, index) =>
    table(`${index}:a`, [120], Array(1000).fill(48)),
  )
  const stringify = JSON.stringify
  let whole = 0
  t.mock.method(JSON, 'stringify', (value, ...rest) => {
    if (value?.documents) whole++
    return stringify(value, ...rest)
  })
  const started = performance.now()
  await fast.writeTableLayout(root, 'a.md', tables)
  const elapsed = performance.now() - started
  t.mock.restoreAll()
  assert.ok(whole <= 2, `${whole} whole-file serializations`)
  assert.ok(elapsed < 2000, `${Math.round(elapsed)} ms`)
  const { size } = await stat(join(root, '.hibi/layout.json'))
  assert.ok(size <= 1048576)
  const kept = Object.keys((await stored(root)).documents)
  assert.equal(kept.at(-1), 'a.md')
  assert.ok(kept.length > 1)
  // Evicting one fewer document would not have fit.
  const evicted = 4800 - (kept.length - 1)
  const fuller = {
    version: 1,
    documents: Object.fromEntries([
      ...Object.entries(documents).slice(evicted - 1),
      ['a.md', { tables }],
    ]),
  }
  assert.ok(Buffer.byteLength(`${JSON.stringify(fuller, null, 2)}\n`) > 1048576)
  assert.deepEqual(await fast.readTableLayout(root, 'a.md'), tables)
})

test('table layout recovers from an oversized file', async (t) => {
  const root = await workspace(t)
  await mkdir(join(root, '.hibi'))
  await writeFile(join(root, '.hibi/layout.json'), ' '.repeat(1048577))
  t.mock.method(console, 'warn', () => {})
  assert.deepEqual(await readTableLayout(root, 'a.md'), [])
  await writeTableLayout(root, 'a.md', [table('0:a')])
  assert.deepEqual(await stored(root), {
    version: 1,
    documents: { 'a.md': { tables: [table('0:a')] } },
  })
  // Reported once, then again only after the file changes.
  assert.equal(console.warn.mock.callCount(), 1)
  await writeFile(join(root, '.hibi/layout.json'), ' '.repeat(1048578))
  assert.deepEqual(await readTableLayout(root, 'a.md'), [])
  assert.deepEqual(await readTableLayout(root, 'a.md'), [])
  assert.equal(console.warn.mock.callCount(), 2)
})

test('pruning waits for a rename to move its sizes', async (t) => {
  const root = await workspace(t)
  await writeTableLayout(root, 'a.md', [table('0:a')])
  await writeTableLayout(root, 'notes/b.md', [table('0:b')])
  let reached
  let release
  const pruning = new Promise((resolve) => {
    reached = resolve
  })
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const racing = load({
    lstat: async (path, ...rest) => {
      if (path === join(root, 'a.md')) {
        reached()
        await gate
      }
      return lstat(path, ...rest)
    },
  })
  const writing = racing.writeTableLayout(root, 'notes/b.md', [
    table('0:b', [200]),
  ])
  await pruning
  let started = false
  const renaming = racing.renameWithTableLayout(
    () => {
      started = true
      return rename(join(root, 'a.md'), join(root, 'renamed.md'))
    },
    () => [root, 'a.md', 'renamed.md'],
  )
  await new Promise(setImmediate)
  assert.equal(started, false)
  release()
  await Promise.all([writing, renaming])
  assert.deepEqual(await readTableLayout(root, 'renamed.md'), [table('0:a')])
  assert.deepEqual(await readTableLayout(root, 'notes/b.md'), [
    table('0:b', [200]),
  ])
})
