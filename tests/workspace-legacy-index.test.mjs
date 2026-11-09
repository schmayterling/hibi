import assert from 'node:assert/strict'
import test from 'node:test'
import {
  checkLegacyIndexBytes,
  LegacyWorkspaceIndex,
  MAX_LEGACY_INDEX_BYTES,
} from '../src/main/workspace-legacy-index.ts'

const file = (path) => ({ path, name: path.split('/').at(-1), kind: 'file' })
const folder = (path, children = []) => ({
  path,
  name: path.split('/').at(-1),
  kind: 'folder',
  children,
})

function fixture(count = 1) {
  const disk = new Map(
    Array.from({ length: count }, (_, i) => [
      `${i}.md`,
      { version: 'disk:1', text: `note ${i}` },
    ]),
  )
  const counters = { stats: 0, reads: 0 }
  const options = {
    key: 'workspace:1',
    workspace: {
      id: 'workspace',
      name: 'notes',
      entries: [],
      activePath: null,
    },
    entries: [...disk.keys()].map(file),
    documents: [],
    drafts: new Map(),
    isDocument: (name) => name.endsWith('.md'),
    current: () => true,
    resolve: async (path) => {
      counters.stats++
      const source = disk.get(path)
      if (!source) throw Object.assign(new Error('Gone'), { code: 'ENOENT' })
      return {
        id: `id:${path}`,
        version: source.version,
        minimumBytes: Buffer.byteLength(source.text),
        read: () => {
          counters.reads++
          return source.text
        },
      }
    },
  }
  return { disk, counters, options, index: new LegacyWorkspaceIndex() }
}

const bytes = (value) => Buffer.byteLength(JSON.stringify(value))

test('303 notes read 303/0/0 times; verification stats all and rereads only changed text', async () => {
  const { index, options, counters, disk } = fixture(303)
  const first = await index.read(options)
  assert.equal(first.pages.length, 303)
  assert.deepEqual(counters, { stats: 303, reads: 303 })
  for (const activePath of ['0.md', '1.md']) {
    counters.reads = 0
    counters.stats = 0
    options.workspace = { ...options.workspace, activePath, name: activePath }
    const warm = await index.read(options)
    assert.strictEqual(warm.pages, first.pages)
    assert.strictEqual(warm.workspace.entries, first.workspace.entries)
    assert.equal(warm.workspace.activePath, activePath)
    assert.equal(warm.workspace.name, activePath)
    assert.deepEqual(counters, { stats: 0, reads: 0 })
  }
  options.key = 'workspace:verify'
  const verified = await index.read(options)
  assert.deepEqual(counters, { stats: 303, reads: 0 })
  assert.strictEqual(verified.pages[0], first.pages[0])
  disk.set('1.md', { version: 'disk:2', text: 'changed' })
  counters.stats = 0
  options.key = 'workspace:changed'
  const changed = await index.read(options)
  assert.deepEqual(counters, { stats: 303, reads: 1 })
  assert.equal(changed.pages[1].markdown, 'changed')
  assert.strictEqual(changed.pages[0], first.pages[0])
})

test('document count has no cap', async () => {
  const { index, options, counters } = fixture(2103)
  const result = await index.read(options)
  assert.equal(result.pages.length, 2103)
  assert.equal(counters.reads, 2103)
})

