import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import {
  HeadingStoreWriter,
  headingPageBytes,
  headingStoreBufferBytes,
  readHeadingStore,
} from '../src/main/workspace-metadata-heading-store.ts'
import { WorkspaceMetadataParser } from '../src/main/workspace-metadata-parser.ts'
import {
  RecordReader,
  recordTokens,
} from '../src/main/workspace-metadata-record.ts'
import { defaultNoteSyntax } from '../src/shared/note-syntax.ts'

const id = createHash('sha256').update('note.md').digest('hex')
const identity = createHash('sha256').update('fixture').digest('hex')
const current = () => true
const entry = new URL(
  '../src/main/workspace-metadata-worker.ts',
  import.meta.url,
)
const input = {
  id,
  path: 'note.md',
  version: 'disk:1',
  fingerprint: 'default',
  syntax: {
    key: 'default',
    settings: defaultNoteSyntax,
    complete: true,
    unsupported: false,
  },
}
const request = {
  kind: 'cached',
  id,
  path: input.path,
  version: input.version,
  fingerprint: input.fingerprint,
}

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'hibi-heading-store-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}

test('heading index seeks to large offsets with fixed resident buffers and O(page) disk bytes', async (t) => {
  const path = await directory(t)
  const writer = new HeadingStoreWriter(path, id, identity)
  const count = 100000
  for (let i = 0; i < count; i++)
    writer.add({ depth: (i % 6) + 1, text: 'same' })
  assert.equal(writer.residentBytes, headingStoreBufferBytes * 2)
  assert.equal(writer.index.length + writer.data.length, writer.residentBytes)
  const record = writer.finish()
  assert.equal(
    (await stat(join(path, `${record.key}.hidx`))).size,
    88 + count * 24,
  )
  assert.equal(
    (await stat(join(path, `${record.key}.hdat`))).size,
    88 + count * 8,
  )
  const file = await open(join(path, `${record.key}.hidx`))
  const prototype = Object.getPrototypeOf(file)
  await file.close()
  const original = prototype.read
  const reads = []
  t.mock.method(
    prototype,
    'read',
    async function (buffer, offset, length, position) {
      reads.push({ length, position })
      return original.call(this, buffer, offset, length, position)
    },
  )
  const page = await readHeadingStore(path, record, count - 3, 2, true)
  assert.deepEqual(page, {
    items: [
      { depth: ((count - 3) % 6) + 1, text: 'same' },
      { depth: ((count - 2) % 6) + 1, text: 'same' },
    ],
    nextOffset: count - 1,
    hasMore: true,
    complete: true,
  })
  assert.equal(
    reads.reduce((sum, read) => sum + read.length, 0),
    88 * 2 + 24 * 2 + 8 * 2,
  )
  assert.ok(reads.some((read) => read.position === 88 + (count - 3) * 24))
  assert.deepEqual(await readHeadingStore(path, record, count + 20, 2, true), {
    items: [],
    nextOffset: count + 20,
    hasMore: false,
    complete: true,
  })
})

test('heading pages preserve UTF-16, bound fields and bytes, and advance across skipped fields', async (t) => {
  const path = await directory(t)
  const writer = new HeadingStoreWriter(path, id, identity)
  const text = 'é😀\ud800\u0000'
  for (const heading of [
    { depth: 1, text: 'x'.repeat(headingPageBytes + 1) },
    { depth: 2, text: 'é'.repeat(headingPageBytes) },
    { depth: 3, text },
    { depth: 4, text: 'x'.repeat(headingPageBytes) },
    { depth: 5, text: 'last' },
  ])
    writer.add(heading)
  const record = writer.finish()
  assert.deepEqual(await readHeadingStore(path, record, 0, 2, true), {
    items: [],
    nextOffset: 2,
    hasMore: true,
    complete: false,
  })
  assert.deepEqual(await readHeadingStore(path, record, 2, 3, true), {
    items: [{ depth: 3, text }],
    nextOffset: 3,
    hasMore: true,
    complete: true,
  })
  assert.deepEqual(await readHeadingStore(path, record, 3, 3, false), {
    items: [{ depth: 4, text: 'x'.repeat(headingPageBytes) }],
    nextOffset: 4,
    hasMore: true,
    complete: false,
  })
  assert.equal(
    (await readHeadingStore(path, record, 4, 3, true)).hasMore,
    false,
  )
  writer.abort()
  assert.deepEqual(await readdir(path), [])
})

