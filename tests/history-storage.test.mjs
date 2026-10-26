import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import { SourceStore } from '../src/shared/source-buffer.ts'

const mib = 1024 * 1024
const bundle = build({
  entryPoints: ['src/main/history.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  external: ['electron'],
  format: 'cjs',
})
async function runtime(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'hibi-history-storage-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const file = join(root, 'note.md')
  const folder = join(
    root,
    'history',
    createHash('sha256').update(file).digest('hex'),
  )
  const state = { copies: 0, syncs: 0, reads: 0, bytesRead: 0, yields: 0 }
  const mocks = {
    electron: { app: { getPath: () => root } },
    'node:fs/promises': {
      ...fs,
      open: async (path, ...args) => {
        const handle = await fs.open(path, ...args)
        if (String(path).startsWith(folder)) {
          if (String(path).endsWith('.tmp')) {
            if (!String(path).includes('.index.json.')) state.copies++
            const sync = handle.sync.bind(handle)
            handle.sync = async () => {
              state.syncs++
              return sync()
            }
          }
          if (String(path).endsWith('.md')) {
            const read = handle.read.bind(handle)
            handle.read = async (...args) => {
              state.reads++
              const result = await read(...args)
              state.bytesRead += result.bytesRead
              return result
            }
          }
        }
        return handle
      },
    },
  }
  const module = { exports: {} }
  const require = createRequire(import.meta.url)
  new Function(
    'require',
    'module',
    'exports',
    'setImmediate',
    (await bundle).outputFiles[0].text,
  )(
    (id) => mocks[id] ?? require(id),
    module,
    module.exports,
    (callback) => {
      state.yields++
      return setImmediate(callback)
    },
  )
  return { api: module.exports, state, root, file, folder }
}

function snapshot(bytes, suffix = '') {
  const loader = SourceStore.loader({ tabId: 'history', revision: 0 })
  const chunk = 'x'.repeat(65536)
  for (let left = bytes - suffix.length; left > 0; left -= chunk.length)
    loader.append(chunk.slice(0, Math.min(left, chunk.length)))
  loader.append(suffix)
  const store = loader.finish()
  return { store, source: store.snapshot() }
}

async function savedEquals(api, file, version, source) {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of api.readVersionChunks(file, version.id)) {
    assert.ok(chunk.length <= 65536)
    hash.update(chunk)
    bytes += Buffer.byteLength(chunk)
  }
  const expected = createHash('sha256')
  for (const chunk of source.encodedChunks()) expected.update(chunk)
  assert.equal(hash.digest('hex'), expected.digest('hex'))
  assert.equal(bytes, source.utf8Bytes)
}

test('oversized repeated saves retain newest and distinct previous without duplicate copies', async (t) => {
  const { api, state, file, folder } = await runtime(t)
  const first = snapshot(20 * mib + 1, 'a')
  const second = snapshot(20 * mib + 1, 'b')
  const third = snapshot(20 * mib + 1, 'c')
  await api.recordVersions(file, [first.source, second.source])
  let versions = await api.listVersions(file)
  assert.equal(versions.length, 2)
  const firstId = versions[1].id
  const secondId = versions[0].id
  await savedEquals(api, file, versions[0], second.source)
  await savedEquals(api, file, versions[1], first.source)
  assert.equal(state.copies, 2)
  const syncs = state.syncs
  await api.recordVersions(file, [second.source, second.source])
  assert.equal(state.copies, 2)
  assert.equal(state.syncs, syncs)
  assert.deepEqual(await api.listVersions(file), versions)
  await api.recordVersions(file, [second.source, third.source])
  versions = await api.listVersions(file)
  assert.equal(versions.length, 2)
  assert.equal(versions[1].id, secondId)
  assert.equal(state.copies, 3)
  await savedEquals(api, file, versions[0], third.source)
  await savedEquals(api, file, versions[1], second.source)
  await assert.rejects(fs.stat(join(folder, `${firstId}.md`)), {
    code: 'ENOENT',
  })
  assert.deepEqual(
    (await fs.readdir(folder)).sort(),
    ['index.json', ...versions.map(({ id }) => `${id}.md`)].sort(),
  )
  assert.ok(state.yields >= Math.floor((3 * (20 * mib + 1)) / 65536))
  for (const { store } of [first, second, third])
    assert.equal(store.counters().materializations, 0)
})

test('history prunes to its budgets while retaining one distinct predecessor', async (t) => {
  const { api, file } = await runtime(t)
  await api.recordVersions(
    file,
    Array.from({ length: 102 }, (_, n) => `save ${n}`),
  )
  let versions = await api.listVersions(file)
  assert.equal(versions.length, 100)
  assert.equal(await api.previewVersion(file, versions[0].id), 'save 101')
  assert.equal(await api.previewVersion(file, versions[99].id), 'save 2')
  const large = join(resolve(file, '..'), 'budget.md')
  await api.recordVersions(large, [
    snapshot(8 * mib, 'a').source,
    snapshot(8 * mib, 'b').source,
    snapshot(8 * mib, 'c').source,
  ])
  versions = await api.listVersions(large)
  assert.equal(versions.length, 2)
  assert.equal(
    versions.reduce((sum, version) => sum + version.bytes, 0),
    16 * mib,
  )
  await api.recordVersions(large, [
    snapshot(12 * mib, 'a').source,
    snapshot(12 * mib, 'b').source,
  ])
  assert.equal((await api.listVersions(large)).length, 2)
})