test('full legacy order, dirty flags, pending replacement and insertion; gone ordinary drafts stay gone', async () => {
  const { index, options, disk, counters } = fixture(0)
  options.entries = [
    folder('z', [file('z/b.md'), file('z/a.md'), file('z/new.md')]),
    folder('empty'),
    file('root.md'),
    file('image.png'),
  ]
  for (const path of ['z/a.md', 'z/b.md', 'root.md'])
    disk.set(path, { version: 'disk:1', text: path })
  let draftReads = 0
  for (const path of [
    'z/a.md',
    'z/new.md',
    'new.md',
    'gone.md',
    'absent/new.md',
  ]) {
    options.documents.push({
      path,
      dirty: true,
      pending: path !== 'gone.md' && path !== 'z/a.md',
    })
    options.drafts.set(path, {
      id: path,
      version: 'draft:1',
      read: () => {
        draftReads++
        return `draft:${path}`
      },
    })
  }
  const original = structuredClone(options.entries)
  const result = await index.read(options)
  assert.deepEqual(options.entries, original)
  assert.deepEqual(
    result.workspace.entries.map((entry) => entry.path),
    ['z', 'empty', 'root.md', 'image.png', 'new.md'],
  )
  assert.deepEqual(
    result.workspace.entries[0].children.map((entry) => [
      entry.path,
      entry.dirty,
    ]),
    [
      ['z/b.md', false],
      ['z/a.md', true],
      ['z/new.md', true],
    ],
  )
  assert.deepEqual(result.workspace.entries[1].children, [])
  assert.deepEqual(
    result.pages.map((page) => page.path),
    ['z/b.md', 'z/a.md', 'z/new.md', 'root.md', 'new.md'],
  )
  assert.equal(result.pages[1].markdown, 'draft:z/a.md')
  assert.equal(draftReads, 3)
  assert.deepEqual(counters, { stats: 2, reads: 2 })
  options.key = 'workspace:dirty2'
  options.drafts.set('z/a.md', {
    id: 'z/a.md',
    version: 'draft:2',
    read: () => {
      draftReads++
      return 'edit'
    },
  })
  const changed = await index.read(options)
  assert.equal(changed.pages[1].markdown, 'edit')
  assert.equal(draftReads, 4)
  assert.deepEqual(counters, { stats: 4, reads: 2 })
})

test('20 MiB includes complete header/tree/pages and refreshed warm header', async () => {
  const { index, options, disk, counters } = fixture()
  disk.set('0.md', { version: 'empty', text: '' })
  const empty = await index.read(options)
  const overhead = bytes(empty)
  disk.set('0.md', {
    version: 'full',
    text: 'a'.repeat(MAX_LEGACY_INDEX_BYTES - overhead),
  })
  options.key = 'full'
  const full = await index.read(options)
  assert.equal(bytes(full), MAX_LEGACY_INDEX_BYTES)
  assert.strictEqual((await index.read(options)).pages, full.pages)
  const before = counters.reads
  options.workspace.name += 'a'
  await assert.rejects(
    index.read(options),
    /legacy workspace index exceeds the 20 MiB message limit.*paged workspace queries/,
  )
  assert.equal(counters.reads, before)
  options.workspace.name = 'notes'
  await index.read(options)
  assert.equal(
    counters.reads,
    before + 1,
    'oversize clears the retained result and per-file cache',
  )
})

test('JSON escaping and Unicode boundaries count exactly', async () => {
  const { index, options, disk } = fixture()
  options.workspace.name = 'quotes"\\\n雪'
  const prefix = `${'a'.repeat(16383)}😀\ud800\n\u0000"\\雪`
  disk.set('0.md', { version: 'prefix', text: prefix })
  const small = await index.read(options)
  const padding = MAX_LEGACY_INDEX_BYTES - bytes(small)
  disk.set('0.md', { version: 'exact', text: prefix + 'a'.repeat(padding) })
  options.key = 'exact'
  assert.equal(bytes(await index.read(options)), MAX_LEGACY_INDEX_BYTES)
  options.key = 'too-large'
  disk.set('0.md', {
    version: 'escaped',
    text: '\u0000'.repeat(Math.ceil(MAX_LEGACY_INDEX_BYTES / 6)),
  })
  await assert.rejects(index.read(options), /20 MiB message limit/)
})

test('oversized reply stops before reading the rest and retains no partial new key', async () => {
  const { index, options, disk, counters } = fixture(30)
  for (const source of disk.values()) source.text = 'x'.repeat(1024 * 1024)
  await assert.rejects(index.read(options), /20 MiB message limit/)
  assert.equal(counters.reads, 0)
  assert.equal(
    counters.stats,
    40,
    'one scan and one metadata-only confirmation',
  )
  disk.get('0.md').text = 'small'
  options.entries = [file('0.md')]
  const result = await index.read(options)
  assert.equal(result.pages[0].markdown, 'small')
  assert.equal(counters.reads, 1)
})

