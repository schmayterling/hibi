import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

const bundle = await build({
  stdin: {
    contents:
      "export { readMarkdownChunks, writeMarkdown, writeText } from './src/main/files.ts'; export { createDocumentTransfers } from './src/main/document-transfer.ts'; export { documentSources } from './src/main/document.ts'; export { SourceStore } from './src/shared/source-buffer.ts'",
    resolveDir: resolve('.'),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
})
const module = { exports: {} },
  require = createRequire(import.meta.url)
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  (id) =>
    id === 'electron' ? { app: { getPath: () => tmpdir() } } : require(id),
  module,
  module.exports,
)
const {
  readMarkdownChunks,
  writeMarkdown,
  writeText,
  createDocumentTransfers,
  documentSources,
  SourceStore,
} = module.exports

test('native document replies transfer snapshots without reading whole source getters', () => {
  const store = new SourceStore(
      'one\r\n😀'.repeat(20000),
      { tabId: 'a', revision: 2 },
      4,
    ),
    snapshot = store.snapshot()
  let current = true
  const document = {
    tabId: 'a',
    revision: 2,
    contentVersion: 4,
    tabs: [],
    tabsEnabled: true,
    id: 'file',
    ephemeral: false,
    name: 'a.md',
    dirty: false,
    canAutosave: true,
    get markdown() {
      return assert.fail('whole source getter crossed ipc')
    },
    get savedMarkdown() {
      return assert.fail('whole saved getter crossed ipc')
    },
  }
  documentSources.set(document, {
    current: snapshot,
    saved: snapshot,
    owns: () => current,
  })
  const streams = createDocumentTransfers(),
    wire = streams.encode(1, { document }).document
  assert.equal(wire.documentTransfer.length, snapshot.utf16Length)
  assert.equal('markdown' in wire, false)
  let sequence = 0,
    length = 0
  for (;;) {
    const chunk = streams.read(1, {
      streamId: wire.documentTransfer.streamId,
      sequence: sequence++,
    })
    const units = chunk.chunks.reduce((sum, text) => sum + text.length, 0)
    assert.ok(units <= 65536)
    length += units
    if (chunk.done) break
  }
  assert.equal(length, snapshot.utf16Length)
  assert.deepEqual(
    streams.finish(1, { streamId: wire.documentTransfer.streamId, sequence }),
    { tabId: 'a', revision: 2, contentVersion: 4 },
  )
  const next = streams.encode(1, document)
  assert.throws(
    () =>
      streams.read(2, {
        streamId: next.documentTransfer.streamId,
        sequence: 0,
      }),
    /stale|order/,
  )
  current = false
  assert.throws(
    () =>
      streams.read(1, {
        streamId: next.documentTransfer.streamId,
        sequence: 0,
      }),
    /changed during transfer/,
  )
  assert.equal(store.counters().materializations, 0)
})

test('50 mib and nonascii 20 mib read and atomic save stay exact with bounded chunks', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'hibi-document-transfer-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  for (const [name, text] of [
    ['ascii', 'a'.repeat(50 * 1024 * 1024)],
    ['unicode', '\uFEFF中😀\r\n'.repeat(2 * 1024 * 1024)],
  ]) {
    assert.ok(Buffer.byteLength(text) >= 20 * 1024 * 1024)
    const path = join(root, `${name}.md`)
    await fs.writeFile(path, text)
    let maxUnits = 0
    const chunks = async function* () {
      for await (const chunk of readMarkdownChunks(path)) {
        maxUnits = Math.max(maxUnits, chunk.length)
        yield chunk
      }
    }
    const store = await SourceStore.load(chunks(), { tabId: 'a', revision: 0 })
    assert.ok(maxUnits <= 65536)
    const before = store.snapshot()
    store.commit(
      store.prepare({
        document: before.document,
        operationId: 'edit',
        historyGroup: 'typing',
        origin: 'source',
        baseVersion: 0,
        contentVersion: 1,
        changes: [{ from: 1, to: 1, insert: 'edit😀\r\n' }],
      }),
    )
    await writeMarkdown(path, store.snapshot())
    assert.deepEqual(
      await fs.readFile(path),
      Buffer.from(`${text.slice(0, 1)}edit😀\r\n${text.slice(1)}`),
    )
    assert.equal(store.counters().materializations, 0)
    assert.deepEqual(
      (await fs.readdir(root)).filter((name) => name.endsWith('.tmp')),
      [],
    )
  }
})

test('a failed streaming save keeps original file and removes partial staging file', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'hibi-document-save-')),
    path = join(root, 'note.md')
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.writeFile(path, 'original')
  const broken = async function* () {
    yield Buffer.from('partial')
    throw new Error('read failed')
  }
  await assert.rejects(writeText(path, broken()), /read failed/)
  assert.equal(await fs.readFile(path, 'utf8'), 'original')
  assert.deepEqual(await fs.readdir(root), ['note.md'])
})

