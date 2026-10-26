import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import {
  appendFile,
  mkdtemp,
  readdir,
  readFile,
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
import { diskIndexVersion } from '../src/main/workspace-index-cache.ts'
import {
  incompleteMetadataPage,
  WorkspaceMetadataParser,
} from '../src/main/workspace-metadata-parser.ts'
import {
  RecordReader,
  RecordWriter,
  recordSliceBytes,
  recordSliceCharacters,
  recordSliceTokens,
  recordTokens,
} from '../src/main/workspace-metadata-record.ts'
import { defaultNoteSyntax } from '../src/shared/note-syntax.ts'

const entry = new URL(
  '../src/main/workspace-metadata-worker.ts',
  import.meta.url,
)
const syntax = {
  key: 'default',
  settings: defaultNoteSyntax,
  complete: true,
  unsupported: false,
}
const id = createHash('sha256').update('note.md').digest('hex')
const parse = (markdown, version = 'disk:1') => ({
  kind: 'parse',
  page: { id, path: 'note.md', markdown },
  syntax,
  version,
  fingerprint: 'default',
})

test('large-page metadata parsing stays in one worker while main gets task turns', async (t) => {
  const parser = new WorkspaceMetadataParser(() => ({ entry }))
  t.after(async () => {
    parser.close()
    await parser.stopping
  })
  await parser.request(parse('# warmup'), () => true)
  const worker = parser.worker
  assert.ok(worker.threadId > 0)
  const original = String.prototype.matchAll
  const split = String.prototype.split
  let mainNormalizations = 0
  t.mock.method(String.prototype, 'split', function (...args) {
    if (String(this).startsWith('././')) mainNormalizations++
    return split.apply(this, args)
  })
  let mainParses = 0
  t.mock.method(String.prototype, 'matchAll', function (...args) {
    if (String(this).startsWith('metadata-worker-marker')) mainParses++
    return original.apply(this, args)
  })
  const source = `metadata-worker-marker ${'body '.repeat(200000)} [target](${'./'.repeat(100000)}target.md#${'fragment'.repeat(5000)}) #work [[target#${'fragment'.repeat(5000)}]]`
  let settled = false
  const pending = parser
    .request(parse(source, 'disk:2'), () => true)
    .finally(() => {
      settled = true
    })
  let turns = 0
  for (; turns < 8 && !settled; turns++)
    await new Promise((resolve) => setImmediate(resolve))
  const page = await pending
  assert.ok(turns > 0)
  assert.equal(mainParses, 0)
  assert.equal(mainNormalizations, 0)
  assert.deepEqual(page.metadata.references.links, ['target.md'])
  assert.equal(parser.worker, worker)
  assert.deepEqual(page.metadata.references.wikilinks, ['target'])
  assert.deepEqual(page.metadata.tags, ['work'])
  assert.equal(Object.hasOwn(page, 'markdown'), false)
})

test('derived cache survives reopening and validates source, syntax and corrupt records', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hibi-metadata-cache-'))
  let parser = new WorkspaceMetadataParser(() => ({
    entry,
    cacheDirectory: directory,
    appVersion: '1.0.0',
  }))
  t.after(async () => {
    parser.close()
    await parser.stopping
    await rm(directory, { recursive: true, force: true })
  })
  const metadata = await parser.request(
    parse('body-only-marker [[target]] #work'),
    () => true,
  )
  const path = join(directory, `${id}.json`)
  const disk = await readFile(path, 'utf8')
  assert.equal(disk.includes('body-only-marker'), false)
  parser.close()
  await parser.stopping
  parser = new WorkspaceMetadataParser(() => ({
    entry,
    cacheDirectory: directory,
    appVersion: '1.0.0',
  }))
  const cached = {
    kind: 'cached',
    id,
    path: 'note.md',
    version: 'disk:1',
    fingerprint: 'default',
  }
  assert.deepEqual(await parser.request(cached, () => true), metadata)
  assert.equal(
    await parser.request({ ...cached, version: 'disk:2' }, () => true),
    null,
  )
  assert.equal(
    await parser.request({ ...cached, fingerprint: 'changed' }, () => true),
    null,
  )
  await writeFile(path, '{"page": {"metadata": {}}}')
  assert.equal(await parser.request(cached, () => true), null)
  assert.equal(await parser.request(parse('# obsolete'), () => false), null)
})

const current = () => true
async function headingFrom(parser, page) {
  assert.deepEqual(page.metadata.headings.items, [])
  const result = await parser.readHeadings(
    {
      kind: 'cached',
      id: page.id,
      path: page.path,
      version: page.version,
      fingerprint: 'default',
    },
    0,
    1,
    current,
  )
  return result?.items[0]?.text
}
const descriptor = (path = 'note.md') => ({
  kind: 'cached',
  id: createHash('sha256').update(path).digest('hex'),
  path,
  version: 'disk:1',
  fingerprint: 'default',
})
const parseNote = (path, markdown = 'body-only-marker [[target]] #work') => ({
  ...parse(markdown),
  page: { id: descriptor(path).id, path, markdown },
})

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hibi-metadata-worker-'))
  const parsers = []
  const create = (options = {}) => {
    const parser = new WorkspaceMetadataParser(() => ({
      entry,
      cacheDirectory: directory,
      appVersion: '1.0.0',
      ...options,
    }))
    parsers.push(parser)
    return parser
  }
  const close = async (parser) => {
    parser.close()
    await parser.stopping
  }
  t.after(async () => {
    for (const parser of parsers) await close(parser)
    await rm(directory, { recursive: true, force: true })
  })
  return { directory, create, close }
}

async function readRecord(path) {
  const reader = new RecordReader()
  for (const line of (await readFile(path, 'utf8')).trimEnd().split('\n'))
    reader.write(JSON.parse(line))
  return reader.finish()
}
async function writeRecord(path, record) {
  await writeFile(path, '')
  const writer = new RecordWriter()
  for (const slice of writer.write(recordTokens(record)))
    await appendFile(path, `${JSON.stringify(slice)}\n`)
  await appendFile(path, `${JSON.stringify(writer.finish())}\n`)
}

async function seed(parser, directory, paths) {
  await parser.request(parseNote('note.md'), current)
  const template = await readRecord(join(directory, `${id}.json`))
  for (const path of paths) {
    const request = descriptor(path)
    await writeRecord(join(directory, `${request.id}.json`), {
      ...template,
      page: { ...template.page, id: request.id, path },
    })
  }
  return template
}

test('cache identity preserves file ids above the safe integer range', async (t) => {
  const { directory, create } = await fixture(t)
  const bundle = join(directory, 'large-file-id.mjs')
  await writeFile(
    bundle,
    `
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
const lstat = fs.lstat
const open = fs.open
const identity = (info, path, options) => {
  if (String(path).endsWith('.json'))
    info.ino = options?.bigint ? 9007199254740993n : Number(9007199254740993n)
  return info
}
fs.lstat = async (path, options) => identity(await lstat(path, options), path, options)
fs.open = async (path, ...args) => {
  const file = await open(path, ...args)
  const stat = file.stat.bind(file)
  file.stat = async (options) => identity(await stat(options), path, options)
  return file
}
syncBuiltinESMExports()
await import(${JSON.stringify(entry.href)})
`,
  )
  const parser = create({ entry: bundle })
  const expected = await parser.request(
    parse('# cached [[target]] #work'),
    current,
  )
  assert.deepEqual(await parser.request(descriptor(), current), expected)
  assert.equal(await headingFrom(parser, expected), 'cached target #work')
})