test('preflight includes page envelopes before reading any text and clears the old cache', async () => {
  const { index, options, disk, counters } = fixture(2)
  const small = await index.read(options)
  const overhead =
    bytes(small) -
    small.pages.reduce((n, page) => n + Buffer.byteLength(page.markdown), 0)
  disk.set('0.md', {
    version: 'large',
    text: 'x'.repeat(MAX_LEGACY_INDEX_BYTES - overhead + 1),
  })
  disk.set('1.md', { version: 'empty', text: '' })
  options.key = 'large'
  counters.reads = 0
  counters.stats = 0
  await assert.rejects(index.read(options), /20 MiB message limit/)
  assert.deepEqual(counters, { stats: 4, reads: 0 })
  assert.equal(index.cached, undefined)
  options.key = 'small-again'
  disk.set('0.md', { version: 'small-again', text: 'small' })
  const result = await index.read(options)
  assert.deepEqual(
    result.pages.map((page) => page.markdown),
    ['small', ''],
  )
  assert.equal(counters.reads, 2)
})

test('draft lower bounds refuse before materialization and replace disk sizes', async () => {
  const { index, options, counters } = fixture(2)
  const large = 'x'.repeat(11 * 1024 * 1024)
  let materialized = 0
  for (const path of ['0.md', '1.md'])
    options.drafts.set(path, {
      id: path,
      version: 'draft:1',
      minimumBytes: large.length,
      read: () => {
        materialized++
        return large
      },
    })
  await assert.rejects(index.read(options), /20 MiB message limit/)
  assert.equal(materialized, 0)
  assert.deepEqual(counters, { stats: 0, reads: 0 })
  options.key = 'small-drafts'
  for (const path of ['0.md', '1.md'])
    options.drafts.set(path, {
      id: path,
      version: 'draft:2',
      minimumBytes: 1,
      read: () => {
        materialized++
        return '雪'
      },
    })
  const result = await index.read(options)
  assert.deepEqual(
    result.pages.map((page) => page.markdown),
    ['雪', '雪'],
  )
  assert.equal(materialized, 2)
  assert.deepEqual(counters, { stats: 0, reads: 0 })
})

test('cancellation at the last stat still starts zero text reads', async () => {
  const { index, options, counters } = fixture(3)
  options.current = () => counters.stats < 3
  assert.equal(await index.read(options), null)
  assert.deepEqual(counters, { stats: 3, reads: 0 })
})

test('a file removed after preflight is skipped while its tree row remains', async () => {
  const { index, options, counters } = fixture(3)
  const resolve = options.resolve
  options.resolve = async (path) => {
    const source = await resolve(path)
    return {
      ...source,
      read: () => {
        if (path === '1.md')
          throw Object.assign(new Error('Gone'), { code: 'ENOENT' })
        return source.read()
      },
    }
  }
  const result = await index.read(options)
  assert.deepEqual(
    result.pages.map((page) => page.path),
    ['0.md', '2.md'],
  )
  assert.equal(result.workspace.entries.length, 3)
  assert.deepEqual(counters, { stats: 3, reads: 2 })
})

for (const change of ['shrink', 'delete']) {
  test(`preflight confirms sizes when an earlier file changes after stat: ${change}`, async () => {
    const { index, options, disk, counters } = fixture(2)
    const large = 'x'.repeat(12 * 1024 * 1024)
    for (const source of disk.values()) source.text = large
    const resolve = options.resolve
    let changed = false
    options.resolve = async (path) => {
      const source = await resolve(path)
      if (path === '0.md' && !changed) {
        changed = true
        if (change === 'shrink') {
          disk.get(path).text = ''
          disk.get(path).version = 'disk:2'
        } else disk.delete(path)
      }
      return {
        ...source,
        read: (budget) => {
          if (!disk.has(path))
            throw Object.assign(new Error('Gone'), { code: 'ENOENT' })
          return source.read(budget)
        },
      }
    }
    const result = await index.read(options)
    assert.deepEqual(
      result.pages.map((page) => page.path),
      change === 'shrink' ? ['0.md', '1.md'] : ['1.md'],
    )
    assert.deepEqual(
      result.pages.map((page) => page.markdown.length),
      change === 'shrink' ? [0, large.length] : [large.length],
    )
    assert.equal(counters.stats, 4)
    assert.equal(counters.reads, change === 'shrink' ? 2 : 1)
    assert.ok(bytes(result) < MAX_LEGACY_INDEX_BYTES)
  })
}