test('heading store rejects invalid descriptors, identities, truncation, symlinks and path replacement', async (t) => {
  const path = await directory(t)
  const writer = new HeadingStoreWriter(path, id, identity)
  writer.add({ depth: 1, text: 'inside' })
  const record = writer.finish()
  assert.equal(
    await readHeadingStore(path, { ...record, key: '../outside' }, 0, 1, true),
    null,
  )
  assert.equal(
    await readHeadingStore(
      path,
      { ...record, identity: '0'.repeat(64) },
      0,
      1,
      true,
    ),
    null,
  )
  for (const [offset, limit] of [
    [-1, 1],
    [0, 0],
    [0, 1001],
    [Infinity, 1],
  ])
    assert.equal(
      await readHeadingStore(path, record, offset, limit, true),
      null,
    )
  const dataPath = join(path, `${record.key}.hdat`)
  const outside = join(path, 'outside')
  await rename(dataPath, outside)
  await symlink(outside, dataPath)
  assert.equal(await readHeadingStore(path, record, 0, 1, true), null)
  await rm(dataPath)
  await rename(outside, dataPath)
  const linked = join(path, 'linked')
  await symlink(path, linked)
  assert.equal(await readHeadingStore(linked, record, 0, 1, true), null)
  const file = await open(dataPath)
  const prototype = Object.getPrototypeOf(file)
  await file.close()
  const original = prototype.read
  let replaced = false
  t.mock.method(prototype, 'read', async function (...args) {
    const value = await original.apply(this, args)
    if (!replaced && args[3] === 88) {
      replaced = true
      await rename(dataPath, outside)
      await writeFile(dataPath, await readFile(outside))
    }
    return value
  })
  assert.equal(await readHeadingStore(path, record, 0, 1, true), null)
  t.mock.restoreAll()
  await truncate(join(path, `${record.key}.hidx`), 90)
  assert.equal(await readHeadingStore(path, record, 0, 1, true), null)
})

test('record reconstruction discards heading item strings without joining or retaining them', () => {
  const reader = new RecordReader(undefined, true)
  const value = {
    page: {
      metadata: {
        headings: {
          items: Array.from({ length: 20000 }, () => ({
            text: 'h'.repeat(64),
            depth: 1,
          })),
          count: 20000,
          complete: true,
          paged: true,
        },
      },
    },
  }
  for (const token of recordTokens(value)) reader.write([token])
  assert.deepEqual(reader.finish(), {
    page: {
      metadata: {
        headings: {
          items: [],
          count: 20000,
          complete: true,
          paged: true,
        },
      },
    },
  })
})

