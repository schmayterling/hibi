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
  const state = {
    copies: 0,
    syncs: 0,
    folderSyncs: 0,
    reads: 0,
    bytesRead: 0,
    yields: 0,
    indexReadErrors: [],
  }
  const mocks = {
    electron: { app: { getPath: () => root } },
    'node:fs/promises': {
      ...fs,
      readFile: async (path, ...args) => {
        const code =
          String(path) === join(folder, 'index.json') &&
          state.indexReadErrors.shift()
        if (code) throw Object.assign(new Error(`${code}: injected`), { code })
        return fs.readFile(path, ...args)
      },
      open: async (path, ...args) => {
        const handle = await fs.open(path, ...args)
        if (String(path) === folder) {
          const sync = handle.sync.bind(handle)
          handle.sync = async () => {
            state.folderSyncs++
            return sync()
          }
        }
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

test('prewrite history reuses any matching version without changing requested or automatic flags', async (t) => {
  const { api, file, folder, state } = await runtime(t)
  await api.recordVersions(file, ['original'], 'previous')
  if (process.platform !== 'win32') assert.ok(state.folderSyncs > 0)
  assert.deepEqual(
    (await api.listVersions(file)).map(({ automatic }) => automatic ?? false),
    [false],
  )
  await api.recordVersions(file, ['automatic'], true)
  const copies = state.copies
  await api.recordVersions(file, ['original'], 'previous')
  await api.recordVersions(file, ['automatic'], 'previous')
  assert.equal(state.copies, copies)
  assert.deepEqual(
    (await api.listVersions(file)).map(({ automatic }) => automatic ?? false),
    [true, false],
  )
  const [last] = await api.listVersions(file)
  await fs.unlink(join(folder, `${last.id}.md`))
  await api.recordVersions(file, ['automatic'], 'previous')
  assert.equal(await api.previewVersion(file, last.id), 'automatic')
  assert.equal(state.copies, copies + 1)
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

test('autosaves make room before saves asked for, oldest first', async (t) => {
  const { api, file } = await runtime(t)
  await api.recordVersions(file, ['asked for first'])
  await api.recordVersions(file, ['asked for second'])
  for (let n = 0; n < 150; n++)
    await api.recordVersions(file, [`autosave ${n}`], true)
  const versions = await api.listVersions(file)
  assert.equal(versions.length, 100)
  const oldest = versions.slice(-2)
  assert.equal(await api.previewVersion(file, oldest[1].id), 'asked for first')
  assert.equal(await api.previewVersion(file, oldest[0].id), 'asked for second')
  assert.equal(await api.previewVersion(file, versions[0].id), 'autosave 149')
  assert.equal(await api.previewVersion(file, versions[97].id), 'autosave 52')
})

test('saves asked for go only once no autosave is left, and the newest two always stay', async (t) => {
  const { api, file } = await runtime(t)
  for (let n = 0; n < 99; n++) await api.recordVersions(file, [`asked ${n}`])
  await api.recordVersions(file, ['autosave'], true)
  await api.recordVersions(file, ['asked last'])
  await api.recordVersions(file, ['autosave newest'], true)
  const versions = await api.listVersions(file)
  assert.equal(versions.length, 100)
  assert.equal(
    await api.previewVersion(file, versions[0].id),
    'autosave newest',
  )
  assert.equal(await api.previewVersion(file, versions[1].id), 'asked last')
  assert.equal(await api.previewVersion(file, versions.at(-1).id), 'asked 1')
})

test('a save asked for of text autosave just wrote counts as asked for', async (t) => {
  const { api, file } = await runtime(t)
  await api.recordVersions(file, ['opened', 'keep this'], true)
  await api.recordVersions(file, ['keep this', 'keep this'])
  for (let n = 0; n < 150; n++)
    await api.recordVersions(file, [`autosave ${n}`], true)
  const kept = await Promise.all(
    (await api.listVersions(file)).map(({ id }) =>
      api.previewVersion(file, id),
    ),
  )
  assert.ok(kept.includes('keep this'))
})

test('over the byte limit, the autosave before the newest goes before a save asked for', async (t) => {
  const { api, file } = await runtime(t)
  const text = (mark) => mark + 'x'.repeat(8 * mib)
  await api.recordVersions(file, [text('asked')])
  await api.recordVersions(file, [text('first')], true)
  await api.recordVersions(file, [text('second')], true)
  const kept = await Promise.all(
    (await api.listVersions(file)).map(async ({ id }) => {
      for await (const chunk of api.readVersionChunks(file, id))
        return chunk.slice(0, 6)
    }),
  )
  assert.deepEqual(kept, ['second', 'askedx'])
})

test('a save asked for keeps the autosave it replaced, still flagged as one', async (t) => {
  const { api, file } = await runtime(t)
  const text = (mark) => mark + 'x'.repeat(8 * mib)
  await api.recordVersions(file, [text('asked')])
  await api.recordVersions(file, [text('first')], true)
  await api.recordVersions(file, [text('first'), text('later')])
  const versions = await api.listVersions(file)
  const kept = await Promise.all(
    versions.map(async ({ id }) => {
      for await (const chunk of api.readVersionChunks(file, id))
        return chunk.slice(0, 5)
    }),
  )
  assert.deepEqual(kept, ['later', 'first'])
  assert.deepEqual(
    versions.map(({ automatic }) => automatic),
    [undefined, true],
  )
})

test('autosaves a pause apart thin out, so a long afternoon leaves earlier days reachable', async (t) => {
  const { api, file } = await runtime(t)
  let now = Date.UTC(2026, 10, 1, 9)
  t.mock.method(Date, 'now', () => now)
  await api.recordVersions(file, ['monday', 'monday end'], true)
  now += 24 * 60 * 60 * 1000
  // Three hours of typing with a pause every 30 s, and no save asked for.
  for (let n = 0; n < 360; n++) {
    now += 30000
    await api.recordVersions(file, [`pause ${n}`], true)
  }
  const versions = await api.listVersions(file)
  assert.ok(versions.length <= 100)
  const kept = await Promise.all(
    versions.map(({ id }) => api.previewVersion(file, id)),
  )
  assert.ok(kept.includes('monday end'), 'the last text of an earlier day')
  assert.equal(kept[0], 'pause 359')
  // Listed about every 3 minutes, so a version stays within reach of each.
  const times = versions.map(({ savedAt }) => savedAt).sort((a, b) => a - b)
  const gaps = times.slice(3).map((time, i) => time - times[i + 2])
  assert.ok(Math.max(...gaps) <= 6 * 60 * 1000, String(Math.max(...gaps)))
})

test('a version autosave wrote is flagged; the text it replaced and saves asked for are not', async (t) => {
  const { api, file } = await runtime(t)
  await api.recordVersions(file, ['opened', 'autosaved'], true)
  await api.recordVersions(file, ['asked for'])
  assert.deepEqual(
    (await api.listVersions(file)).map(({ automatic }) => automatic ?? false),
    [false, true, false],
  )
})

test('damaged history indexes are set aside and rebuilt from the copies on disk', async (t) => {
  for (const damaged of ['{not json', '{}', '[{"id":"bad"}]']) {
    const { api, file, folder, state } = await runtime(t)
    await fs.mkdir(folder, { recursive: true })
    const oldId = randomUUID()
    const oldCopy = join(folder, `${oldId}.md`)
    await fs.writeFile(oldCopy, 'old copy')
    const old = new Date('2026-01-02T03:04:05Z')
    await fs.utimes(oldCopy, old, old)
    await fs.writeFile(join(folder, 'index.json'), damaged)
    await api.recordVersions(file, ['previous'], 'previous')
    const quarantined = (await fs.readdir(folder)).filter((name) =>
      name.startsWith('index.json.corrupt-'),
    )
    assert.equal(quarantined.length, 1)
    assert.equal(
      await fs.readFile(join(folder, quarantined[0]), 'utf8'),
      damaged,
    )
    const versions = await api.listVersions(file)
    assert.deepEqual(
      versions.map(({ id, bytes, savedAt }) => ({ id, bytes, savedAt })),
      [
        {
          id: versions[0].id,
          bytes: Buffer.byteLength('previous'),
          savedAt: versions[0].savedAt,
        },
        { id: oldId, bytes: Buffer.byteLength('old copy'), savedAt: +old },
      ],
    )
    assert.equal(await api.previewVersion(file, oldId), 'old copy')
    assert.equal(await api.previewVersion(file, versions[0].id), 'previous')
    // The rebuilt hash is the copy's own, so the same text is not copied again.
    const copies = state.copies
    await api.recordVersions(file, ['old copy'], 'previous')
    assert.equal(state.copies, copies)
    assert.ok(state.folderSyncs >= 2)
  }
})

test('a rebuilt index leaves out copies it cannot read and keeps them on disk', {
  skip: process.platform === 'win32',
}, async (t) => {
  const { api, file, folder } = await runtime(t)
  await fs.mkdir(folder, { recursive: true })
  const readable = randomUUID()
  const locked = join(folder, `${randomUUID()}.md`)
  await fs.writeFile(join(folder, `${readable}.md`), 'readable')
  await fs.writeFile(locked, 'locked', { mode: 0o000 })
  await fs.writeFile(join(folder, 'notes.md'), 'not a copy')
  await fs.writeFile(join(folder, 'index.json'), '{not json')
  assert.deepEqual(
    (await api.listVersions(file)).map(({ id }) => id),
    [readable],
  )
  await fs.chmod(locked, 0o600)
  assert.equal(await fs.readFile(locked, 'utf8'), 'locked')
  assert.equal(
    await fs.readFile(join(folder, 'notes.md'), 'utf8'),
    'not a copy',
  )
})

test('repeated damage leaves every copy listed, none outside the index', async (t) => {
  const { api, file, folder } = await runtime(t)
  for (let i = 0; i < 5; i++) {
    await api.recordVersions(file, [`v${i}`])
    await fs.writeFile(join(folder, 'index.json'), '{not json')
    await api.listVersions(file)
  }
  const names = await fs.readdir(folder)
  const listed = new Set((await api.listVersions(file)).map(({ id }) => id))
  assert.equal(
    names.filter((n) => n.startsWith('index.json.corrupt-')).length,
    5,
  )
  assert.deepEqual(
    names
      .filter((n) => n.endsWith('.md'))
      .map((n) => n.slice(0, -3))
      .sort(),
    [...listed].sort(),
  )
  assert.equal(listed.size, 5)
})

test('copies a rebuilt index lists count toward the history budget', async (t) => {
  const { api, file, folder } = await runtime(t)
  await fs.mkdir(folder, { recursive: true })
  const ids = []
  for (let i = 0; i < 3; i++) {
    const id = randomUUID()
    ids.push(id)
    const copy = join(folder, `${id}.md`)
    await fs.writeFile(copy, String(i).repeat(8 * mib))
    const time = new Date(Date.UTC(2026, 0, i + 1))
    await fs.utimes(copy, time, time)
  }
  await fs.writeFile(join(folder, 'index.json'), '{not json')
  await api.recordVersions(file, ['new'])
  const listed = await api.listVersions(file)
  assert.ok(listed.reduce((sum, { bytes }) => sum + bytes, 0) <= 20 * mib)
  assert.deepEqual(
    listed.map(({ id }) => id),
    [listed[0].id, ids[2], ids[1]],
  )
  // The oldest went by the usual rule, file and entry together.
  await assert.rejects(fs.stat(join(folder, `${ids[0]}.md`)), {
    code: 'ENOENT',
  })
})

for (const code of ['EMFILE', 'EIO']) {
  test(`one transient ${code} reading the index keeps every version`, async (t) => {
    const { api, file, folder, state } = await runtime(t)
    await api.recordVersions(file, ['one'])
    await api.recordVersions(file, ['two'])
    state.indexReadErrors.push(code)
    await assert.rejects(api.listVersions(file), { code })
    assert.equal((await api.listVersions(file)).length, 2)
    assert.deepEqual(
      (await fs.readdir(folder)).filter((n) => n.includes('corrupt')),
      [],
    )
  })
}

test('an index that cannot be read stays in place and the save is refused', {
  skip: process.platform === 'win32',
}, async (t) => {
  const { api, file, folder } = await runtime(t)
  await api.recordVersions(file, ['one'])
  const index = join(folder, 'index.json')
  const before = await fs.readFile(index, 'utf8')
  await fs.chmod(index, 0o000)
  await assert.rejects(api.recordVersions(file, ['previous'], 'previous'), {
    code: 'EACCES',
  })
  await assert.rejects(api.listVersions(file), { code: 'EACCES' })
  await fs.chmod(index, 0o600)
  assert.equal(await fs.readFile(index, 'utf8'), before)
  assert.deepEqual(
    (await fs.readdir(folder)).filter((n) => n.includes('corrupt')),
    [],
  )
  assert.equal((await api.listVersions(file)).length, 1)
})

test('first history open removes only its owned abandoned temporary files, once', async (t) => {
  const { api, file, folder } = await runtime(t)
  await fs.mkdir(folder, { recursive: true })
  const own = [
    `.${randomUUID()}.md.${randomUUID()}.tmp`,
    `.index.json.${randomUUID()}.tmp`,
  ]
  const foreign = ['.keep.tmp', 'index.json.corrupt-1', `${randomUUID()}.md`]
  for (const name of [...own, ...foreign])
    await fs.writeFile(join(folder, name), name)
  assert.deepEqual(await api.listVersions(file), [])
  assert.deepEqual((await fs.readdir(folder)).sort(), foreign.sort())
  // Cleanup must not remove a temporary file from a live save later this run.
  await fs.writeFile(join(folder, own[0]), 'live write')
  await api.listVersions(file)
  assert.equal(await fs.readFile(join(folder, own[0]), 'utf8'), 'live write')
})