test('clear between a preflight refusal and confirmation cancels without more stats or reads', async () => {
  const { index, options, disk, counters } = fixture(2)
  for (const source of disk.values()) source.text = 'x'.repeat(12 * 1024 * 1024)
  let clearing = false
  options.current = () => {
    if (counters.stats === 2 && !clearing) {
      clearing = true
      queueMicrotask(() => index.clear())
    }
    return true
  }
  assert.equal(await index.read(options), null)
  assert.deepEqual(counters, { stats: 2, reads: 0 })
})

test('remaining reply budget rejects oversized source before materialization', async () => {
  const { index, options } = fixture(2)
  const budgets = []
  let materialized = 0
  const resolve = options.resolve
  options.resolve = async (path) => {
    const source = await resolve(path)
    return {
      ...source,
      read: (maximumBytes) => {
        assert.ok(Number.isSafeInteger(maximumBytes))
        assert.ok(maximumBytes > 0 && maximumBytes < MAX_LEGACY_INDEX_BYTES)
        budgets.push(maximumBytes)
        checkLegacyIndexBytes(11 * 1024 * 1024, maximumBytes)
        materialized++
        return 'x'.repeat(11 * 1024 * 1024)
      },
    }
  }
  await assert.rejects(index.read(options), /20 MiB message limit/)
  assert.equal(materialized, 1)
  assert.equal(budgets.length, 2)
  assert.ok(budgets[1] < budgets[0] - 11 * 1024 * 1024)
  assert.equal(index.cached, undefined)
})

test('stale after resolve/stat starts zero Markdown reads', async () => {
  const { index, options, counters } = fixture()
  let active = true
  const resolve = options.resolve
  options.current = () => active
  options.resolve = async (path) => {
    const source = await resolve(path)
    active = false
    return source
  }
  assert.equal(await index.read(options), null)
  assert.deepEqual(counters, { stats: 1, reads: 0 })
})

test('clear cancels in-flight reads and drops both warm and per-file caches', async () => {
  const { index, options, counters } = fixture()
  const resolve = options.resolve
  options.resolve = async (path) => {
    const source = await resolve(path)
    index.clear()
    return source
  }
  assert.equal(await index.read(options), null)
  assert.equal(counters.reads, 0)
  options.resolve = resolve
  await index.read(options)
  index.clear()
  await index.read(options)
  assert.equal(counters.reads, 2)
})

test('stale after reading never publishes, and concurrent ENOENT preserves watcher behavior', async () => {
  const { index, options, disk, counters } = fixture(3)
  let active = true
  const resolve = options.resolve
  options.current = () => active
  options.resolve = async (path) => {
    const source = await resolve(path)
    return {
      ...source,
      read: async () => {
        const text = await source.read()
        active = false
        return text
      },
    }
  }
  assert.equal(await index.read(options), null)
  assert.equal(counters.reads, 1)
  active = true
  options.resolve = resolve
  disk.delete('1.md')
  const result = await index.read(options)
  assert.deepEqual(
    result.pages.map((page) => page.path),
    ['0.md', '2.md'],
  )
  assert.equal(result.workspace.entries.length, 3)
  assert.equal(counters.reads, 3, 'first stale page was never retained')
  options.key = 'io-error'
  options.resolve = async () => {
    throw Object.assign(new Error('Denied'), { code: 'EACCES' })
  }
  await assert.rejects(index.read(options), /Denied/)
})

test('folder-only traversal yields cooperatively without Markdown reads', async () => {
  const { index, options, counters } = fixture(0)
  options.entries = Array.from({ length: 303 }, (_, i) => folder(`folder${i}`))
  let turns = 0
  let running = true
  const tick = () => {
    if (running) {
      turns++
      setImmediate(tick)
    }
  }
  setImmediate(tick)
  try {
    const result = await index.read(options)
    assert.equal(result.workspace.entries.length, 303)
    assert.equal(result.pages.length, 0)
    assert.ok(
      turns >= 4,
      `expected at least four cooperative turns; got ${turns}`,
    )
    assert.deepEqual(counters, { stats: 0, reads: 0 })
  } finally {
    running = false
  }
})