test('cache identity requires the running app version', async (t) => {
  const { directory, create, close } = await fixture(t)
  let parser = create()
  const expected = await parser.request(parse('# cached'), current)
  const record = await readRecord(join(directory, `${id}.json`))
  await close(parser)
  parser = create()
  assert.deepEqual(await parser.request(descriptor(), current), expected)
  await close(parser)
  parser = create({ appVersion: '1.0.1' })
  assert.equal(await parser.request(descriptor(), current), null)
  const saved = await readFile(join(directory, `${id}.json`), 'utf8')
  const identity = JSON.parse(record.buildIdentity)
  assert.equal(identity[0], '1.0.0')
  assert.match(identity[1], /^[a-f0-9]{64}$/)
  await close(parser)
  parser = create({ appVersion: undefined })
  assert.equal(await parser.request(descriptor(), current), null)
  await parser.request(parse('# no identity', 'disk:2'), current)
  assert.equal(await readFile(join(directory, `${id}.json`), 'utf8'), saved)
  await close(parser)
})

test('same-version cache rejects changed entry and transitive chunks', async (t) => {
  const { directory, create, close } = await fixture(t)
  let parser
  const bundle = join(directory, 'worker.mjs')
  const chunk = join(directory, 'chunk-hashed.mjs')
  const nested = join(directory, 'nested-hashed.mjs')
  const source = `import ${JSON.stringify(entry.href)};\nimport './chunk-hashed.mjs';\n`
  await writeFile(bundle, source)
  await writeFile(
    chunk,
    "import './nested-hashed.mjs';\nexport const version = 1\n",
  )
  await writeFile(nested, 'export const version = 1\n')
  parser = create({ entry: bundle })
  await parser.request(parse('# bundle'), current)
  await close(parser)
  for (const [path, content] of [
    [bundle, `${source}// rebuilt\n`],
    [chunk, "import './nested-hashed.mjs';\nexport const version = 2\n"],
    [nested, 'export const version = 2\n'],
  ]) {
    await writeFile(path, content)
    parser = create({ entry: bundle })
    assert.equal(await parser.request(descriptor(), current), null)
    await parser.request(parse('# bundle'), current)
    await close(parser)
    parser = create({ entry: bundle })
    assert.ok(await parser.request(descriptor(), current))
    await close(parser)
  }
})

test('cached batches restore 129 notes in three messages, preserving order and misses', async (t) => {
  const { directory, create, close } = await fixture(t)
  const paths = Array.from({ length: 129 }, (_, i) => `note-${i}.md`)
  let parser = create()
  await seed(parser, directory, paths)
  await close(parser)
  parser = create()
  await parser.request(descriptor('missing.md'), current)
  const worker = parser.worker
  const post = worker.postMessage.bind(worker)
  const messages = []
  let active = 0
  let peak = 0
  worker.on('message', () => {
    active--
  })
  t.mock.method(worker, 'postMessage', (request) => {
    messages.push(request)
    peak = Math.max(peak, ++active)
    post(request)
  })
  const batches = []
  for (let offset = 0; offset < paths.length; offset += 64)
    batches.push(
      parser.cachedBatch(
        paths.slice(offset, offset + 64).map(descriptor),
        current,
      ),
    )
  const pages = (await Promise.all(batches)).flat()
  assert.equal(peak, 1)
  assert.deepEqual(
    pages.map((page) => page.path),
    paths,
  )
  assert.deepEqual(
    messages.map((message) => message.requests.length),
    [64, 64, 1],
  )
  assert.equal(parser.worker, worker)
  assert.deepEqual(
    await parser
      .cachedBatch(
        [
          { ...descriptor(paths[0]), version: 'disk:changed' },
          descriptor(paths[1]),
          descriptor('missing.md'),
        ],
        current,
      )
      .then((items) => items.map((page) => page?.path ?? null)),
    [null, paths[1], null],
  )
  const count = messages.length
  await assert.rejects(
    parser.cachedBatch(Array(65).fill(descriptor()), current),
    RangeError,
  )
  assert.equal(messages.length, count)
  assert.deepEqual(await parser.cachedBatch([descriptor()], () => false), [
    null,
  ])
  assert.equal(messages.length, count)
})

test('cached batch file reads keep one record and handle at a time', async (t) => {
  const { directory, create } = await fixture(t)
  const bundle = join(directory, 'count-reads.mjs')
  await writeFile(
    bundle,
    `
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { parentPort } from 'node:worker_threads'
let active = 0, peak = 0, opened = 0
const open = fs.open
fs.open = async (...args) => {
  const file = await open(...args)
  opened++
  peak = Math.max(peak, ++active)
  const close = file.close.bind(file)
  file.close = async () => { try { await close() } finally { active-- } }
  return file
}
syncBuiltinESMExports()
const post = parentPort.postMessage.bind(parentPort)
parentPort.postMessage = (message) => post({ ...message, stats: { active, peak, opened } })
await import(${JSON.stringify(entry.href)})
`,
  )
  const parser = create({ entry: bundle })
  const paths = Array.from({ length: 64 }, (_, i) => `read-${i}.md`)
  await seed(parser, directory, paths)
  let stats
  parser.worker.on('message', (message) => {
    stats = message.stats
  })
  const pages = await parser.cachedBatch(paths.map(descriptor), current)
  assert.equal(pages.filter(Boolean).length, 64)
  assert.equal(stats.opened, 65)
  assert.equal(stats.active, 0)
  assert.equal(stats.peak, 1)
})

test('cache batches stream every large record and oversized string without size misses', async (t) => {
  const { directory, create, close } = await fixture(t)
  let parser = create()
  const paths = ['one.md', 'two.md', 'three.md', 'large.md', 'corrupt.md']
  const template = await seed(parser, directory, paths)
  const heading = 'h'.repeat(1536 * 1024)
  for (const path of paths.slice(0, 3)) {
    const request = descriptor(path)
    await writeRecord(join(directory, `${request.id}.json`), {
      ...template,
      page: {
        ...template.page,
        ...request,
        metadata: {
          ...template.page.metadata,
          tags: [heading],
        },
      },
    })
  }
  const pages = await parser.cachedBatch(
    paths.slice(0, 3).map(descriptor),
    current,
  )
  assert.equal(pages.filter(Boolean).length, 3)
  assert.ok(pages.every((page) => page.metadata.tags[0] === heading))
  const large = descriptor('large.md')
  const text = `x${'\u0000é😀'.repeat(6 * 1024 * 1024)}`
  await writeRecord(join(directory, `${large.id}.json`), {
    ...template,
    page: {
      ...template.page,
      ...large,
      metadata: {
        ...template.page.metadata,
        tags: [text],
      },
    },
  })
  assert.ok(
    (await stat(join(directory, `${large.id}.json`))).size > 32 * 1024 * 1024,
  )
  await close(parser)
  parser = create()
  const [page] = await parser.cachedBatch([large], current)
  assert.equal(page.metadata.tags[0], text)
  const corrupt = descriptor('corrupt.md')
  await truncate(join(directory, `${corrupt.id}.json`), 32 * 1024 * 1024 + 1)
  assert.equal(await parser.request(corrupt, current), null)
  assert.deepEqual(await parser.cachedBatch([corrupt], current), [null])
  const recomputed = await parser.request(
    parseNote('large.md', '# recomputed'),
    current,
  )
  assert.equal(await headingFrom(parser, recomputed), 'recomputed')
})