test('completed pruning removes replaced and deleted heading stores; worker temp stores never persist drafts', async (t) => {
  const path = await directory(t)
  const options = { entry, cacheDirectory: path, appVersion: 'fixture' }
  let parser = new WorkspaceMetadataParser(() => options)
  t.after(async () => parser.close())
  const parse = (note, markdown) =>
    parser.parseSource(
      note,
      {
        utf16Length: markdown.length,
        sliceRaw: (start, end) => markdown.slice(start, end),
      },
      current,
    )
  await parser.beginBuild(current)
  await parse(input, '# saved')
  const saved = await readFile(join(path, `${id}.json`), 'utf8')
  const privateDirectory = parser.headingDirectory
  const dirty = { ...input, version: 'draft:1' }
  await parse(dirty, 'private-source-marker\n# dirty')
  assert.equal(await readFile(join(path, `${id}.json`), 'utf8'), saved)
  assert.equal(
    (
      await parser.readHeadings(
        { ...request, version: dirty.version },
        0,
        1,
        current,
      )
    ).items[0].text,
    'dirty',
  )
  assert.equal(
    (await parser.readHeadings(request, 0, 1, current)).items[0].text,
    'saved',
  )
  assert.equal((await readdir(privateDirectory)).length, 2)
  await parser.close()
  await assert.rejects(stat(privateDirectory), { code: 'ENOENT' })
  parser = new WorkspaceMetadataParser(() => options)
  assert.equal(
    await parser.readHeadings(
      { ...request, version: dirty.version },
      0,
      1,
      current,
    ),
    null,
  )
  const changed = { ...input, version: 'disk:2' }
  await parse(changed, '# changed')
  const other = {
    ...input,
    path: 'other.md',
    id: createHash('sha256').update('other.md').digest('hex'),
  }
  await parse(other, '# removed')
  assert.equal(
    (await readdir(path)).filter((name) => /\.h(idx|dat)$/.test(name)).length,
    6,
  )
  await parser.beginBuild(current)
  await parser.markSeen([id], current)
  assert.equal(await parser.finishBuild(current), true)
  const files = await readdir(path)
  assert.equal(files.filter((name) => /\.h(idx|dat)$/.test(name)).length, 2)
  assert.equal(files.filter((name) => name.endsWith('.json')).length, 1)
  assert.equal(
    (
      await parser.readHeadings(
        { ...request, version: changed.version },
        0,
        1,
        current,
      )
    ).items[0].text,
    'changed',
  )
  assert.equal(await parser.readHeadings(request, 0, 1, current), null)
})

test('watchdog respawn cleans partial heading files, retransfers sources, and preserves recoverable metadata', async (t) => {
  const path = await directory(t)
  const bundle = join(path, 'stuck-headings.mjs')
  await writeFile(
    bundle,
    `
import { Marked } from ${JSON.stringify(import.meta.resolve('marked'))}
const walk = Marked.prototype.walkTokens
Marked.prototype.walkTokens = function (tokens, callback) {
  if (!tokens[0]?.raw?.startsWith('stuck-headings')) return walk.call(this, tokens, callback)
  for (let i = 0; i < 10000; i++) callback({ type: 'heading', depth: 1, tokens: [{ type: 'text', text: 'partial' }] })
  while (true) {}
}
await import(${JSON.stringify(entry.href)})
`,
  )
  const parser = new WorkspaceMetadataParser(() => ({
    entry: bundle,
    cacheDirectory: path,
    appVersion: 'fixture',
    watchdogMs: 100,
  }))
  t.after(async () => parser.close())
  const markdown =
    'stuck-headings\n# recovered\n[target](target.md) [[wiki]] #work'
  let transfers = 0
  await parser.beginBuild(current)
  const old = parser.worker
  const privateDirectory = parser.headingDirectory
  const page = await parser.parseSource(
    input,
    {
      utf16Length: markdown.length,
      sliceRaw: (start, end) => {
        transfers++
        return markdown.slice(start, end)
      },
    },
    current,
  )
  assert.notEqual(parser.worker, old)
  assert.equal(transfers, 2)
  await assert.rejects(stat(privateDirectory), { code: 'ENOENT' })
  assert.equal(
    (await readdir(path)).some((name) => name.endsWith('.tmp')),
    false,
  )
  assert.deepEqual(page.metadata.references, {
    links: ['target.md'],
    wikilinks: ['wiki'],
  })
  assert.deepEqual(page.metadata.tags, ['work'])
  assert.equal(
    (await parser.readHeadings(request, 0, 1, current)).items[0].text,
    'recovered',
  )
  assert.equal(await parser.finishBuild(current), true)
  assert.equal(
    (await readdir(path)).filter((name) => /\.h(idx|dat)$/.test(name)).length,
    2,
  )
})