test('oversized preview rejects before reading saved data and explains restore remains available', async (t) => {
  const { api, file, state } = await runtime(t)
  await api.recordVersions(file, ['x'.repeat(2 * mib + 1)])
  const [version] = await api.listVersions(file)
  await assert.rejects(
    api.previewVersion(file, version.id),
    /too large to preview.*still restore/i,
  )
  assert.equal(state.reads, 0)
  assert.equal(state.bytesRead, 0)
})

test('legacy preview accepts exact 2 mib and preserves BOM, CRLF and unicode', async (t) => {
  const { api, file } = await runtime(t)
  const prefix = '\ufeff中😀\r\n'
  const text = prefix + 'x'.repeat(2 * mib - Buffer.byteLength(prefix))
  await api.recordVersions(file, [text])
  const [version] = await api.listVersions(file)
  assert.equal(version.bytes, 2 * mib)
  assert.equal(await api.previewVersion(file, version.id), text)
})

test('saved-version chunks restore exact 50 mib through source loader without materialization', async (t) => {
  const { api, file, state, root } = await runtime(t)
  const prefix = '\ufeff中😀\r\n'
  const suffix = '\r\nend😀'
  const loader = SourceStore.loader({ tabId: 'saved', revision: 0 })
  loader.append(prefix)
  const chunk = 'x'.repeat(65536)
  let left = 50 * mib - Buffer.byteLength(prefix + suffix)
  while (left > 0) {
    loader.append(chunk.slice(0, Math.min(left, chunk.length)))
    left -= chunk.length
  }
  loader.append(suffix)
  const source = loader.finish()
  await api.recordVersions(file, [source.snapshot()])
  const [version] = await api.listVersions(file)
  let chunks = 0
  async function* observed() {
    for await (const chunk of api.readVersionChunks(file, version.id)) {
      chunks++
      assert.ok(chunk.length <= 65536)
      yield chunk
    }
  }
  const restored = await SourceStore.load(
    observed(),
    { tabId: 'restored', revision: 2 },
    7,
  )
  assert.equal(restored.snapshot().utf8Bytes, 50 * mib)
  assert.equal(restored.snapshot().sliceRaw(0, prefix.length), prefix)
  assert.equal(
    restored
      .snapshot()
      .sliceRaw(
        restored.snapshot().utf16Length - suffix.length,
        restored.snapshot().utf16Length,
      ),
    suffix,
  )
  assert.ok(chunks >= (50 * mib) / 65536)
  assert.equal(state.bytesRead, 50 * mib)
  const hash = (snapshot) => {
    const digest = createHash('sha256')
    for (const chunk of snapshot.encodedChunks()) digest.update(chunk)
    return digest.digest('hex')
  }
  assert.equal(hash(restored.snapshot()), hash(source.snapshot()))
  assert.equal(source.counters().materializations, 0)
  assert.equal(restored.counters().materializations, 0)
  assert.equal(restored.counters().maxLoadInputUnits, 65536)
  assert.deepEqual(await fs.readdir(root), ['history'])
})

test('both saved reads reject invalid ids and ids absent from this document before data reads', async (t) => {
  const { api, file, state } = await runtime(t)
  await api.recordVersions(file, ['saved'])
  const [version] = await api.listVersions(file)
  const consume = async (path, id) => {
    for await (const _chunk of api.readVersionChunks(path, id)) {
    }
  }
  for (const read of [api.previewVersion, consume])
    for (const [path, id] of [
      [file, '../../note.md'],
      [file, `${version.id}\n`],
      [file, version.id.toUpperCase()],
      [file, randomUUID()],
      [file, null],
      [file, {}],
      [null, version.id],
      [`${file}.other`, version.id],
    ])
      await assert.rejects(
        read(path, id),
        /This saved version is no longer available\./,
      )
  assert.equal(state.reads, 0)
})

test('both saved reads reject malformed ids even when indexed with an existing file', async (t) => {
  const { api, file, folder, state } = await runtime(t)
  await fs.mkdir(folder, { recursive: true })
  const id = 'a'.repeat(36)
  await fs.writeFile(
    join(folder, 'index.json'),
    JSON.stringify([
      {
        id,
        bytes: 5,
        savedAt: 0,
        hash: createHash('sha256').update('saved').digest('hex'),
      },
    ]),
  )
  await fs.writeFile(join(folder, `${id}.md`), 'saved')
  await assert.rejects(
    api.previewVersion(file, id),
    /This saved version is no longer available\./,
  )
  await assert.rejects(async () => {
    for await (const _chunk of api.readVersionChunks(file, id)) {
    }
  }, /This saved version is no longer available\./)
  assert.equal(state.reads, 0)
})