test('completed builds prune removed records and abandoned temporaries, retaining seen ids only', async (t) => {
  const { directory, create } = await fixture(t)
  const parser = create()
  const paths = [
    'batch.md',
    'parsed.md',
    'retained.md',
    'removed.md',
    'renamed.md',
  ]
  await seed(parser, directory, paths)
  const temporary = `.${id}-00000000-0000-0000-0000-000000000000.tmp`
  await writeFile(join(directory, temporary), 'partial derived cache')
  await writeFile(join(directory, 'unrelated.tmp'), 'keep')
  await writeFile(join(directory, 'unrelated.json'), 'keep')
  assert.equal(await parser.finishBuild(current), false)
  assert.equal(await parser.beginBuild(current), true)
  assert.ok((await parser.cachedBatch([descriptor(paths[0])], current))[0])
  await parser.request(parseNote(paths[1]), current)
  assert.equal(await parser.markSeen([descriptor(paths[2]).id], current), true)
  assert.equal(await parser.finishBuild(current), true)
  const remaining = await readdir(directory)
  assert.deepEqual(
    remaining.sort(),
    [
      ...paths.slice(0, 3).map((path) => `${descriptor(path).id}.json`),
      'unrelated.json',
      'unrelated.tmp',
    ].sort(),
  )
  assert.equal(await parser.finishBuild(current), false)
  await parser.beginBuild(current)
  assert.equal(await parser.finishBuild(current), true)
  assert.deepEqual((await readdir(directory)).sort(), [
    'unrelated.json',
    'unrelated.tmp',
  ])
})

test('canceled partial builds never prune and the next build starts a fresh seen set', async (t) => {
  const { directory, create, close } = await fixture(t)
  let parser = create()
  const paths = ['keep.md', 'removed.md']
  await seed(parser, directory, paths)
  await parser.beginBuild(current)
  await parser.cachedBatch([descriptor('removed.md')], current)
  assert.equal(await parser.finishBuild(() => false), false)
  assert.equal((await readdir(directory)).length, 3)
  await close(parser)
  parser = create()
  // Closing/respawning must not make the previous partial set pruneable.
  assert.equal(await parser.finishBuild(current), false)
  assert.equal((await readdir(directory)).length, 3)
  await parser.beginBuild(current)
  await parser.markSeen([descriptor('keep.md').id], current)
  assert.equal(await parser.finishBuild(current), true)
  assert.deepEqual(await readdir(directory), [
    `${descriptor('keep.md').id}.json`,
  ])
})

test('worker respawn preserves completed-build membership and pruning', async (t) => {
  const { directory, create } = await fixture(t)
  const parser = create()
  await seed(parser, directory, ['keep.md'])
  await parser.beginBuild(current)
  await parser.markSeen([descriptor('keep.md').id], current)
  const old = parser.worker
  const exited = once(old, 'exit')
  await old.terminate()
  await exited
  assert.equal(parser.worker, undefined)
  const page = await parser.request(parseNote('new.md'), current)
  assert.equal(page.path, 'new.md')
  assert.notEqual(parser.worker, old)
  old.emit('message', { value: { path: 'stale' } })
  assert.equal(await parser.finishBuild(current), true)
  assert.deepEqual(
    (await readdir(directory)).sort(),
    ['keep.md', 'new.md'].map((path) => `${descriptor(path).id}.json`).sort(),
  )
  await parser.beginBuild(current)
  await parser.cachedBatch([descriptor('new.md')], current)
  assert.equal(await parser.finishBuild(current), true)
  assert.deepEqual(await readdir(directory), [
    `${descriptor('new.md').id}.json`,
  ])
})

test('close rejects active work and skips old queued generations before respawning', async (t) => {
  const { create } = await fixture(t)
  const parser = create()
  await parser.request(parse('# ready'), current)
  const old = parser.worker
  const post = old.postMessage.bind(old)
  let submitted
  const started = new Promise((resolve) => {
    submitted = resolve
  })
  let calls = 0
  t.mock.method(old, 'postMessage', (request) => {
    calls++
    post(request)
    submitted()
  })
  const active = parser.request(parse('# active'), current)
  const rejected = assert.rejects(active, /canceled/)
  const queued = parser.request(parse('# queued'), current)
  await started
  parser.close()
  await rejected
  assert.equal(await queued, null)
  assert.equal(calls, 1)
  const replacement = await parser.request(parse('# replacement'), current)
  assert.equal(await headingFrom(parser, replacement), 'replacement')
  assert.notEqual(parser.worker, old)
})

test('cache reads reject traversal, record symlinks and namespace symlinks; drafts never persist', async (t) => {
  const { directory, create, close } = await fixture(t)
  let parser = create()
  await parser.request(parse('# saved'), current)
  const path = join(directory, `${id}.json`)
  const saved = await readFile(path, 'utf8')
  await parser.request(parse('private-draft-marker', 'draft:tab:1'), current)
  assert.equal(await readFile(path, 'utf8'), saved)
  assert.deepEqual(
    await parser.cachedBatch([{ ...descriptor(), id: '../outside' }], current),
    [null],
  )
  const outside = join(directory, 'outside.json')
  await writeFile(outside, saved)
  await rm(path)
  await symlink(outside, path)
  assert.equal(await parser.request(descriptor(), current), null)
  assert.deepEqual(await parser.cachedBatch([descriptor()], current), [null])
  await parser.beginBuild(current)
  await parser.finishBuild(current)
  assert.equal(await readFile(outside, 'utf8'), saved)
  await close(parser)
  const namespace = join(directory, 'linked-cache')
  await symlink(directory, namespace, 'dir')
  parser = create({ cacheDirectory: namespace })
  assert.equal(await parser.request(descriptor(), current), null)
  await parser.request(parse('# cannot write through link'), current)
  assert.equal((await readdir(directory)).includes(`${id}.json`), false)
})

test('cache reads reject record replacement during a fixed-buffer read', async (t) => {
  const { directory, create, close } = await fixture(t)
  const bundle = join(directory, 'cache-race.mjs')
  await writeFile(
    bundle,
    `
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
const open = fs.open
fs.open = async (...args) => {
  const file = await open(...args)
  if (String(args[0]).endsWith('.json')) {
    const read = file.read.bind(file)
    let replaced = false
    file.read = async (...parts) => {
      const result = await read(...parts)
      if (!replaced) {
        replaced = true
        await fs.rename(args[0], args[0] + '.old')
        await fs.copyFile(args[0] + '.old', args[0])
      }
      return result
    }
  }
  return file
}
syncBuiltinESMExports()
await import(${JSON.stringify(entry.href)})
`,
  )
  let parser = create({ entry: bundle })
  await parser.request(parse('# cached'), current)
  await close(parser)
  parser = create({ entry: bundle })
  assert.deepEqual(await parser.cachedBatch([descriptor()], current), [null])
})

