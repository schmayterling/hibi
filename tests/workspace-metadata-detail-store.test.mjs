import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import promises, {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  DetailStoreWriter,
  readDetailStore,
  readInlineDetails,
} from '../src/main/workspace-metadata-detail-store.ts'
import {
  DetailReader,
  RecordReader,
  RecordWriter,
  recordSliceBytes,
  recordTokens,
  validateRecordTokens,
} from '../src/shared/metadata-stream.ts'

const id = createHash('sha256').update('note.md').digest('hex')
const identity = createHash('sha256').update('fixture').digest('hex')
const position = {
  start: { line: 0, col: 0, offset: 0 },
  end: { line: 1, col: 0, offset: 10 },
}
const heading = {
  kind: 'heading',
  value: { depth: 1, text: 'title', position },
}

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'hibi-detail-store-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}

test('detail pages stream each entry, huge strings and nested yaml without truncation', async (t) => {
  const path = await directory(t)
  const huge = 'a💐"\\\n'.repeat(90000)
  let nested = { huge }
  for (let i = 0; i < 100; i++) nested = { next: nested }
  const entries = [
    heading,
    { kind: 'frontmatter', value: { values: { nested }, position } },
    heading,
  ]
  const writer = new DetailStoreWriter(path, id, identity)
  for (const entry of entries) writer.add(entry)
  const source = writer.finish(true)
  assert.equal(writer.inline, undefined)
  assert.equal(source.count, entries.length)
  const reader = new DetailReader()
  const actual = []
  let cursor = 0
  let pages = 0
  let first
  while (true) {
    const page = await readDetailStore(path, source, cursor)
    assert.ok(page)
    first ??= page
    assert.ok(
      Buffer.byteLength(JSON.stringify(page.tokens)) <= recordSliceBytes,
    )
    validateRecordTokens(page.tokens)
    assert.deepEqual(page.source, source)
    actual.push(...reader.write(page.tokens))
    assert.ok(page.nextCursor > cursor)
    cursor = page.nextCursor
    pages++
    if (!page.hasMore) break
  }
  reader.finish()
  assert.ok(pages > 10)
  assert.equal(cursor, source.bytes)
  assert.deepEqual(actual, entries)
  assert.equal(await readDetailStore(path, source, first.nextCursor + 1), null)
  assert.deepEqual(await readDetailStore(path, source, source.bytes), {
    tokens: [],
    nextCursor: source.bytes,
    hasMore: false,
    complete: true,
    source,
  })
})

test('small streams stay inline, yield immediately, and validate cursors', async (t) => {
  const path = await directory(t)
  const writer = new DetailStoreWriter(path, id, identity)
  writer.add(heading)
  const source = writer.finish(true)
  assert.ok(writer.inline)
  const page = readInlineDetails(source, writer.inline, 0)
  const reader = new DetailReader()
  assert.deepEqual([...reader.write(page.tokens)], [heading])
  reader.finish()
  assert.equal(readInlineDetails(source, writer.inline, 1), null)
  assert.equal(await readDetailStore(path, source, 0), null)
  for (const cursor of [-1, 0.5, NaN, Infinity, source.bytes + 1])
    assert.equal(readInlineDetails(source, writer.inline, cursor), null)
})

test('detail reader rejects incomplete streams and invalid primitive tokens', () => {
  const reader = new DetailReader()
  const writer = new RecordWriter()
  const fragments = [
    ...writer.write(
      recordTokens({
        kind: 'frontmatter',
        value: { values: { huge: 'x'.repeat(100000) }, position },
      }),
    ),
  ]
  assert.deepEqual([...reader.write(fragments[0])], [])
  assert.throws(() => reader.finish(), /Incomplete/)
  for (const token of [
    NaN,
    Infinity,
    ['x', true, 'extra'],
    ['x'.repeat(8193), true],
    'oops',
    {},
    undefined,
  ])
    assert.throws(() => new RecordReader().write([token]), /Invalid/)
  assert.throws(
    () => [
      ...new DetailReader().write([
        ...recordTokens({ kind: 'invented', value: {} }),
      ]),
    ],
    /Invalid/,
  )
})

test('typed list entries retain negative root groups and zero', () => {
  for (const parent of [-17, 0, 6]) {
    const entry = { kind: 'listItem', value: { parent, position } }
    const reader = new DetailReader()
    assert.deepEqual([...reader.write([...recordTokens(entry)])], [entry])
    reader.finish()
  }
})

test('mixed escaped strings and floats keep every serialized slice bounded', () => {
  const entry = {
    kind: 'frontmatter',
    value: {
      position,
      values: {
        escaped: String.fromCharCode(0).repeat(24000),
        floats: Array(12000).fill(-1.7976931348623157e308),
      },
    },
  }
  const writer = new RecordWriter()
  const reader = new DetailReader()
  const entries = []
  for (const tokens of [
    ...writer.write(recordTokens(entry)),
    writer.finish(),
  ]) {
    assert.ok(Buffer.byteLength(JSON.stringify(tokens)) <= recordSliceBytes)
    entries.push(...reader.write(tokens))
  }
  reader.finish()
  assert.deepEqual(entries, [entry])
})

test('frontmatter keys preserve data without changing object prototypes', () => {
  const values = JSON.parse(
    '{"__proto__":{"polluted":true},"constructor":{"prototype":"data"}}',
  )
  const entry = { kind: 'frontmatter', value: { values, position } }
  const reader = new DetailReader()
  const [actual] = reader.write([...recordTokens(entry)])
  reader.finish()
  assert.deepEqual(actual, entry)
  assert.equal(Object.getPrototypeOf(actual.value.values), Object.prototype)
  assert.equal(Object.hasOwn(actual.value.values, '__proto__'), true)
  assert.equal({}.polluted, undefined)
})