test('legacy heading records miss after one bounded disk slice', async (t) => {
  const path = await directory(t)
  const bundle = join(path, 'read-count.mjs')
  await writeFile(
    bundle,
    `
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { parentPort } from 'node:worker_threads'
const open = fs.open
let readBytes = 0
fs.open = async (...args) => {
  const file = await open(...args), read = file.read.bind(file)
  file.read = async (buffer, offset, length, ...rest) => {
    readBytes += length
    return read(buffer, offset, length, ...rest)
  }
  return file
}
syncBuiltinESMExports()
const post = parentPort.postMessage.bind(parentPort)
parentPort.postMessage = (message) => post({ ...message, readBytes })
await import(${JSON.stringify(entry.href)})
`,
  )
  await writeFile(
    join(path, `${id}.json`),
    JSON.stringify(['{', ['schema', true], 4]) +
      '\n' +
      'x'.repeat(2 * 1024 * 1024),
  )
  const parser = new WorkspaceMetadataParser(() => ({
    entry: bundle,
    cacheDirectory: path,
    appVersion: 'fixture',
  }))
  t.after(async () => parser.close())
  await parser.beginBuild(current)
  let readBytes = 0
  parser.worker.on('message', (message) => {
    readBytes = message.readBytes
  })
  assert.equal(await parser.request(request, current), null)
  assert.equal(readBytes, 64 * 1024)
})

test('file changes or EIO after heading extraction return null and publish no record or sidecars', async (t) => {
  const path = await directory(t)
  for (const mode of ['changed', 'EIO']) {
    const nativePath = join(path, `${mode}.md`)
    const markdown = '# trigger\nbody'
    await writeFile(nativePath, markdown)
    const { diskIndexVersion } = await import(
      '../src/main/workspace-index-cache.ts'
    )
    const version = diskIndexVersion(await stat(nativePath, { bigint: true }))
    const note = { ...input, nativePath, expectedVersion: version, version }
    const bundle = join(path, `${mode}.mjs`)
    await writeFile(
      bundle,
      mode === 'changed'
        ? `
import { Marked } from ${JSON.stringify(import.meta.resolve('marked'))}
import { writeFileSync } from 'node:fs'
const walk = Marked.prototype.walkTokens
let changed = false
Marked.prototype.walkTokens = function (tokens, callback) {
  if (!changed) { changed = true; writeFileSync(${JSON.stringify(nativePath)}, '# replacement') }
  return walk.call(this, tokens, callback)
}
await import(${JSON.stringify(entry.href)})
`
        : `
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
const open = fs.open
let stats = 0
fs.open = async (...args) => {
  const file = await open(...args)
  if (String(args[0]) === ${JSON.stringify(nativePath)}) {
    const stat = file.stat.bind(file)
    file.stat = async (...args) => {
      if (++stats === 3) throw Object.assign(new Error('stat fixture'), { code: 'EIO' })
      return stat(...args)
    }
  }
  return file
}
syncBuiltinESMExports()
await import(${JSON.stringify(entry.href)})
`,
    )
    const parser = new WorkspaceMetadataParser(() => ({
      entry: bundle,
      cacheDirectory: path,
      appVersion: 'fixture',
    }))
    try {
      assert.equal(await parser.parseFile(note, current), null)
      assert.equal(
        (await readdir(path)).filter((name) =>
          /\.(?:json|hidx|hdat|tmp)$/.test(name),
        ).length,
        0,
      )
    } finally {
      await parser.close()
    }
  }
})

test('heading reads cancel without retaining pages and validate request bounds before work', async (t) => {
  const path = await directory(t)
  const parser = new WorkspaceMetadataParser(() => ({
    entry,
    cacheDirectory: path,
    appVersion: 'fixture',
  }))
  t.after(async () => parser.close())
  const markdown = '# first\n## second'
  await parser.parseSource(
    input,
    {
      utf16Length: markdown.length,
      sliceRaw: (start, end) => markdown.slice(start, end),
    },
    current,
  )
  await assert.rejects(
    parser.readHeadings(request, 0, 1001, current),
    /Invalid heading page/,
  )
  assert.equal(await parser.readHeadings(request, 0, 1, () => false), null)
  let live = true
  parser.worker.once('message', () => {
    live = false
  })
  assert.equal(await parser.readHeadings(request, 0, 1, () => live), null)
  assert.equal(
    (await parser.readHeadings(request, 1, 1, current)).items[0].text,
    'second',
  )
})