test('main parser canonicalizes repeated property hashes and clears its pool on close', async (t) => {
  const { directory, create } = await fixture(t)
  const parser = create()
  const paths = Array.from({ length: 64 }, (_, i) => `property-${i}.md`)
  await parser.request(parse('---\nstatus: active\n---\n'), current)
  const record = await readRecord(join(directory, `${id}.json`))
  const hashes = record.page.metadata.properties.values
  assert.equal(Object.keys(hashes).length, 1)
  for (const path of paths) {
    const request = descriptor(path)
    await writeRecord(join(directory, `${request.id}.json`), {
      ...record,
      page: { ...record.page, id: request.id, path },
    })
  }
  const original = parser.propertyHashes.get.bind(parser.propertyHashes)
  let lookups = 0
  t.mock.method(parser.propertyHashes, 'get', (value) => {
    lookups++
    return original(value)
  })
  const pages = await parser.cachedBatch(paths.map(descriptor), current)
  assert.ok(
    pages.every(
      (page) =>
        JSON.stringify(page.metadata.properties.values) ===
        JSON.stringify(hashes),
    ),
  )
  assert.equal(lookups, 128)
  assert.equal(parser.propertyHashes.size, 2)
  parser.close()
  assert.equal(parser.propertyHashes.size, 0)
})

test('property hash interning stays bounded across obsolete edit values without dropping fields', async () => {
  const parser = new WorkspaceMetadataParser(() => ({ entry }))
  const key = 'a'.repeat(64)
  for (let edit = 0; edit < 8192; edit++) {
    const value = createHash('sha256').update(String(edit)).digest('hex')
    const reader = new RecordReader(parser.canonical)
    reader.write([...recordTokens({ values: { [key]: [value] } })])
    assert.deepEqual(reader.finish(), { values: { [key]: [value] } })
  }
  assert.ok(parser.propertyHashes.size <= 4096)
  await parser.close()
  assert.equal(parser.propertyHashes.size, 0)
})

const input = (path = 'note.md') => {
  const { kind, ...note } = descriptor(path)
  return { ...note, syntax }
}
const snapshot = (source) => ({
  utf16Length: source.length,
  sliceRaw: (start, end) => source.slice(start, end),
  materialize() {
    throw new Error('main must not materialize')
  },
})
async function diskInput(directory, source, path = 'input.md') {
  const nativePath = join(directory, path)
  await writeFile(nativePath, source)
  const version = diskIndexVersion(await stat(nativePath, { bigint: true }))
  return { ...input(path), nativePath, version, expectedVersion: version }
}

test('production disk reads use fixed buffers and never tokenize source on main', async (t) => {
  const { directory, create } = await fixture(t)
  const bundle = join(directory, 'fixed-reads.mjs')
  await writeFile(
    bundle,
    [
      "import fs from 'node:fs/promises'",
      "import { syncBuiltinESMExports } from 'node:module'",
      "import { parentPort } from 'node:worker_threads'",
      'const open = fs.open; let reads = 0, largest = 0',
      'fs.open = async (...args) => {',
      '  const file = await open(...args), read = file.read.bind(file)',
      '  file.read = async (buffer, offset, length, ...rest) => {',
      '    reads++; largest = Math.max(largest, buffer.length, length)',
      '    return read(buffer, offset, length, ...rest)',
      '  }; return file',
      '}',
      'syncBuiltinESMExports()',
      'const post = parentPort.postMessage.bind(parentPort)',
      'parentPort.postMessage = (message) => post({ ...message, stats: { reads, largest } })',
      `await import(${JSON.stringify(entry.href)})`,
    ].join('\n'),
  )
  const parser = create({ entry: bundle })
  const source = `${'x'.repeat(65535)}é😀\n${'body\n'.repeat(40000)}\n[[target]] #work`
  const note = await diskInput(directory, source)
  await parser.request(parse('# warm'), current)
  let stats
  const messages = []
  parser.worker.on('message', (message) => {
    stats = message.stats
  })
  const post = parser.worker.postMessage.bind(parser.worker)
  t.mock.method(parser.worker, 'postMessage', (request) => {
    messages.push(request)
    post(request)
  })
  let tokenizations = 0
  for (const method of ['match', 'matchAll', 'split', 'replace']) {
    const original = String.prototype[method]
    t.mock.method(String.prototype, method, function (...args) {
      if (String(this).startsWith('xxxxx')) tokenizations++
      return original.apply(this, args)
    })
  }
  const page = await parser.parseFile(note, current)
  assert.deepEqual(page.metadata.references.wikilinks, ['target'])
  assert.deepEqual(page.metadata.tags, ['work'])
  assert.equal(tokenizations, 0)
  assert.ok(stats.reads > 4)
  assert.equal(stats.largest, 64 * 1024)
  assert.ok(
    messages.every((message) => !('source' in message) && !('page' in message)),
  )
  assert.equal(Object.hasOwn(page, 'markdown'), false)
})

test('disk reads stop at the initial size when a note grows during every chunk', async (t) => {
  const { directory, create } = await fixture(t)
  const bundle = join(directory, 'growing-read.mjs')
  await writeFile(
    bundle,
    `
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { parentPort } from 'node:worker_threads'
const open = fs.open
let bytes = 0, reads = 0
fs.open = async (...args) => {
  const file = await open(...args)
  if (String(args[0]).endsWith('growing.md')) {
    const read = file.read.bind(file)
    file.read = async (...parts) => {
      const result = await read(...parts)
      bytes += result.bytesRead
      if (++reads <= 3) await fs.appendFile(args[0], 'appended'.repeat(10000))
      return result
    }
  }
  return file
}
syncBuiltinESMExports()
const post = parentPort.postMessage.bind(parentPort)
parentPort.postMessage = (message) => post({ ...message, stats: { bytes, reads } })
await import(${JSON.stringify(entry.href)})
`,
  )
  const parser = create({ entry: bundle })
  const source = `# before\n${'body\n'.repeat(14000)}`
  const note = await diskInput(directory, source, 'growing.md')
  await parser.request(parse('# warm'), current)
  let stats
  parser.worker.on('message', (message) => {
    stats = message.stats
  })
  assert.equal(await parser.parseFile(note, current), null)
  assert.ok(stats.bytes <= Buffer.byteLength(source))
  assert.equal(stats.reads, 2)
  assert.equal((await readdir(directory)).includes(`${note.id}.json`), false)
  const next = await diskInput(directory, '# next', 'next.md')
  assert.equal(
    await headingFrom(parser, await parser.parseFile(next, current)),
    'next',
  )
})