test('fatal streamed utf8 decoding preserves bom and rejects incomplete characters', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'hibi-document-utf8-')),
    path = join(root, 'note.md')
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const text = `\uFEFF${'x'.repeat(65531)}😀\r\nend`
  await fs.writeFile(path, text)
  let read = ''
  for await (const chunk of readMarkdownChunks(path)) read += chunk
  assert.equal(read, text)
  await fs.writeFile(path, Buffer.from([0xef, 0xbb, 0xbf, 0xf0, 0x9f]))
  await assert.rejects(async () => {
    for await (const chunk of readMarkdownChunks(path))
      assert.equal(chunk, '\uFEFF')
  })
})

test('a held save reply keeps its immutable snapshot while newer edits and reads proceed', () => {
  const store = new SourceStore('saved source', { tabId: 'a', revision: 2 }, 4),
    saved = store.snapshot()
  const state = {
    tabId: 'a',
    revision: 2,
    contentVersion: 4,
    tabs: [],
    tabsEnabled: true,
    id: 'file',
    ephemeral: false,
    name: 'a.md',
    dirty: false,
    canAutosave: true,
  }
  documentSources.set(state, {
    current: saved,
    saved,
    owns: () => store.ownsCurrentSnapshot(saved),
    live: () => true,
  })
  const streams = createDocumentTransfers(),
    receipt = streams.encode(1, state, true)
  store.commit(
    store.prepare({
      document: saved.document,
      operationId: 'typing',
      historyGroup: 'typing',
      origin: 'source',
      baseVersion: 4,
      contentVersion: 5,
      changes: [{ from: 12, to: 12, insert: ' newer' }],
    }),
  )
  const next = { ...state, contentVersion: 5, dirty: true },
    current = store.snapshot()
  documentSources.set(next, {
    current,
    saved,
    owns: () => store.ownsCurrentSnapshot(current),
    live: () => true,
  })
  streams.encode(1, next)
  assert.equal(receipt.saveReceipt, true)
  assert.equal(receipt.savedVersion, 4)
  assert.equal('documentTransfer' in receipt, false)
  assert.equal('markdown' in receipt, false)
  assert.equal(saved.sliceRaw(0, 12), 'saved source')
  assert.equal(store.snapshot().sliceRaw(0, 18), 'saved source newer')
})

test('snapshot forks keep saved generations without a document scan or copying indexes', () => {
  const store = new SourceStore(
      'a\r\n😀b'.repeat(20000),
      { tabId: 'a', revision: 2 },
      4,
      { fanout: 4, leafCapacity: 4, chunkUnits: 16 },
    ),
    saved = store.snapshot()
  const restored = SourceStore.fromSnapshot(
    saved,
    { tabId: 'a', revision: 3 },
    5,
  )
  assert.equal(restored.snapshot().sharesRoot(saved), true)
  assert.equal(restored.counters().unitsScanned, 0)
  assert.equal(restored.counters().sourceUnitsRead, 0)
  assert.deepEqual(restored.inspect().problems, [])
  restored.commit(
    restored.prepare({
      document: restored.snapshot().document,
      operationId: 'fork',
      historyGroup: 'fork',
      origin: 'source',
      baseVersion: 5,
      contentVersion: 6,
      changes: [{ from: 0, to: 1, insert: 'new' }],
    }),
  )
  assert.equal(saved.sliceRaw(0, 1), 'a')
  assert.equal(restored.snapshot().sliceRaw(0, 3), 'new')
})

test('acknowledged source replies use metadata and saves use a version receipt without source reads', () => {
  const store = new SourceStore(
    'kept source',
    { tabId: 'meta', revision: 1 },
    7,
  )
  const source = store.snapshot()
  const document = {
    tabId: 'meta',
    revision: 1,
    contentVersion: 7,
    tabs: [],
    tabsEnabled: true,
    id: 'file',
    name: 'meta.md',
    dirty: false,
    ephemeral: false,
    canAutosave: true,
    get markdown() {
      return assert.fail('metadata read source')
    },
    get savedMarkdown() {
      return assert.fail('receipt read saved source')
    },
  }
  documentSources.set(document, {
    store,
    current: source,
    saved: source,
    owns: () => true,
    live: () => true,
  })
  const streams = createDocumentTransfers()
  const wire = streams.encode(1, document)
  assert.equal(wire.replaced, true)
  let sequence = 0
  while (
    !streams.read(1, {
      streamId: wire.documentTransfer.streamId,
      sequence: sequence++,
    }).done
  ) {}
  streams.finish(1, { streamId: wire.documentTransfer.streamId, sequence })
  const metadata = streams.encode(1, document)
  assert.equal(metadata.documentMetadata, true)
  assert.equal(metadata.sourceId, wire.sourceId)
  assert.ok(typeof metadata.sourceId === 'string')
  assert.equal(metadata.replaced, false)
  assert.equal('documentTransfer' in metadata, false)
  const receipt = streams.encode(1, document, true)
  assert.equal(receipt.saveReceipt, true)
  assert.equal(receipt.savedVersion, 7)
  assert.equal('documentTransfer' in receipt, false)
  assert.equal('markdown' in receipt, false)
  assert.equal(store.counters().materializations, 0)
  assert.ok(streams.encode(2, document).documentTransfer)
  assert.ok(streams.encode(1, document, false, true).documentTransfer)
  streams.clear()
})