test('typed detail reader rejects malformed entries after primitive decoding', () => {
  const invalid = [
    { kind: 'heading', value: { depth: 9, text: 'bad', position } },
    { kind: 'link', value: { link: 1, original: 'bad', position } },
    {
      kind: 'embed',
      value: { link: 'ok', original: 'ok', displayText: false, position },
    },
    { kind: 'tag', value: { tag: 1, position } },
    { kind: 'frontmatter', value: { values: [], position } },
    {
      kind: 'frontmatterLink',
      value: { link: 'ok', original: 'ok', key: 1, position },
    },
    { kind: 'listItem', value: { parent: 1.5, position } },
    { kind: 'section', value: { type: 1, position } },
    { kind: 'block', value: { id: 1, position } },
  ]
  for (const entry of invalid)
    assert.throws(
      () => [...new DetailReader().write([...recordTokens(entry)])],
      /Invalid metadata entry/,
    )
})

test('metadata-only record reads skip resident inline details while detail reads retain them', () => {
  const inlineDetails = [
    ...recordTokens({
      kind: 'frontmatter',
      value: { values: { huge: 'z'.repeat(1000000) }, position },
    }),
  ]
  const value = {
    page: { path: 'note.md', details: { key: 'opaque' } },
    inlineDetails,
  }
  const writer = new RecordWriter()
  const slices = [...writer.write(recordTokens(value)), writer.finish()]
  const projected = new RecordReader(undefined, true, true)
  const complete = new RecordReader()
  for (const slice of slices) {
    projected.write(slice)
    complete.write(slice)
  }
  assert.deepEqual(projected.finish(), { page: value.page, inlineDetails: [] })
  assert.deepEqual(complete.finish(), value)
})

test('a folder linked away before the first write keeps no detail temp in the link target', async (t) => {
  const path = await directory(t)
  const cache = join(path, 'cache')
  const outside = join(path, 'outside')
  await mkdir(cache)
  await mkdir(outside)
  const writer = new DetailStoreWriter(cache, id, identity)
  await rename(cache, join(path, 'moved'))
  await symlink(
    outside,
    cache,
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  assert.throws(() => {
    writer.add({
      kind: 'frontmatter',
      value: { values: { huge: 'x'.repeat(100000) }, position },
    })
    writer.finish(true)
  }, /Invalid metadata record/)
  assert.deepEqual(await readdir(outside), [])
})

test('detail file lstat/open race never opens symlink target', async (t) => {
  const path = await directory(t)
  const writer = new DetailStoreWriter(path, id, identity)
  writer.add({
    kind: 'frontmatter',
    value: { values: { huge: 'x'.repeat(100000) }, position },
  })
  const source = writer.finish(true)
  const file = join(path, `${source.key}.mdat`)
  const outside = join(path, 'outside')
  await writeFile(outside, await readFile(file))
  const outsideInfo = await promises.stat(outside, { bigint: true })
  const originalLstat = promises.lstat
  const originalOpen = promises.open
  let swapped = false
  let outsideOpens = 0
  t.mock.method(promises, 'lstat', async (...args) => {
    const info = await originalLstat(...args)
    if (!swapped && String(args[0]) === file) {
      swapped = true
      await rename(file, `${file}.moved`)
      await symlink(outside, file)
    }
    return info
  })
  t.mock.method(promises, 'open', async (...args) => {
    const opened = await originalOpen(...args)
    const info = await opened.stat({ bigint: true })
    if (info.dev === outsideInfo.dev && info.ino === outsideInfo.ino)
      outsideOpens++
    return opened
  })
  syncBuiltinESMExports()
  try {
    assert.equal(await readDetailStore(path, source, 0), null)
    assert.equal(swapped, true)
    // Windows has no O_NOFOLLOW: its open follows the link and the identity
    // check refuses what it opened.
    if (constants.O_NOFOLLOW) assert.equal(outsideOpens, 0)
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
})

test('disk detail guards reject identity, size, invalid boundaries, links and truncation', async (t) => {
  const path = await directory(t)
  const writer = new DetailStoreWriter(path, id, identity)
  writer.add({
    kind: 'frontmatter',
    value: { values: { huge: 'z'.repeat(100000) }, position },
  })
  const source = writer.finish(false)
  const file = join(path, `${source.key}.mdat`)
  assert.equal((await readDetailStore(path, source, 0)).complete, false)
  for (const changed of [
    { identity: 'a'.repeat(64) },
    { bytes: source.bytes + 1 },
    { count: source.count + 1 },
    { complete: true },
    { key: '../escape' },
  ])
    assert.equal(
      await readDetailStore(path, { ...source, ...changed }, 0),
      null,
    )
  for (const cursor of [
    -1,
    0.5,
    NaN,
    Infinity,
    1,
    source.bytes - 1,
    source.bytes + 1,
  ])
    assert.equal(await readDetailStore(path, source, cursor), null)
  const bytes = await readFile(file)
  await truncate(file, bytes.length - 1)
  assert.equal(await readDetailStore(path, source, 0), null)
  await writeFile(file, bytes)
  const moved = `${file}.moved`
  await rename(file, moved)
  await symlink(moved, file)
  assert.equal(await readDetailStore(path, source, 0), null)
  const alias = `${path}-alias`
  await symlink(path, alias, 'dir')
  t.after(() => rm(alias, { force: true }))
  assert.equal(await readDetailStore(alias, source, 0), null)
})