test('transient per-note EIO returns null, leaves no sentinel and allows the next note and retry', async (t) => {
  const { directory, create } = await fixture(t)
  const bundle = join(directory, 'eio-read.mjs')
  await writeFile(
    bundle,
    `
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
const open = fs.open
let failed = false
fs.open = async (...args) => {
  const file = await open(...args)
  if (String(args[0]).endsWith('fault.md')) {
    const read = file.read.bind(file)
    file.read = async (...parts) => {
      if (!failed) { failed = true; throw Object.assign(new Error('read fixture'), { code: 'EIO' }) }
      return read(...parts)
    }
  }
  return file
}
syncBuiltinESMExports()
await import(${JSON.stringify(entry.href)})
`,
  )
  const parser = create({ entry: bundle })
  const note = await diskInput(directory, '# retry', 'fault.md')
  const next = await diskInput(directory, '# next', 'next.md')
  await parser.beginBuild(current)
  const worker = parser.worker
  assert.equal(await parser.parseFile(note, current), null)
  assert.equal((await readdir(directory)).includes(`${note.id}.json`), false)
  assert.equal(
    await headingFrom(parser, await parser.parseFile(next, current)),
    'next',
  )
  assert.equal(parser.worker, worker)
  assert.equal(
    await headingFrom(parser, await parser.parseFile(note, current)),
    'retry',
  )
  assert.equal(await parser.finishBuild(current), true)
})

test('production disk parsing rejects stale stats, symlinks, invalid UTF-8 and mid-read changes', async (t) => {
  const { directory, create } = await fixture(t)
  const parser = create()
  const note = await diskInput(directory, `# before\n${'body\n'.repeat(40000)}`)
  assert.equal(
    await parser.parseFile({ ...note, expectedVersion: 'disk:stale' }, current),
    null,
  )
  const link = join(directory, 'symlink.md')
  await symlink(note.nativePath, link)
  assert.equal(
    await parser.parseFile({ ...note, nativePath: link }, current),
    null,
  )
  const invalid = await diskInput(
    directory,
    Buffer.from([0x23, 0x20, 0xff]),
    'invalid.md',
  )
  assert.equal(await parser.parseFile(invalid, current), null)
  let changed = false
  const post = parser.worker.postMessage.bind(parser.worker)
  t.mock.method(parser.worker, 'postMessage', (request) => {
    if (request.kind === 'parseEnd' && !changed) {
      changed = true
      writeFile(note.nativePath, '# replacement').then(() => post(request))
    } else post(request)
  })
  assert.equal(await parser.parseFile(note, current), null)
  assert.equal(changed, true)
  assert.equal(
    await headingFrom(
      parser,
      await parser.parseSource(input(), snapshot('# next'), current),
    ),
    'next',
  )
})

test('dirty sources transfer bounded UTF-16 slices serially and inspect syntax off main', async (t) => {
  const { create } = await fixture(t)
  const parser = create()
  await parser.request(parse('# warm'), current)
  const messages = []
  const post = parser.worker.postMessage.bind(parser.worker)
  t.mock.method(parser.worker, 'postMessage', (request) => {
    messages.push(request)
    post(request)
  })
  const source = `${'x'.repeat(32767)}😀\n${'body\n'.repeat(20000)}\n[[target]]`
  const slices = []
  const snap = snapshot(source)
  snap.sliceRaw = (start, end) => {
    slices.push([start, end])
    return source.slice(start, end)
  }
  const inspected = {
    ...input(),
    syntax: {
      ...syntax,
      inspect: { github: false, math: true, textExtras: false },
    },
  }
  const [page, next] = await Promise.all([
    parser.parseSource(inspected, snap, current),
    parser.parseSource(input('next.md'), snapshot('$unsupported$'), current),
  ])
  assert.deepEqual(page.metadata.references.wikilinks, ['target'])
  assert.equal(page.syntax.complete, true)
  assert.equal(next.path, 'next.md')
  assert.equal(next.syntax.complete, true)
  assert.equal(slices[0][0], 0)
  assert.equal(slices.at(-1)[1], source.length)
  assert.ok(slices.every(([start, end]) => (end - start) * 2 <= 64 * 1024))
  assert.ok(
    messages
      .filter((m) => m.kind === 'sourceChunk')
      .every((m) => m.source.length * 2 <= 64 * 1024),
  )
  const sequence = messages.map((m) => m.kind)
  const starts = sequence.flatMap((kind, i) =>
    kind === 'sourceStart' ? [i] : [],
  )
  assert.ok(sequence.indexOf('parseEnd') < starts[1])
  const unsupported = await parser.parseSource(
    inspected,
    snapshot('$unsupported$'),
    current,
  )
  assert.equal(unsupported.syntax.complete, false)
  assert.equal(unsupported.syntax.unsupported, true)
})

test('source cancellation checks every chunk, clears stale content, and close permits a fresh parse', async (t) => {
  const { create } = await fixture(t)
  const parser = create()
  let live = true,
    slices = 0
  const text = 'stale'.repeat(50000)
  const huge = snapshot(text)
  huge.sliceRaw = (start, end) => {
    if (++slices === 2) live = false
    return text.slice(start, end)
  }
  assert.equal(await parser.parseSource(input(), huge, () => live), null)
  assert.equal(slices, 2)
  assert.equal(
    await headingFrom(
      parser,
      await parser.parseSource(input(), snapshot('# fresh'), current),
    ),
    'fresh',
  )
  const old = parser.worker
  let submitted
  const started = new Promise((resolve) => {
    submitted = resolve
  })
  const post = old.postMessage.bind(old)
  t.mock.method(old, 'postMessage', (request) => {
    post(request)
    if (request.kind === 'sourceChunk') submitted()
  })
  const active = parser.parseSource(
    input(),
    snapshot('body\n'.repeat(40000)),
    current,
  )
  await started
  await parser.close()
  assert.equal(await active, null)
  const page = await parser.parseSource(
    input(),
    snapshot('# replacement'),
    current,
  )
  assert.notEqual(parser.worker, old)
  assert.equal(await headingFrom(parser, page), 'replacement')
})

test('resource failures retransfer into linear fallback and retain completed-build pruning', async (t) => {
  const { directory, create, close } = await fixture(t)
  const parser = create()
  const note = await diskInput(directory, '# disk')
  for (const [code, mode] of [
    ['ERR_WORKER_OUT_OF_MEMORY', 'file'],
    ['ERR_STRING_TOO_LONG', 'source'],
  ]) {
    await parser.beginBuild(current)
    const old = parser.worker,
      post = old.postMessage.bind(old)
    t.mock.method(old, 'postMessage', (request) => {
      if (request.kind === (mode === 'file' ? 'fileChunk' : 'sourceChunk'))
        old.emit(
          'error',
          Object.assign(new Error('resource fixture'), { code }),
        )
      else post(request)
    })
    const page =
      mode === 'file'
        ? await parser.parseFile(note, current)
        : await parser.parseSource(note, snapshot('# draft'), current)
    assert.equal(page.metadata.referenceComplete, false)
    assert.equal(
      await headingFrom(parser, page),
      mode === 'file' ? 'disk' : 'draft',
    )
    assert.equal(await parser.finishBuild(current), true)
    assert.deepEqual(
      await parser.request(
        { ...descriptor(note.path), version: note.version },
        current,
      ),
      page,
    )
    const next = await parser.parseSource(
      input('next.md'),
      snapshot('# next'),
      current,
    )
    assert.notEqual(parser.worker, old)
    assert.equal(await headingFrom(parser, next), 'next')
  }
  await close(parser)
  const reopened = create()
  assert.deepEqual(
    await reopened.cachedBatch(
      [{ ...descriptor(note.path), version: note.version }],
      current,
    ),
    [
      await parser.request(
        { ...descriptor(note.path), version: note.version },
        current,
      ),
    ],
  )
})

