import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import test from 'node:test'
import { build } from 'esbuild'
import ignore from 'ignore'

const bundled = await build({
  entryPoints: ['src/main/workspace-scan.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const source = `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
const child = (name, kind = 'file') => ({
  name,
  isDirectory: () => kind === 'folder',
  isFile: () => kind === 'file',
  isSymbolicLink: () => kind === 'symlink',
})

function fixture(t, files) {
  let read = 0
  let closed = 0
  t.mock.method(fs, 'opendir', async (directory) => ({
    async *[Symbol.asyncIterator]() {
      try {
        for (const entry of files(directory)) {
          read++
          yield entry
        }
      } finally {
        closed++
      }
    },
  }))
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  return { read: () => read, closed: () => closed }
}

test('uncapped scan yields real turns even for ignored or unsupported entries', async (t) => {
  const total = 100001
  const state = fixture(t, function* () {
    for (let i = 0; i < total; i++) yield child(`file-${i}.unsupported`)
  })
  let now = 0
  t.mock.method(performance, 'now', () => (now += 0.01))
  let turns = 0
  let active = true
  const countTurn = () => {
    if (active) {
      turns++
      setImmediate(countTurn)
    }
  }
  setImmediate(countTurn)
  const { scanWorkspaceTree } = await import(`${source}#uncapped`)
  try {
    const entries = await scanWorkspaceTree(
      '/workspace',
      false,
      ignore(),
      (name) => name.endsWith('.md'),
    )
    assert.deepEqual(entries, [])
    assert.equal(state.read(), total)
    assert.equal(state.closed(), 1)
    assert.ok(turns > 100, `${turns} real event-loop turns`)
  } finally {
    active = false
  }
})

test('scan preserves folder/numeric/unicode order, ignore rules and symlink exclusions', async (t) => {
  fixture(t, (directory) =>
    directory === '/workspace'
      ? [
          child('note10.md'),
          child('note2.md'),
          child('é.md'),
          child('e.md'),
          child('folder', 'folder'),
          child('.hidden', 'folder'),
          child('node_modules', 'folder'),
          child('linked.md', 'symlink'),
          child('ignored.md'),
          child('.env'),
          child('config.json'),
        ]
      : [child('nested.md')],
  )
  const { scanWorkspaceTree } = await import(`${source}#order`)
  const entries = await scanWorkspaceTree(
    '/workspace',
    true,
    ignore().add('ignored.md'),
    () => true,
  )
  const expected = [
    '.env',
    'config.json',
    'e.md',
    'é.md',
    'note2.md',
    'note10.md',
  ].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  assert.deepEqual(
    entries.map((item) => item.name),
    ['folder', ...expected],
  )
  assert.deepEqual(
    entries[0].children.map((item) => item.path),
    ['folder/nested.md'],
  )
})

test('cancellation interrupts sibling sorting after the directory has closed', async (t) => {
  const total = 4096
  const state = fixture(t, function* () {
    for (let i = total; i > 0; i--) yield child(`note-${i}.md`)
  })
  let now = 0
  t.mock.method(performance, 'now', () => (now += 0.02))
  const Collator = Intl.Collator
  let comparisons = 0
  t.mock.method(Intl, 'Collator', function MockCollator(...args) {
    const collator = new Collator(...args)
    return {
      compare: (a, b) => {
        comparisons++
        return collator.compare(a, b)
      },
    }
  })
  const { scanWorkspaceTree } = await import(`${source}#abort-sort`)
  const controller = new AbortController()
  let active = true
  const interrupt = () => {
    if (!active) return
    if (comparisons) controller.abort()
    else setImmediate(interrupt)
  }
  setImmediate(interrupt)
  try {
    await assert.rejects(
      scanWorkspaceTree(
        '/workspace',
        false,
        ignore(),
        () => true,
        controller.signal,
      ),
      { name: 'AbortError' },
    )
    assert.equal(state.closed(), 1)
    assert.ok(comparisons > 0)
    assert.ok(comparisons < total * Math.log2(total))
  } finally {
    active = false
  }
})

test('aborting traversal closes its iterator and stops before later entries', async (t) => {
  const controller = new AbortController()
  const state = fixture(t, function* () {
    for (let i = 0; i < 1000; i++) {
      if (i === 5) controller.abort()
      yield child(`${i}.md`)
    }
  })
  const { scanWorkspaceTree } = await import(`${source}#abort-walk`)
  await assert.rejects(
    scanWorkspaceTree(
      '/workspace',
      false,
      ignore(),
      () => true,
      controller.signal,
    ),
    { name: 'AbortError' },
  )
  assert.equal(state.read(), 6)
  assert.equal(state.closed(), 1)
})

test('unchanged tree comparison yields real turns and retains the original immutable tree', async (t) => {
  const count = 4096
  const children = Array.from({ length: count }, (_, i) =>
    child(`note-${i + 1}.md`),
  )
  fixture(t, () => children)
  let now = 0
  t.mock.method(performance, 'now', () => (now += 0.02))
  let comparisons = 0
  const previous = children.map((entry) => ({
    name: entry.name,
    kind: 'file',
    get path() {
      comparisons++
      return entry.name
    },
  }))
  let active = true
  let turns = 0
  const turn = () => {
    if (active) {
      if (comparisons) turns++
      setImmediate(turn)
    }
  }
  setImmediate(turn)
  const { scanWorkspaceTree } = await import(`${source}#same-tree`)
  try {
    const result = await scanWorkspaceTree(
      '/workspace',
      false,
      ignore(),
      () => true,
      undefined,
      previous,
    )
    assert.equal(result, previous)
    assert.equal(comparisons, count)
    assert.ok(turns > 10, `${turns} comparison turns`)
    children.push(child('added.md'))
    assert.notEqual(
      await scanWorkspaceTree(
        '/workspace',
        false,
        ignore(),
        () => true,
        undefined,
        previous,
      ),
      previous,
    )
  } finally {
    active = false
  }
})