test('saved notes leave no growing worker heading lookup; only dirty descriptors remain', async (t) => {
  const path = await directory(t)
  const bundle = join(path, 'location-count.mjs')
  await writeFile(
    bundle,
    `
import { parentPort } from 'node:worker_threads'
const set = Map.prototype.set
let locations
let peak = 0
Map.prototype.set = function (key, value) {
  const result = set.call(this, key, value)
  if (value && typeof value === 'object' && 'directory' in value && 'fingerprint' in value && 'store' in value) {
    locations = this
    peak = Math.max(peak, this.size)
  }
  return result
}
const post = parentPort.postMessage.bind(parentPort)
parentPort.postMessage = (message) => post({ ...message, locations: locations?.size ?? 0, peak })
await import(${JSON.stringify(entry.href)})
`,
  )
  const parser = new WorkspaceMetadataParser(() => ({
    entry: bundle,
    cacheDirectory: path,
    appVersion: 'fixture',
  }))
  t.after(async () => parser.close())
  await parser.beginBuild(current)
  let retained = 0
  let peak = 0
  parser.worker.on('message', (message) => {
    retained = message.locations
    peak = message.peak
  })
  const markdown = '# heading'
  for (let index = 0; index < 16; index++) {
    const path = `saved-${index}.md`
    await parser.parseSource(
      { ...input, path, id: createHash('sha256').update(path).digest('hex') },
      {
        utf16Length: markdown.length,
        sliceRaw: (start, end) => markdown.slice(start, end),
      },
      current,
    )
    assert.equal(retained, 0)
  }
  assert.equal(peak, 1)
  await parser.parseSource(
    { ...input, version: 'draft:1' },
    {
      utf16Length: markdown.length,
      sliceRaw: (start, end) => markdown.slice(start, end),
    },
    current,
  )
  assert.equal(retained, 1)
  assert.equal(peak, 1)
})

test('sidecar identity binds the generated store to record version and syntax fingerprint', async (t) => {
  const path = await directory(t)
  const parser = new WorkspaceMetadataParser(() => ({
    entry,
    cacheDirectory: path,
    appVersion: 'fixture',
  }))
  t.after(async () => parser.close())
  const markdown = '# saved'
  await parser.parseSource(
    input,
    {
      utf16Length: markdown.length,
      sliceRaw: (start, end) => markdown.slice(start, end),
    },
    current,
  )
  const file = join(path, `${id}.json`)
  const reader = new RecordReader()
  for (const line of (await readFile(file, 'utf8')).trimEnd().split('\n'))
    reader.write(JSON.parse(line))
  const original = reader.finish()
  for (const changed of [
    { ...original, page: { ...original.page, version: 'disk:changed' } },
    { ...original, fingerprint: 'changed' },
  ]) {
    await writeFile(file, `${JSON.stringify([...recordTokens(changed)])}\n`)
    const descriptor = {
      ...request,
      version: changed.page.version,
      fingerprint: changed.fingerprint,
    }
    assert.equal(await parser.request(descriptor, current), null)
    assert.equal(await parser.readHeadings(descriptor, 0, 1, current), null)
  }
})

test('parse requests without cache ids retain transient headings without persisting records', async (t) => {
  const path = await directory(t)
  const parser = new WorkspaceMetadataParser(() => ({
    entry,
    cacheDirectory: path,
    appVersion: 'fixture',
  }))
  t.after(async () => parser.close())
  const page = await parser.request(
    {
      kind: 'parse',
      page: { path: input.path, markdown: '# transient' },
      syntax: input.syntax,
      version: input.version,
      fingerprint: input.fingerprint,
    },
    current,
  )
  assert.equal(page.metadata.headings.count, 1)
  assert.equal(
    (await parser.readHeadings({ ...request, id: '' }, 0, 1, current)).items[0]
      .text,
    'transient',
  )
  assert.deepEqual(await readdir(path), [])
})