function failBothParsers(t, parser, code, beforeSecond) {
  let failures = 0
  const attach = (worker) => {
    const post = worker.postMessage.bind(worker)
    t.mock.method(worker, 'postMessage', (request) => {
      if (
        failures < 2 &&
        (request.kind === 'parseEnd' || request.kind === 'parse')
      ) {
        failures++
        beforeSecond?.(failures)
        worker.emit(
          'error',
          Object.assign(new Error('resource fixture'), {
            code: Array.isArray(code) ? code[failures - 1] : code,
          }),
        )
      } else post(request)
    })
    return worker
  }
  const start = parser.start.bind(parser)
  t.mock.method(parser, 'start', (...args) => attach(start(...args)))
  attach(parser.worker)
  return () => failures
}

for (const mode of ['file', 'source', 'request']) {
  test(`double resource failure persists incomplete metadata and continues for ${mode}`, async (t) => {
    const { directory, create, close } = await fixture(t)
    let parser = create()
    const note =
      mode === 'file' ? await diskInput(directory, '# resource') : input()
    await parser.beginBuild(current)
    const failures = failBothParsers(
      t,
      parser,
      mode === 'source' ? 'ERR_STRING_TOO_LONG' : 'ERR_WORKER_OUT_OF_MEMORY',
    )
    const page =
      mode === 'file'
        ? await parser.parseFile(note, current)
        : mode === 'source'
          ? await parser.parseSource(note, snapshot('# resource'), current)
          : await parser.request(parse('# resource'), current)
    const expected = incompleteMetadataPage(note)
    assert.equal(failures(), 2)
    assert.deepEqual(page, expected)
    assert.deepEqual(page.metadata.headings, {
      items: [],
      complete: false,
      count: 0,
      paged: true,
    })
    const cached = { ...descriptor(note.path), version: note.version }
    assert.deepEqual(await parser.request(cached, current), expected)
    assert.deepEqual(await parser.readHeadings(cached, 0, 10, current), {
      items: [],
      nextOffset: 0,
      hasMore: false,
      complete: false,
    })
    assert.equal(
      (await readdir(directory)).some((name) =>
        /\.h(?:idx|dat)$|\.tmp$/.test(name),
      ),
      false,
    )
    const next = await parser.parseSource(
      input('next.md'),
      snapshot('# next'),
      current,
    )
    assert.equal(await headingFrom(parser, next), 'next')
    assert.equal(await parser.finishBuild(current), true)
    await close(parser)
    parser = create()
    assert.deepEqual(await parser.cachedBatch([cached], current), [expected])
    assert.deepEqual(await parser.readHeadings(cached, 0, 10, current), {
      items: [],
      nextOffset: 0,
      hasMore: false,
      complete: false,
    })
    assert.equal(
      await parser.request({ ...cached, version: 'disk:changed' }, current),
      null,
    )
  })
}

test('double resource failure leaves draft incomplete headings transient', async (t) => {
  const { directory, create } = await fixture(t)
  const parser = create()
  const note = { ...input(), version: 'draft:1' }
  await parser.beginBuild(current)
  failBothParsers(t, parser, 'ERR_WORKER_OUT_OF_MEMORY')
  assert.deepEqual(
    await parser.parseSource(note, snapshot('private draft'), current),
    incompleteMetadataPage(note),
  )
  assert.deepEqual(
    await parser.readHeadings(
      { ...descriptor(), version: note.version },
      0,
      10,
      current,
    ),
    {
      items: [],
      nextOffset: 0,
      hasMore: false,
      complete: false,
    },
  )
  assert.deepEqual(await readdir(directory), [])
})

test('obsolete fallback resource failures return null without persisting incomplete metadata', async (t) => {
  const { directory, create } = await fixture(t)
  const parser = create()
  await parser.beginBuild(current)
  let live = true
  failBothParsers(t, parser, 'ERR_WORKER_OUT_OF_MEMORY', (failure) => {
    if (failure === 2) live = false
  })
  assert.equal(
    await parser.parseSource(input(), snapshot('# obsolete'), () => live),
    null,
  )
  assert.deepEqual(await readdir(directory), [])
  assert.equal(
    (await parser.parseSource(input('next.md'), snapshot('# next'), current))
      .metadata.headings.count,
    1,
  )
})

test('fallback program and startup errors propagate without incomplete records', async (t) => {
  const { directory, create } = await fixture(t)
  const broken = join(directory, 'broken-fallback.mjs')
  await writeFile(
    broken,
    "throw Object.assign(new Error('startup fixture'), { code: 'ERR_WORKER_OUT_OF_MEMORY' })",
  )
  for (const startup of [false, true]) {
    const options = { entry }
    const parser = create(options)
    await parser.beginBuild(current)
    failBothParsers(
      t,
      parser,
      ['ERR_WORKER_OUT_OF_MEMORY', 'ERR_FIXTURE_PROGRAM'],
      (failure) => {
        if (startup && failure === 1) options.entry = broken
      },
    )
    await assert.rejects(
      parser.parseSource(input(), snapshot('# fault'), current),
      (error) =>
        error.code ===
          (startup ? 'ERR_WORKER_OUT_OF_MEMORY' : 'ERR_FIXTURE_PROGRAM') &&
        error.metadataWorkerReady === !startup,
    )
    assert.equal((await readdir(directory)).includes(`${id}.json`), false)
    t.mock.restoreAll()
    options.entry = entry
    assert.equal(
      (await parser.parseSource(input('next.md'), snapshot('# next'), current))
        .metadata.headings.count,
      1,
    )
  }
})

for (const mode of ['stale', 'EIO']) {
  test(`double resource failure never persists an incomplete file after ${mode}`, async (t) => {
    const { directory, create } = await fixture(t)
    const { writeFileSync } = await import('node:fs')
    const note = await diskInput(directory, '# resource')
    const flag = join(directory, 'fault-flag')
    const bundle = join(directory, 'incomplete-stat.mjs')
    await writeFile(
      bundle,
      `
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
const lstat = fs.lstat
fs.lstat = async (path, ...args) => {
  if (String(path) === ${JSON.stringify(note.nativePath)} && existsSync(${JSON.stringify(flag)}))
    throw Object.assign(new Error('stat fixture'), { code: 'EIO' })
  return lstat(path, ...args)
}
syncBuiltinESMExports()
await import(${JSON.stringify(entry.href)})
`,
    )
    const parser = create({ entry: bundle })
    await parser.beginBuild(current)
    failBothParsers(t, parser, 'ERR_WORKER_OUT_OF_MEMORY', (failure) => {
      if (failure !== 2) return
      if (mode === 'stale') writeFileSync(note.nativePath, '# changed')
      else writeFileSync(flag, '')
    })
    assert.equal(await parser.parseFile(note, current), null)
    assert.equal((await readdir(directory)).includes(`${note.id}.json`), false)
    assert.equal(
      (await parser.parseSource(input('next.md'), snapshot('# next'), current))
        .metadata.headings.count,
      1,
    )
  })
}

test('cache resource failures are misses; critical worker program errors propagate', async (t) => {
  const { create, directory } = await fixture(t)
  const parser = create()
  for (const batch of [true, false]) {
    await parser.request(parse('# warm'), current)
    const worker = parser.worker,
      post = worker.postMessage.bind(worker)
    t.mock.method(worker, 'postMessage', (request) => {
      if (request.kind === 'cachedBatch' || request.kind === 'cached')
        worker.emit(
          'error',
          Object.assign(new Error('cache resource fixture'), {
            code: 'ERR_WORKER_OUT_OF_MEMORY',
          }),
        )
      else post(request)
    })
    assert.deepEqual(
      batch
        ? await parser.cachedBatch([descriptor()], current)
        : await parser.request(descriptor(), current),
      batch ? [null] : null,
    )
    assert.ok(await parser.parseSource(input(), snapshot('# next'), current))
  }
  const broken = create({
    entry: join(directory, 'missing-worker.mjs'),
    appVersion: undefined,
  })
  await assert.rejects(
    broken.parseSource(input(), snapshot('# note'), current),
    (error) =>
      error.code === 'MODULE_NOT_FOUND' ||
      error.code === 'ERR_MODULE_NOT_FOUND',
  )
})

test('disk cancellation stops after one fixed-buffer chunk and releases file state', async (t) => {
  const { directory, create } = await fixture(t)
  const parser = create()
  const note = await diskInput(directory, 'body\n'.repeat(40000))
  await parser.request(parse('# warm'), current)
  let live = true,
    reads = 0
  const post = parser.worker.postMessage.bind(parser.worker)
  t.mock.method(parser.worker, 'postMessage', (request) => {
    if (request.kind === 'fileChunk') {
      reads++
      parser.worker.once('message', () => {
        live = false
      })
    }
    post(request)
  })
  assert.equal(await parser.parseFile(note, () => live), null)
  assert.equal(reads, 1)
  assert.ok(await parser.parseSource(input(), snapshot('# next'), current))
})

test('worker-side string join failure uses linear chunks and next file succeeds', async (t) => {
  const { directory, create } = await fixture(t)
  const bundle = join(directory, 'string-limit.mjs')
  await writeFile(
    bundle,
    [
      `await import(${JSON.stringify(entry.href)})`,
      'const join = Array.prototype.join; let failed = false',
      'Array.prototype.join = function (...args) {',
      "  if (!failed && this[0] === 'string-limit-fixture') { failed = true; throw new RangeError('Invalid string length') }",
      '  return join.apply(this, args)',
      '}',
    ].join('\n'),
  )
  const parser = create({ entry: bundle })
  await parser.request(parse('# warm'), current)
  const old = parser.worker
  const page = await parser.parseSource(
    input(),
    snapshot('string-limit-fixture'),
    current,
  )
  assert.equal(page.metadata.referenceComplete, false)
  assert.deepEqual(page.metadata.headings.items, [])
  const next = await diskInput(directory, '# recovered')
  assert.equal(
    await headingFrom(parser, await parser.parseFile(next, current)),
    'recovered',
  )
  assert.equal(parser.worker, old)
  assert.deepEqual(await parser.request(descriptor(), current), page)
})

test('pruning keeps ids only in main and exchanges at most 64 explicit cache names', async (t) => {
  const { directory, create } = await fixture(t)
  const parser = create()
  const paths = Array.from({ length: 129 }, (_, i) => `prune-${i}.md`)
  await seed(parser, directory, paths)
  await parser.beginBuild(current)
  const worker = parser.worker,
    requests = [],
    replies = []
  const post = worker.postMessage.bind(worker)
  worker.on('message', (message) => {
    if (message.value?.names) replies.push(message.value.names)
  })
  t.mock.method(worker, 'postMessage', (request) => {
    requests.push(request)
    post(request)
  })
  for (let start = 0; start < paths.length; start += 64)
    await parser.markSeen(
      paths.slice(start, start + 64).map((path) => descriptor(path).id),
      current,
    )
  assert.equal(requests.length, 0)
  assert.equal(parser.seen.size, 129)
  assert.equal(await parser.finishBuild(current), true)
  assert.ok(
    requests.every((r) => r.kind === 'finishBuild' && r.remove.length <= 64),
  )
  assert.ok(replies.every((names) => names.length <= 64))
  assert.equal((await readdir(directory)).length, 129)
  assert.doesNotMatch(await readFile(entry, 'utf8'), /\bnew Set\b|\bmarkSeen\b/)
  assert.equal(parser.seen, undefined)
})

function boundedDrain(t, parser) {
  let writes = 0,
    turns = 0,
    ready = true,
    replies = 0,
    largest = 0
  const write = RecordReader.prototype.write
  t.mock.method(RecordReader.prototype, 'write', function (tokens) {
    assert.ok(tokens.length <= 256)
    assert.equal(
      ready,
      true,
      'reconstruction and interning yield between bounded groups',
    )
    ready = false
    setImmediate(() => {
      ready = true
      turns++
    })
    writes++
    return write.call(this, tokens)
  })
  parser.worker.on('message', (message) => {
    if (!message.value?.tokens) return
    replies++
    const bytes = Buffer.byteLength(JSON.stringify(message.value))
    largest = Math.max(largest, bytes)
    assert.ok(bytes <= recordSliceBytes)
    assert.ok(message.value.tokens.length <= recordSliceTokens)
    const characters = message.value.tokens.reduce(
      (sum, token) => sum + (Array.isArray(token) ? token[0].length : 1),
      0,
    )
    assert.ok(characters <= recordSliceCharacters)
  })
  return () => ({ writes, turns, replies, largest })
}