async function baseline(directory) {
  const files = ['workspace-metadata-parser.ts', 'workspace-metadata-worker.ts']
  for (const name of files) {
    const { stdout } = await promisify(execFile)(
      'git',
      ['show', `HEAD:src/main/${name}`],
      { maxBuffer: 1024 * 1024 },
    )
    const original = new URL(`../src/main/${name}`, import.meta.url)
    const source = stdout.replace(
      /(from\s*|import\s*)['"](\.[^'"]+)['"]/g,
      (_, prefix, path) =>
        `${prefix}${JSON.stringify(new URL(path, original).href)}`,
    )
    await writeFile(join(directory, name), source)
  }
  return {
    Parser: (await import(new URL(`file://${join(directory, files[0])}`)))
      .WorkspaceMetadataParser,
    entry: new URL(`file://${join(directory, files[1])}`),
  }
}

test('heading volumes keep cold and warm metadata resident bytes independent of heading count', async (t) => {
  const path = await directory(t)
  const selected = process.env.HIBI_METADATA_BASELINE
    ? await baseline(path)
    : { Parser: WorkspaceMetadataParser, entry }
  const bundle = join(path, 'dense.mjs')
  const count = Number(process.env.HIBI_HEADING_COUNT ?? 4096)
  const labelLength = Number(process.env.HIBI_HEADING_LABEL ?? 512)
  await writeFile(
    bundle,
    `
import { Marked } from ${JSON.stringify(import.meta.resolve('marked'))}
const walk = Marked.prototype.walkTokens
Marked.prototype.walkTokens = function (tokens, callback) {
  if (!tokens[0]?.raw?.startsWith('synthetic-headings')) return walk.call(this, tokens, callback)
  for (let i = 0; i < ${count}; i++) callback({ type: 'heading', depth: i % 6 + 1, tokens: [{ type: 'text', text: 'h'.repeat(${labelLength}) }] })
  return []
}
await import(${JSON.stringify(selected.entry.href)})
`,
  )
  let parser = new selected.Parser(() => ({
    entry: bundle,
    cacheDirectory: path,
    appVersion: 'fixture',
  }))
  t.after(async () => parser.close())
  const page = await parser.parseSource(
    input,
    {
      utf16Length: 18,
      sliceRaw: (start, end) => 'synthetic-headings'.slice(start, end),
    },
    current,
  )
  assert.equal(page.metadata.headings.items.length, 0)
  assert.equal(page.metadata.headings.count, count)
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 2048)
  assert.ok((await stat(join(path, `${id}.json`))).size < 4096)
  const cold = await parser.readHeadings(request, count - 1, 1, current)
  assert.equal(cold.items[0].text.length, labelLength)
  await parser.close()
  parser = new selected.Parser(() => ({
    entry: bundle,
    cacheDirectory: path,
    appVersion: 'fixture',
  }))
  let replyBytes = 0
  await parser.beginBuild(current)
  parser.worker.on('message', (message) => {
    replyBytes += Buffer.byteLength(JSON.stringify(message))
  })
  const [warm] = await parser.cachedBatch([request], current)
  assert.deepEqual(warm, page)
  assert.ok(replyBytes < 4096)
  t.diagnostic(
    JSON.stringify({
      headings: count,
      labelLength,
      metadataJsonBytes: Buffer.byteLength(JSON.stringify(page)),
      residentHeadingItems: page.metadata.headings.items.length,
      writerBufferBytes: headingStoreBufferBytes * 2,
      recordBytes: (await stat(join(path, `${id}.json`))).size,
      warmTransportBytes: replyBytes,
    }),
  )
  const tail = await parser.readHeadings(request, count - 1, 1, current)
  assert.deepEqual(tail, cold)
  assert.equal(await parser.finishBuild(current), true)
})