test('heading-dense results keep cold and warm metadata bounded while paging sidecars', async (t) => {
  const { directory, create, close } = await fixture(t)
  const bundle = join(directory, 'dense-headings.mjs')
  const count = 65536
  // Same result shape as the 4,194,304-heading report. Longer labels cross the
  // old 32 MiB cache boundary while keeping the fixture's object heap small.
  await writeFile(
    bundle,
    `
import { Marked } from ${JSON.stringify(import.meta.resolve('marked'))}
const walk = Marked.prototype.walkTokens
Marked.prototype.walkTokens = function (tokens, callback) {
  if (!tokens[0]?.raw?.startsWith('stream-headings-fixture')) return walk.call(this, tokens, callback)
  for (let i = 0; i < ${count}; i++) callback({ type: 'heading', depth: i % 6 + 1, tokens: [{ type: 'text', text: 'h'.repeat(512) }] })
  return []
}
await import(${JSON.stringify(entry.href)})
`,
  )
  let parser = create({ entry: bundle })
  await parser.request(parse('# warm'), current)
  const stats = boundedDrain(t, parser)
  const page = await parser.parseSource(
    input(),
    snapshot('stream-headings-fixture'),
    current,
  )
  assert.equal(page.metadata.headings.complete, true)
  assert.equal(page.metadata.headings.count, count)
  assert.deepEqual(page.metadata.headings.items, [])
  assert.ok((await stat(join(directory, `${id}.json`))).size < 4096)
  assert.ok(stats().replies < 4)
  assert.ok(stats().writes < 32)
  assert.equal(stats().writes, stats().turns)
  await close(parser)
  parser = create({ entry: bundle })
  const [cached] = await parser.cachedBatch([descriptor()], current)
  assert.equal(cached.metadata.headings.count, count)
  assert.deepEqual(cached.metadata.headings.items, [])
  const tail = await parser.readHeadings(descriptor(), count - 1, 1, current)
  assert.deepEqual(tail, {
    items: [{ depth: ((count - 1) % 6) + 1, text: 'h'.repeat(512) }],
    nextOffset: count,
    hasMore: false,
    complete: true,
  })
  assert.equal(stats().writes, stats().turns)
})

test('oversized single strings split on wire and main; cancellation during drain drops stale results', async (t) => {
  const { directory, create } = await fixture(t)
  const parser = create()
  const template = await seed(parser, directory, [])
  const text = `x${'\u0000é😀'.repeat(1024 * 1024)}`
  await writeRecord(join(directory, `${id}.json`), {
    ...template,
    page: {
      ...template.page,
      metadata: {
        ...template.page.metadata,
        tags: [text],
      },
    },
  })
  const stats = boundedDrain(t, parser)
  const [page] = await parser.cachedBatch([descriptor()], current)
  assert.equal(page.metadata.tags[0], text)
  assert.ok(stats().replies > 100)
  assert.equal(stats().writes, stats().turns)
  let live = true
  parser.worker.once('message', () => {
    live = false
  })
  assert.deepEqual(await parser.cachedBatch([descriptor()], () => live), [null])
  assert.equal(
    (await parser.parseSource(input('next.md'), snapshot('# next'), current))
      .path,
    'next.md',
  )
})

test('deep-blockquote fallback persists by version and bundle, reopen, continue and prune', async (t) => {
  const { directory, create, close } = await fixture(t)
  let parser = create()
  await seed(parser, directory, ['removed.md'])
  const note = await diskInput(directory, `${'> '.repeat(100000)}deep`)
  await parser.beginBuild(current)
  const page = await parser.parseFile(note, current)
  assert.equal(page.metadata.referenceComplete, false)
  assert.deepEqual(page.metadata.headings.items, [])
  assert.equal(
    (await parser.parseSource(input('next.md'), snapshot('# next'), current))
      .path,
    'next.md',
  )
  assert.equal(await parser.finishBuild(current), true)
  assert.deepEqual(
    (await readdir(directory)).filter((name) => name.endsWith('.json')).sort(),
    [note.id, descriptor('next.md').id].map((id) => `${id}.json`).sort(),
  )
  await close(parser)
  parser = create()
  const cached = { ...descriptor(note.path), version: note.version }
  assert.deepEqual(await parser.cachedBatch([cached], current), [page])
  assert.equal(
    await parser.request({ ...cached, version: 'disk:changed' }, current),
    null,
  )
  await close(parser)
  parser = create({ appVersion: '2.0.0' })
  assert.equal(await parser.request(cached, current), null)
})

test('parse-only watchdog retransfers into fallback, persists derived data and keeps pruning after respawn', async (t) => {
  const { directory, create, close } = await fixture(t)
  const bundle = join(directory, 'watchdog.mjs')
  await writeFile(
    bundle,
    `
import { Marked } from ${JSON.stringify(import.meta.resolve('marked'))}
const lex = Marked.prototype.lexer
Marked.prototype.lexer = function (source, ...args) {
  if (source.startsWith('watchdog-fixture')) { while (true) {} }
  return lex.call(this, source, ...args)
}
await import(${JSON.stringify(entry.href)})
`,
  )
  let parser = create({ entry: bundle, watchdogMs: 1000 })
  await seed(parser, directory, ['removed.md'])
  await parser.beginBuild(current)
  const old = parser.worker
  const page = await parser.parseSource(
    input(),
    snapshot('watchdog-fixture\n# recovered\n[[target]] #work'),
    current,
  )
  assert.equal(page.metadata.referenceComplete, false)
  assert.deepEqual(page.metadata.references.wikilinks, ['target'])
  assert.deepEqual(page.metadata.tags, ['work'])
  assert.equal(await headingFrom(parser, page), 'recovered')
  assert.notEqual(parser.worker, old)
  assert.equal(
    (await parser.parseSource(input('next.md'), snapshot('# next'), current))
      .path,
    'next.md',
  )
  assert.equal(await parser.finishBuild(current), true)
  assert.deepEqual(
    (await readdir(directory)).filter((name) => name.endsWith('.json')).sort(),
    [id, descriptor('next.md').id].map((id) => `${id}.json`).sort(),
  )
  await close(parser)
  parser = create({ entry: bundle })
  assert.deepEqual(await parser.request(descriptor(), current), page)
  await close(parser)
  await appendFile(bundle, '\n// rebuilt\n')
  parser = create({ entry: bundle })
  assert.equal(await parser.request(descriptor(), current), null)
})

test('worker module load failures never become per-note incomplete records', async (t) => {
  const { directory, create } = await fixture(t)
  const bundle = join(directory, 'invalid-program.mjs')
  await writeFile(
    bundle,
    "throw Object.assign(new RangeError('Invalid string length'), { code: 'ERR_STRING_TOO_LONG' })",
  )
  const parser = create({ entry: bundle })
  await assert.rejects(
    parser.parseSource(input(), snapshot('# next'), current),
    { code: 'ERR_STRING_TOO_LONG' },
  )
  assert.equal((await readdir(directory)).includes(`${id}.json`), false)
})

test('worker whose request became obsolete during startup does not keep node alive', async () => {
  const source = `import { WorkspaceMetadataParser } from ${JSON.stringify(new URL('../src/main/workspace-metadata-parser.ts', import.meta.url).href)};\nconst parser = new WorkspaceMetadataParser(() => ({entry: new URL(${JSON.stringify(entry.href)})}));\nlet checks = 0; const result = await parser.request(${JSON.stringify(descriptor())}, () => ++checks < 4); if (result !== null) throw new Error('expected obsolete request');\n`
  await promisify(execFile)(process.execPath, ['-e', source], {
    timeout: 10000,
  })
})

test('idle metadata worker does not keep the node process alive', async () => {
  const source = `import { WorkspaceMetadataParser } from ${JSON.stringify(new URL('../src/main/workspace-metadata-parser.ts', import.meta.url).href)};\nconst parser = new WorkspaceMetadataParser(() => ({entry: new URL(${JSON.stringify(entry.href)})}));\nawait parser.request(${JSON.stringify(parse('# idle'))}, () => true);\n`
  await promisify(execFile)(process.execPath, ['-e', source], {
    timeout: 10000,
  })
})
