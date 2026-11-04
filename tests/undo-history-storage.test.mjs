import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import { DocumentSession } from '../src/shared/document-session.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'
import { keptHistory } from '../src/shared/undo-history.ts'

const mib = 1024 * 1024
// Synthetic note identities use the platform's native separators, like real files.
const notePath = (name) => join('/notes', name)
const bundle = build({
  entryPoints: ['src/main/undo-history.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  external: ['electron'],
  format: 'cjs',
})
async function profile(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'hibi-undo-history-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}
/** A fresh main process over the same app data; `io` stands in for node:fs/promises. */
async function main(root, io) {
  const module = { exports: {} }
  const require = createRequire(import.meta.url)
  new Function(
    'require',
    'module',
    'exports',
    (await bundle).outputFiles[0].text,
  )(
    (id) =>
      id === 'electron'
        ? { app: { getPath: () => root } }
        : id === 'node:fs/promises' && io
          ? io
          : require(id),
    module,
    module.exports,
  )
  return module.exports
}
const folder = (root) => join(root, 'undo-history')
const kept = (root, path) =>
  join(folder(root), `${createHash('sha256').update(path).digest('hex')}.json`)
const exists = (path) =>
  fs.stat(path).then(
    () => true,
    () => false,
  )

/** A note edited and saved: its history, and main's copy of the saved text. */
function saved(text = 'base', edits = [' one', ' two'], options = {}) {
  const session = new DocumentSession(text, { tabId: 'n', revision: 0 }, 0, {
    enqueue() {},
    onError(error) {
      throw error
    },
    ...options,
  })
  for (const [index, insert] of edits.entries()) {
    const end = session.snapshot().utf16Length
    session.edit([{ from: end, to: end, insert }], 'source', `step-${index}`)
  }
  session.sealHistory()
  session.markSaved(session.snapshot())
  const history = JSON.parse(JSON.stringify(keptHistory(session)))
  const source = session.snapshot().materialize()
  return {
    history,
    source,
    file: new SourceStore(
      source,
      { tabId: 'n', revision: 0 },
      history.version,
    ).snapshot(),
  }
}
const reopened = (text, version = 0) =>
  new SourceStore(text, { tabId: 'r', revision: 0 }, version).snapshot()

test('a note reopens with the history kept for the text it saved', async (t) => {
  const root = await profile(t)
  const api = await main(root)
  const note = saved()
  await api.storeUndoHistory(notePath('a.md'), note.file, note.history)
  const stored = JSON.parse(
    await fs.readFile(kept(root, notePath('a.md')), 'utf8'),
  )
  assert.equal(stored.format, 1)
  assert.equal(
    stored.hash,
    createHash('sha256').update('base one two').digest('hex'),
  )
  // Another launch reads it for a tab that loaded the same text.
  const later = await main(root)
  assert.deepEqual(
    await later.readUndoHistory(notePath('a.md'), reopened(note.source)),
    note.history,
  )
  assert.equal(
    await later.readUndoHistory(notePath('b.md'), reopened(note.source)),
    null,
  )
})

test('a note changed outside Hibi drops its kept history without asking', async (t) => {
  const root = await profile(t)
  const api = await main(root)
  const note = saved()
  await api.storeUndoHistory(notePath('a.md'), note.file, note.history)
  // Same length, other text.
  assert.equal(
    await api.readUndoHistory(notePath('a.md'), reopened('BASE ONE TWO')),
    null,
  )
  assert.equal(await exists(kept(root, notePath('a.md'))), false)
})

test('an unreadable kept history is ignored and removed', async (t) => {
  const root = await profile(t)
  const api = await main(root)
  const note = saved()
  const path = kept(root, notePath('a.md'))
  const valid = async () => {
    await api.storeUndoHistory(notePath('a.md'), note.file, note.history)
    return JSON.parse(await fs.readFile(path, 'utf8'))
  }
  for (const write of [
    () => fs.writeFile(path, '{"format":1,"hash":'),
    () => fs.writeFile(path, 'not json'),
    async () => {
      const copy = await valid()
      copy.history.steps[0].parent = 5
      await fs.writeFile(path, JSON.stringify(copy))
    },
    async () => {
      const copy = await valid()
      copy.format = 2
      await fs.writeFile(path, JSON.stringify(copy))
    },
    // Larger than any history an editor writes.
    async () => {
      await valid()
      await fs.truncate(path, 33 * mib)
    },
  ]) {
    await fs.mkdir(folder(root), { recursive: true })
    await write()
    assert.equal(
      await api.readUndoHistory(notePath('a.md'), reopened(note.source)),
      null,
    )
    assert.equal(await exists(path), false)
  }
})

test('a history for an older save is not kept', async (t) => {
  const root = await profile(t)
  const api = await main(root)
  const note = saved()
  const newer = new SourceStore(
    note.source,
    { tabId: 'n', revision: 0 },
    note.history.version + 1,
  ).snapshot()
  await api.storeUndoHistory(notePath('a.md'), newer, note.history)
  assert.equal(await exists(kept(root, notePath('a.md'))), false)
  await assert.rejects(
    api.storeUndoHistory(notePath('a.md'), note.file, {
      ...note.history,
      saved: 9,
    }),
    /invalid/,
  )
})

test('past 64 MiB, notes saved longest ago lose their kept history first', async (t) => {
  const root = await profile(t)
  await fs.mkdir(folder(root), { recursive: true })
  const older = ['/old/1.md', '/old/2.md', '/old/3.md']
  for (const [index, path] of older.entries()) {
    await fs.writeFile(kept(root, path), '')
    await fs.truncate(kept(root, path), 30 * mib)
    const time = new Date(Date.UTC(2026, 0, 1 + index))
    await fs.utimes(kept(root, path), time, time)
  }
  const api = await main(root)
  const note = saved()
  await api.storeUndoHistory(notePath('new.md'), note.file, note.history)
  assert.deepEqual(
    await Promise.all(older.map((path) => exists(kept(root, path)))),
    [false, true, true],
  )
  assert.equal(await exists(kept(root, notePath('new.md'))), true)
})

test('keeping turned off removes kept histories and keeps no new ones', async (t) => {
  const root = await profile(t)
  const api = await main(root)
  const note = saved()
  assert.equal(await api.keepsUndoHistory(), true)
  await api.storeUndoHistory(notePath('a.md'), note.file, note.history)
  await api.setKeepUndoHistory(false)
  assert.equal(await exists(kept(root, notePath('a.md'))), false)
  const later = await main(root)
  assert.equal(await later.keepsUndoHistory(), false)
  await later.storeUndoHistory(notePath('a.md'), note.file, note.history)
  assert.equal(await exists(kept(root, notePath('a.md'))), false)
  assert.equal(
    await later.readUndoHistory(notePath('a.md'), reopened(note.source)),
    null,
  )
  await assert.rejects(later.setKeepUndoHistory('no'), /Invalid/)
  await later.setKeepUndoHistory(true)
  await later.storeUndoHistory(notePath('a.md'), note.file, note.history)
  assert.equal(await exists(kept(root, notePath('a.md'))), true)
  await later.clearUndoHistory()
  assert.equal(await exists(folder(root)), false)
})

test('kept histories follow notes renamed or moved inside Hibi', async (t) => {
  const root = await profile(t)
  const api = await main(root)
  const note = saved()
  await api.storeUndoHistory(notePath('a.md'), note.file, note.history)
  await api.relocateUndoHistory(notePath('a.md'), notePath('b.md'))
  assert.equal(await exists(kept(root, notePath('a.md'))), false)
  assert.deepEqual(
    await api.readUndoHistory(notePath('b.md'), reopened(note.source)),
    note.history,
  )
  // A moved folder takes the histories of every note under it.
  const before = join(root, 'before'),
    after = join(root, 'after')
  await fs.mkdir(join(after, 'inner'), { recursive: true })
  await fs.writeFile(join(after, 'inner', 'c.md'), note.source)
  await fs.writeFile(join(after, 'd.md'), note.source)
  await api.storeUndoHistory(
    join(before, 'inner', 'c.md'),
    note.file,
    note.history,
  )
  await api.relocateUndoHistory(before, after)
  assert.equal(await exists(kept(root, join(before, 'inner', 'c.md'))), false)
  assert.deepEqual(
    await api.readUndoHistory(
      join(after, 'inner', 'c.md'),
      reopened(note.source),
    ),
    note.history,
  )
  assert.equal(
    await api.readUndoHistory(join(after, 'd.md'), reopened(note.source)),
    null,
  )
  // b.md's history stayed where it was.
  assert.equal(await exists(kept(root, notePath('b.md'))), true)
})

test('moves made before their histories follow apply in order, and an unreadable folder strands none', async (t) => {
  const root = await profile(t)
  const api = await main(root)
  const note = saved()
  const work = join(root, 'work')
  await fs.mkdir(join(work, 'a', 'locked'), { recursive: true })
  await fs.writeFile(join(work, 'a', 'n.md'), note.source)
  await api.storeUndoHistory(join(work, 'a', 'n.md'), note.file, note.history)
  // A folder only its owner can't list moves along.
  await fs.chmod(join(work, 'a', 'locked'), 0o000)
  t.after(() => fs.chmod(join(work, 'c', 'locked'), 0o755).catch(() => {}))
  // The folder moves twice before the first move's history follows.
  await fs.rename(join(work, 'a'), join(work, 'b'))
  const first = api.relocateUndoHistory(join(work, 'a'), join(work, 'b'))
  await fs.rename(join(work, 'b'), join(work, 'c'))
  await Promise.all([
    first,
    api.relocateUndoHistory(join(work, 'b'), join(work, 'c')),
  ])
  assert.equal(await exists(kept(root, join(work, 'a', 'n.md'))), false)
  assert.deepEqual(
    await api.readUndoHistory(join(work, 'c', 'n.md'), reopened(note.source)),
    note.history,
  )
  // A later launch follows the next move from what this one kept.
  const later = await main(root)
  await later.relocateUndoHistory(join(work, 'c'), join(work, 'd'))
  assert.deepEqual(
    await later.readUndoHistory(join(work, 'd', 'n.md'), reopened(note.source)),
    note.history,
  )
  // Clearing forgets which notes had histories, too.
  await later.clearUndoHistory()
  assert.deepEqual(
    (await fs.readdir(root)).filter((name) => name.startsWith('undo-history')),
    [],
  )
})

test('a temporary copy a crash left behind is removed by the next store', async (t) => {
  const root = await profile(t)
  await fs.mkdir(folder(root), { recursive: true })
  const left = join(folder(root), `.${'a'.repeat(64)}.json.left.tmp`)
  await fs.writeFile(left, 'deleted text from a cut-short write')
  const api = await main(root)
  const note = saved()
  await api.storeUndoHistory(notePath('a.md'), note.file, note.history)
  assert.equal(await exists(left), false)
  assert.equal(await exists(kept(root, notePath('a.md'))), true)
})

test('an unreadable undo history setting keeps nothing until it is set again', async (t) => {
  const root = await profile(t)
  const note = saved()
  for (const text of ['null', '{"keep":', 'not json']) {
    await fs.writeFile(join(root, 'undo-history-settings.json'), text)
    const api = await main(root)
    assert.equal(await api.keepsUndoHistory(), false)
    await api.storeUndoHistory(notePath('a.md'), note.file, note.history)
    assert.equal(await exists(kept(root, notePath('a.md'))), false)
  }
  const api = await main(root)
  await api.setKeepUndoHistory(true)
  assert.equal(await (await main(root)).keepsUndoHistory(), true)
})

test('notes Hibi moves to the trash take their kept histories with them', async (t) => {
  const root = await profile(t)
  const api = await main(root)
  const note = saved()
  for (const path of [
    notePath('a.md'),
    notePath('inner/b.md'),
    notePath('inner-c.md'),
    join('/other', 'c.md'),
  ])
    await api.storeUndoHistory(path, note.file, note.history)
  await api.removeUndoHistory(notePath('a.md'))
  assert.equal(await exists(kept(root, notePath('a.md'))), false)
  // A trashed folder takes every note under it, and only those.
  await api.removeUndoHistory(notePath('inner'))
  assert.equal(await exists(kept(root, notePath('inner/b.md'))), false)
  assert.equal(await exists(kept(root, notePath('inner-c.md'))), true)
  assert.equal(await exists(kept(root, join('/other', 'c.md'))), true)
  // The index forgets them at once.
  assert.deepEqual(
    JSON.parse(
      await fs.readFile(join(root, 'undo-history-notes.json'), 'utf8'),
    ).sort(),
    [notePath('inner-c.md'), join('/other', 'c.md')],
  )
  // A history the index doesn't list goes by its name.
  await fs.rm(join(root, 'undo-history-notes.json'))
  await (await main(root)).removeUndoHistory(join('/other', 'c.md'))
  assert.equal(await exists(kept(root, join('/other', 'c.md'))), false)
})

test('a quit waits for a move or a removal still in progress', async (t) => {
  const root = await profile(t)
  for (const operation of ['rename', 'unlink']) {
    // Moves rename kept files and removals unlink them; this one is slow.
    const slow = Promise.withResolvers()
    const data = join(root, operation)
    await fs.mkdir(data)
    const real = operation === 'rename' ? fs.rename : fs.unlink
    const api = await main(data, {
      ...fs,
      [operation]: async (path, ...rest) => {
        if (/[0-9a-f]{64}\.json$/.test(path)) await slow.promise
        return real(path, ...rest)
      },
    })
    const note = saved()
    await api.storeUndoHistory(notePath('a.md'), note.file, note.history)
    void (operation === 'rename'
      ? api.relocateUndoHistory(notePath('a.md'), notePath('b.md'))
      : api.removeUndoHistory(notePath('a.md')))
    let quit = false
    const quitting = api
      .flushUndoHistory({
        isDestroyed: () => false,
        webContents: {
          send: (_channel, token) =>
            queueMicrotask(() => api.acceptUndoHistoryFlushed(token)),
        },
      })
      .then(() => api.undoHistoryWritten())
      .then(() => {
        quit = true
      })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(quit, false, operation)
    slow.resolve()
    await quitting
    assert.equal(await exists(kept(data, notePath('a.md'))), false)
    assert.equal(
      await exists(kept(data, notePath('b.md'))),
      operation === 'rename',
    )
  }
})

test('a quit waits for moves and removals queued behind a write', async (t) => {
  const root = await profile(t)
  const api = await main(root)
  const note = saved()
  await api.storeUndoHistory(notePath('a.md'), note.file, note.history)
  await api.storeUndoHistory(notePath('b.md'), note.file, note.history)
  // Another note's big history holds the queue.
  const big = saved('x', ['y'.repeat(4_000_000)])
  void api.storeUndoHistory(join('/other', 'big.md'), big.file, big.history)
  void api.relocateUndoHistory(notePath('a.md'), notePath('renamed.md'))
  void api.removeUndoHistory(notePath('b.md'))
  // The editor answers at once; the quit then waits for the queue.
  const window = {
    isDestroyed: () => false,
    webContents: {
      send: (_channel, token) =>
        queueMicrotask(() => api.acceptUndoHistoryFlushed(token)),
    },
  }
  await api.flushUndoHistory(window)
  await api.undoHistoryWritten()
  assert.equal(await exists(kept(root, notePath('renamed.md'))), true)
  assert.equal(await exists(kept(root, notePath('a.md'))), false)
  assert.equal(await exists(kept(root, notePath('b.md'))), false)
})

test("the index's temporary copy a crash left behind is removed", async (t) => {
  const root = await profile(t)
  const left = join(root, '.undo-history-notes.json.left.tmp')
  await fs.writeFile(left, '["/notes/a.md"]')
  const api = await main(root)
  const note = saved()
  await api.storeUndoHistory(notePath('a.md'), note.file, note.history)
  assert.equal(await exists(left), false)
  // Turning keeping off removes one too, though nothing reads the index then.
  await fs.writeFile(left, '["/notes/a.md"]')
  await (await main(root)).setKeepUndoHistory(false)
  assert.equal(await exists(left), false)
})

test('a store that changes no kept step leaves the file as it is', async (t) => {
  const root = await profile(t)
  const api = await main(root)
  const note = saved()
  await api.storeUndoHistory(notePath('a.md'), note.file, note.history)
  const file = kept(root, notePath('a.md'))
  const past = new Date(2020, 0, 1)
  await fs.utimes(file, past, past)
  await api.storeUndoHistory(notePath('a.md'), note.file, note.history)
  assert.equal((await fs.stat(file)).mtimeMs, past.getTime())
  const next = saved('base', [' one', ' two', ' three'])
  await api.storeUndoHistory(notePath('a.md'), next.file, next.history)
  assert.notEqual((await fs.stat(file)).mtimeMs, past.getTime())
})

test('a stale history a read finds is removed before a store queued after the read', async (t) => {
  const root = await profile(t)
  const api = await main(root)
  // Kept for text the note no longer has.
  const old = saved('other')
  await api.storeUndoHistory(notePath('a.md'), old.file, old.history)
  const note = saved()
  const reading = api.readUndoHistory(notePath('a.md'), note.file)
  const storing = api.storeUndoHistory(
    notePath('a.md'),
    note.file,
    note.history,
  )
  assert.equal(await reading, null)
  await storing
  // The fresh history stays.
  const later = await main(root)
  assert.notEqual(
    await later.readUndoHistory(notePath('a.md'), note.file),
    null,
  )
})

test("a closing tab waits until its steps are queued, not for other notes' writes", async (t) => {
  const root = await profile(t)
  const api = await main(root)
  const big = saved('x', ['y'.repeat(4_000_000)])
  let written = false
  void api
    .storeUndoHistory(join('/other', 'big.md'), big.file, big.history)
    .then(() => {
      written = true
    })
  const window = {
    isDestroyed: () => false,
    webContents: {
      send: (_channel, token) =>
        queueMicrotask(() => api.acceptUndoHistoryFlushed(token)),
    },
  }
  await api.flushUndoHistory(window)
  assert.equal(written, false)
  // A quit waits for it.
  await api.undoHistoryWritten()
  assert.equal(written, true)
})

test('a quit waits 5 seconds at most for a move that never finishes', {
  timeout: 20000,
}, async (t) => {
  const root = await profile(t)
  const stuck = Promise.withResolvers()
  const api = await main(root, {
    ...fs,
    rename: async (path, ...rest) => {
      if (/[0-9a-f]{64}\.json$/.test(path)) await stuck.promise
      return fs.rename(path, ...rest)
    },
  })
  const note = saved()
  await api.storeUndoHistory(notePath('a.md'), note.file, note.history)
  void api.relocateUndoHistory(notePath('a.md'), notePath('b.md'))
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let quit = false
  const quitting = api.undoHistoryWritten().then(() => {
    quit = true
  })
  t.mock.timers.tick(4999)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(quit, false)
  t.mock.timers.tick(1)
  await quitting
  t.mock.timers.reset()
  stuck.resolve()
  await api.undoHistoryWritten()
  assert.equal(await exists(kept(root, notePath('b.md'))), true)
})

test('a quit waits for a clear, and for keeping turned off, asked for before it', async (t) => {
  const root = await profile(t)
  for (const action of ['clear', 'off']) {
    const data = join(root, action)
    await fs.mkdir(data)
    // The clear (or the setting before it) is slow.
    const slow = Promise.withResolvers()
    const api = await main(data, {
      ...fs,
      rename: async (path, to, ...rest) => {
        if (String(to).endsWith('undo-history-settings.json'))
          await slow.promise
        return fs.rename(path, to, ...rest)
      },
      rm: async (path, ...rest) => {
        if (String(path).endsWith('undo-history')) await slow.promise
        return fs.rm(path, ...rest)
      },
    })
    const note = saved()
    await api.storeUndoHistory(notePath('a.md'), note.file, note.history)
    const asked =
      action === 'clear'
        ? api.clearUndoHistory()
        : api.setKeepUndoHistory(false)
    let quit = false
    const quitting = api.undoHistoryWritten().then(() => {
      quit = true
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(quit, false, action)
    slow.resolve()
    await quitting
    // Nothing kept is left for the next launch to restore.
    assert.equal(await exists(folder(data)), false, action)
    await asked
  }
})

const indexFile = (root) => join(root, 'undo-history-notes.json')
const entries = async (root) =>
  JSON.parse(await fs.readFile(indexFile(root), 'utf8'))
const index = async (root) =>
  (await entries(root)).map((entry) => entry.path ?? entry).sort()
/** When the index says each note was first found missing, by path. */
const records = async (root) =>
  Object.fromEntries(
    (await entries(root))
      .filter((entry) => entry.path)
      .map((entry) => [entry.path, entry.missingSince]),
  )
/** An index recording each note as first found missing at `time`. */
const recorded = (root, paths, time) =>
  fs.writeFile(
    indexFile(root),
    JSON.stringify(paths.map((path) => ({ path, missingSince: time }))),
  )
const day = 24 * 60 * 60 * 1000
const today = Date.UTC(2026, 11, 1)
/** Stands in for the clock in this test; returns how to set it. */
function clock(t) {
  let time = today
  t.mock.method(Date, 'now', () => time)
  return (to) => {
    time = to
  }
}

test('a history let go past 64 MiB leaves the index too', async (t) => {
  const root = await profile(t)
  await fs.mkdir(folder(root), { recursive: true })
  const older = ['/old/1.md', '/old/2.md', '/old/3.md']
  for (const [index, path] of older.entries()) {
    await fs.writeFile(kept(root, path), '')
    await fs.truncate(kept(root, path), 30 * mib)
    const time = new Date(Date.UTC(2026, 0, 1 + index))
    await fs.utimes(kept(root, path), time, time)
  }
  await fs.writeFile(
    join(root, 'undo-history-notes.json'),
    JSON.stringify(older),
  )
  const api = await main(root)
  const note = saved()
  await api.storeUndoHistory('/notes/new.md', note.file, note.history)
  assert.equal(await exists(kept(root, '/old/1.md')), false)
  assert.deepEqual(await index(root), [
    '/notes/new.md',
    '/old/2.md',
    '/old/3.md',
  ])
})

test('a temporary copy a crash left behind is removed by the first read, too', async (t) => {
  const root = await profile(t)
  await fs.mkdir(folder(root), { recursive: true })
  const left = join(folder(root), `.${'a'.repeat(64)}.json.left.tmp`)
  await fs.writeFile(left, 'deleted text from a cut-short write')
  const api = await main(root)
  assert.equal(await api.readUndoHistory('/notes/a.md', reopened('a')), null)
  assert.equal(await exists(left), false)
})

test('notes missing for 30 days let go of their kept histories, and notes on a missing drive keep them', async (t) => {
  const root = await profile(t)
  const setClock = clock(t)
  const api = await main(root)
  const note = saved()
  const notes = join(root, 'notes')
  await fs.mkdir(notes)
  // The folder holds something else when a.md is gone below, so it is not
  // taken for the empty mount point of a drive that isn't mounted.
  await fs.writeFile(join(notes, 'other.txt'), '')
  for (const name of ['a.md', 'b.md']) {
    await fs.writeFile(join(notes, name), note.source)
    await api.storeUndoHistory(join(notes, name), note.file, note.history)
  }
  // A drive that isn't mounted: the note's folder is missing too.
  const unmounted = join(root, 'drive', 'c.md')
  await api.storeUndoHistory(unmounted, note.file, note.history)
  await fs.rm(join(notes, 'b.md'))
  // The first launch to find it missing records when, and takes nothing.
  await api.pruneUndoHistory(0)
  assert.equal(await exists(kept(root, join(notes, 'b.md'))), true)
  assert.deepEqual(await records(root), { [join(notes, 'b.md')]: today })
  assert.deepEqual(
    await index(root),
    [join(notes, 'a.md'), join(notes, 'b.md'), unmounted].sort(),
  )
  // A moment short of 30 days it still keeps it, and at 30 days it goes.
  setClock(today + 30 * day - 1)
  await (await main(root)).pruneUndoHistory(0)
  assert.equal(await exists(kept(root, join(notes, 'b.md'))), true)
  setClock(today + 30 * day)
  const later = await main(root)
  await later.pruneUndoHistory(0)
  assert.equal(await exists(kept(root, join(notes, 'a.md'))), true)
  assert.equal(await exists(kept(root, join(notes, 'b.md'))), false)
  assert.equal(await exists(kept(root, unmounted)), true)
  assert.deepEqual(await index(root), [join(notes, 'a.md'), unmounted].sort())
  assert.deepEqual(await records(root), {})
  // A note gone at the first look and back by the second, as a branch
  // switch puts it back, keeps its history.
  await fs.rm(join(notes, 'a.md'))
  const pruning = later.pruneUndoHistory(1000)
  await new Promise((resolve) => setTimeout(resolve, 300))
  await fs.writeFile(join(notes, 'a.md'), note.source)
  await pruning
  assert.equal(await exists(kept(root, join(notes, 'a.md'))), true)
  assert.deepEqual(await records(root), {})
})

test('a note on another branch comes back within 30 days with its history, and its wait starts over', async (t) => {
  const root = await profile(t)
  const setClock = clock(t)
  const note = saved()
  const path = join(root, 'a.md')
  await fs.writeFile(join(root, 'other.md'), '')
  await fs.writeFile(path, note.source)
  await (await main(root)).storeUndoHistory(path, note.file, note.history)
  const launch = async (time) => {
    setClock(time)
    const api = await main(root)
    await api.pruneUndoHistory(0)
    return api
  }
  await fs.rm(path)
  await launch(today)
  await launch(today + 29 * day)
  assert.deepEqual(await records(root), { [path]: today })
  // The branch is back: the look clears the record, and the note reopens.
  await fs.writeFile(path, note.source)
  const back = await launch(today + 29 * day)
  assert.deepEqual(await records(root), {})
  assert.deepEqual(
    await back.readUndoHistory(path, reopened(note.source)),
    note.history,
  )
  // Gone again, it waits 30 days from then, not from the first time.
  await fs.rm(path)
  await launch(today + 30 * day)
  assert.deepEqual(await records(root), { [path]: today + 30 * day })
  await launch(today + 59 * day)
  assert.equal(await exists(kept(root, path)), true)
  await launch(today + 60 * day)
  assert.equal(await exists(kept(root, path)), false)
})

test('a note waiting out its 30 days gets one look a launch and writes nothing, and one back needs no second look', async (t) => {
  const root = await profile(t)
  const setClock = clock(t)
  const path = join(root, 'a.md')
  await fs.writeFile(join(root, 'other.md'), '')
  let looks = 0,
    writes = 0
  const api = await main(root, {
    ...fs,
    stat: async (file, ...rest) => {
      if (file === path) looks++
      return fs.stat(file, ...rest)
    },
    open: async (file, ...rest) => {
      writes++
      return fs.open(file, ...rest)
    },
  })
  await recorded(root, [path], today)
  setClock(today + day)
  // The wait between looks, seen as it starts and not waited out.
  const wait = 12_345
  let waited = false
  const { setTimeout: timer } = globalThis
  t.mock.method(globalThis, 'setTimeout', (run, ms, ...rest) => {
    if (ms === wait) waited = true
    return timer(run, ms === wait ? 0 : ms, ...rest)
  })
  await api.pruneUndoHistory(wait)
  assert.equal(looks, 1)
  assert.equal(writes, 0)
  assert.equal(waited, false)
  await fs.writeFile(path, '')
  await api.pruneUndoHistory(wait)
  assert.deepEqual(await records(root), {})
  assert.equal(waited, false)
})

test('opening or saving a note clears its record', async (t) => {
  const root = await profile(t)
  clock(t)
  const note = saved()
  const path = join(root, 'a.md')
  await fs.writeFile(join(root, 'other.md'), '')
  await fs.writeFile(path, note.source)
  const api = await main(root)
  await api.storeUndoHistory(path, note.file, note.history)
  await fs.rm(path)
  await api.pruneUndoHistory(0)
  assert.deepEqual(await records(root), { [path]: today })
  assert.deepEqual(
    await api.readUndoHistory(path, reopened(note.source)),
    note.history,
  )
  assert.deepEqual(await records(root), {})
  await api.pruneUndoHistory(0)
  assert.deepEqual(await records(root), { [path]: today })
  await api.storeUndoHistory(path, note.file, note.history)
  assert.deepEqual(await records(root), {})
})

test('a note opened still reads when its record cannot be cleared', async (t) => {
  const root = await profile(t)
  clock(t)
  const note = saved()
  const path = join(root, 'a.md')
  await fs.writeFile(join(root, 'other.md'), '')
  let failing = false
  const api = await main(root, {
    ...fs,
    open: async (file, ...rest) => {
      if (failing && String(file).includes('undo-history-notes'))
        throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
      return fs.open(file, ...rest)
    },
  })
  await api.storeUndoHistory(path, note.file, note.history)
  await api.pruneUndoHistory(0)
  failing = true
  assert.deepEqual(
    await api.readUndoHistory(path, reopened(note.source)),
    note.history,
  )
  failing = false
  assert.equal(await exists(kept(root, path)), true)
})

test('an index written before records reads, and only a missing note gets one', async (t) => {
  const root = await profile(t)
  clock(t)
  const here = join(root, 'here.md'),
    away = join(root, 'away.md')
  await fs.writeFile(here, '')
  await fs.writeFile(indexFile(root), JSON.stringify([here, away]))
  await (await main(root)).pruneUndoHistory(0)
  assert.deepEqual(await entries(root), [
    here,
    { path: away, missingSince: today },
  ])
})

test('a time in the index that is corrupt or set by hand starts the wait over, and entries that are no note drop', async (t) => {
  const root = await profile(t)
  const setClock = clock(t)
  const path = join(root, 'a.md')
  await fs.writeFile(join(root, 'other.md'), '')
  const bad = [
    'null',
    '"soon"',
    'true',
    '[]',
    '{}',
    '0',
    '-1',
    '1',
    '1e999',
    '-1e999',
    `${Date.UTC(2026, 0, 1) - 1}`,
  ]
  for (const value of bad) {
    await fs.mkdir(folder(root), { recursive: true })
    await fs.writeFile(kept(root, path), '{}')
    await fs.writeFile(
      indexFile(root),
      `[null, 5, [], {}, {"path": 5, "missingSince": ${today - 365 * day}}, {"path": ${JSON.stringify(path)}, "missingSince": ${value}}]`,
    )
    setClock(today)
    await (await main(root)).pruneUndoHistory(0)
    assert.equal(await exists(kept(root, path)), true, value)
    assert.deepEqual(
      await entries(root),
      [{ path, missingSince: today }],
      value,
    )
  }
})

test('a clock set back keeps the wait, and a time ahead of the clock never lets go early', async (t) => {
  const root = await profile(t)
  const setClock = clock(t)
  const path = join(root, 'a.md')
  await fs.writeFile(join(root, 'other.md'), '')
  await fs.mkdir(folder(root), { recursive: true })
  await fs.writeFile(kept(root, path), '{}')
  const launch = async (time) => {
    setClock(time)
    await (await main(root)).pruneUndoHistory(0)
  }
  const other = join(root, 'b.md')
  await fs.writeFile(
    indexFile(root),
    JSON.stringify([{ path, missingSince: today }, other]),
  )
  // Set back a year, then right again: the note waits from the same time,
  // though the launch writes the index for another note it finds missing.
  await launch(today - 365 * day)
  assert.deepEqual(await records(root), {
    [path]: today,
    [other]: today - 365 * day,
  })
  await launch(today + day)
  assert.equal(await exists(kept(root, path)), true)
  assert.equal((await records(root))[path], today)
  await launch(today + 30 * day)
  assert.equal(await exists(kept(root, path)), false)
  // A time far past the clock waits for the clock, whatever wrote it.
  await fs.writeFile(kept(root, path), '{}')
  await recorded(root, [path], today + 1000 * day)
  await launch(today + 500 * day)
  assert.equal(await exists(kept(root, path)), true)
})

test('a note with a record that Hibi moves or trashes takes it along, and a clear forgets it', async (t) => {
  const root = await profile(t)
  const setClock = clock(t)
  const note = saved()
  const from = join(root, 'a.md'),
    to = join(root, 'b.md'),
    trashed = join(root, 't.md'),
    cleared = join(root, 'c.md'),
    overwritten = join(root, 'o.md')
  await fs.writeFile(join(root, 'other.md'), '')
  const api = await main(root)
  for (const path of [from, trashed, cleared, overwritten])
    await api.storeUndoHistory(path, note.file, note.history)
  await api.pruneUndoHistory(0)
  assert.equal(Object.keys(await records(root)).length, 4)
  // Moved: the note was just seen under its new name, which may have waited too.
  await fs.writeFile(to, note.source)
  await api.relocateUndoHistory(from, to)
  await fs.writeFile(overwritten, note.source)
  await api.relocateUndoHistory(to, overwritten)
  await api.removeUndoHistory(trashed)
  assert.deepEqual(await records(root), { [cleared]: today })
  assert.deepEqual(await index(root), [cleared, overwritten].sort())
  await api.clearUndoHistory()
  // A read after a clear finds no record to clear, so no index comes back.
  assert.equal(await api.readUndoHistory(cleared, reopened(note.source)), null)
  assert.equal(await exists(indexFile(root)), false)
  // Moved between the looks of a launch that would have let go of it.
  setClock(today + 40 * day)
  await fs.rm(overwritten)
  await recorded(root, [from], today)
  const later = await main(root)
  await fs.mkdir(folder(root), { recursive: true })
  await fs.writeFile(kept(root, from), JSON.stringify({}))
  const pruning = later.pruneUndoHistory(50)
  await fs.writeFile(to, note.source)
  await later.relocateUndoHistory(from, to)
  await pruning
  assert.equal(await exists(kept(root, to)), true)
  assert.deepEqual(await entries(root), [to])
})

test('a note due to go stays unless both looks find it missing', async (t) => {
  const root = await profile(t)
  const setClock = clock(t)
  const path = join(root, 'a.md')
  await fs.writeFile(join(root, 'other.md'), '')
  await fs.mkdir(folder(root), { recursive: true })
  await fs.writeFile(kept(root, path), '{}')
  // What each lookup of the note does, in order.
  let lookups = []
  const api = await main(root, {
    ...fs,
    stat: async (file, ...rest) => {
      if (file === path) {
        const lookup = lookups.shift()
        if (lookup === 'fails')
          throw Object.assign(new Error('EIO'), { code: 'EIO' })
        if (lookup === 'back') await fs.writeFile(path, '')
      }
      return fs.stat(file, ...rest)
    },
  })
  await recorded(root, [path], today)
  setClock(today + 31 * day)
  lookups = ['missing', 'fails']
  await api.pruneUndoHistory(0)
  assert.equal(await exists(kept(root, path)), true)
  assert.deepEqual(await records(root), { [path]: today })
  lookups = ['fails', 'missing']
  await api.pruneUndoHistory(0)
  assert.equal(await exists(kept(root, path)), true)
  assert.deepEqual(await records(root), { [path]: today })
  lookups = ['missing', 'back']
  await api.pruneUndoHistory(0)
  assert.equal(await exists(kept(root, path)), true)
  assert.deepEqual(await records(root), {})
})

test('past 64 MiB, a note waiting out its 30 days goes as any other, and leaves its record', async (t) => {
  const root = await profile(t)
  clock(t)
  await fs.mkdir(folder(root), { recursive: true })
  const older = ['/old/1.md', '/old/2.md', '/old/3.md']
  for (const [index, path] of older.entries()) {
    await fs.writeFile(kept(root, path), '')
    await fs.truncate(kept(root, path), 30 * mib)
    const time = new Date(Date.UTC(2026, 0, 1 + index))
    await fs.utimes(kept(root, path), time, time)
  }
  await recorded(root, older, today - day)
  const api = await main(root)
  const note = saved()
  await api.storeUndoHistory('/notes/new.md', note.file, note.history)
  assert.equal(await exists(kept(root, '/old/1.md')), false)
  assert.deepEqual(await entries(root), [
    { path: '/old/2.md', missingSince: today - day },
    { path: '/old/3.md', missingSince: today - day },
    '/notes/new.md',
  ])
})

test('a note Hibi moves while missing notes are looked for keeps its history', async (t) => {
  const root = await profile(t)
  const api = await main(root)
  const note = saved()
  const from = join(root, 'a.md'),
    to = join(root, 'b.md')
  await fs.writeFile(from, note.source)
  await api.storeUndoHistory(from, note.file, note.history)
  // Hibi moved the note on disk; its history follows once the move is done,
  // after the first look found the note missing.
  await fs.rename(from, to)
  const pruning = api.pruneUndoHistory(50)
  await api.relocateUndoHistory(from, to)
  await pruning
  assert.deepEqual(
    await api.readUndoHistory(to, reopened(note.source)),
    note.history,
  )
})

test('missing notes are looked at again only after the moves Hibi queued, even a slow one', async (t) => {
  const root = await profile(t)
  const from = join(root, 'a.md'),
    to = join(root, 'b.md')
  const moved = Promise.withResolvers()
  let moving = false
  const api = await main(root, {
    ...fs,
    rename: async (path, ...rest) => {
      if (path === kept(root, from)) {
        moving = true
        await moved.promise
      }
      return fs.rename(path, ...rest)
    },
  })
  const note = saved()
  await fs.writeFile(from, note.source)
  await api.storeUndoHistory(from, note.file, note.history)
  await fs.rename(from, to)
  const pruning = api.pruneUndoHistory(10)
  const relocating = api.relocateUndoHistory(from, to)
  while (!moving) await new Promise((resolve) => setTimeout(resolve, 10))
  // The second look is due while the history's move is still on its way.
  await new Promise((resolve) => setTimeout(resolve, 100))
  moved.resolve()
  await Promise.all([relocating, pruning])
  assert.deepEqual(
    await api.readUndoHistory(to, reopened(note.source)),
    note.history,
  )
})

test('a note that cannot be looked at, iCloud evicted, or on an empty mount point keeps its history, past 30 days too', async (t) => {
  const root = await profile(t)
  const setClock = clock(t)
  const note = saved()
  const unreadable = join(root, 'locked', 'a.md'),
    evicted = join(root, 'Documents', 'b.md'),
    unmounted = join(root, 'mnt', 'usb', 'c.md'),
    unsure = join(root, 'flaky', 'd.md')
  const api = await main(root, {
    ...fs,
    stat: async (path, ...rest) => {
      if (path === unreadable || path === join(root, 'flaky', '.d.md.icloud'))
        throw Object.assign(new Error('EIO'), { code: 'EIO' })
      return fs.stat(path, ...rest)
    },
  })
  for (const path of [unreadable, evicted, unmounted, unsure]) {
    await fs.mkdir(join(path, '..'), { recursive: true })
    await fs.writeFile(path, note.source)
    await api.storeUndoHistory(path, note.file, note.history)
  }
  // Before macOS 14, iCloud Drive swaps a file it evicts for `.name.icloud`.
  await fs.rename(evicted, join(root, 'Documents', '.b.md.icloud'))
  // A drive that isn't mounted leaves its mount point an empty folder.
  await fs.rm(unmounted)
  await fs.writeFile(join(root, 'flaky', 'other.txt'), '')
  await fs.rm(unsure)
  await api.pruneUndoHistory(0)
  for (const path of [unreadable, evicted, unmounted, unsure])
    assert.equal(await exists(kept(root, path)), true, path)
  // None counts as found missing, so none has a wait to serve.
  assert.deepEqual(await entries(root).catch(() => []), [
    unreadable,
    evicted,
    unmounted,
    unsure,
  ])
  // One recorded before and due now stays, and only a note there clears it.
  const paths = [unreadable, evicted, unmounted, unsure]
  await recorded(root, paths, today)
  setClock(today + 31 * day)
  const later = await main(root, {
    ...fs,
    stat: async (path, ...rest) => {
      if (path === unreadable || path === join(root, 'flaky', '.d.md.icloud'))
        throw Object.assign(new Error('EIO'), { code: 'EIO' })
      return fs.stat(path, ...rest)
    },
  })
  await later.pruneUndoHistory(0)
  for (const path of paths)
    assert.equal(await exists(kept(root, path)), true, path)
  assert.deepEqual(await records(root), {
    [unreadable]: today,
    [unmounted]: today,
    [unsure]: today,
  })
})

test('a quit waits for the histories a prune removes, not for the wait between its looks', async (t) => {
  const root = await profile(t)
  const path = join(root, 'a.md')
  const removed = Promise.withResolvers()
  let removing = false
  const api = await main(root, {
    ...fs,
    unlink: async (file, ...rest) => {
      if (file === kept(root, path)) {
        removing = true
        await removed.promise
      }
      return fs.unlink(file, ...rest)
    },
  })
  const note = saved()
  await fs.writeFile(path, note.source)
  await api.storeUndoHistory(path, note.file, note.history)
  await fs.rm(path)
  await recorded(root, [path], today)
  const later = await main(root, {
    ...fs,
    unlink: async (file, ...rest) => {
      if (file === kept(root, path)) {
        removing = true
        await removed.promise
      }
      return fs.unlink(file, ...rest)
    },
  })
  t.mock.method(Date, 'now', () => today + 31 * day)
  const pruning = later.pruneUndoHistory(300)
  await new Promise((resolve) => setTimeout(resolve, 50))
  let quit = false
  await later.undoHistoryWritten().then(() => {
    quit = true
  })
  assert.equal(quit, true)
  for (let tries = 0; !removing; tries++) {
    assert.ok(tries < 500, 'the history was never removed')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  quit = false
  const quitting = later.undoHistoryWritten().then(() => {
    quit = true
  })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(quit, false)
  removed.resolve()
  await Promise.all([quitting, pruning])
  assert.equal(await exists(kept(root, path)), false)
})

test('the first read of a launch that finds a stale history drops it from the index, and only it', async (t) => {
  const root = await profile(t)
  const api = await main(root)
  const note = saved()
  for (const path of ['/notes/a.md', '/notes/b.md'])
    await api.storeUndoHistory(path, note.file, note.history)
  const later = await main(root)
  assert.equal(
    await later.readUndoHistory('/notes/a.md', reopened('BASE ONE TWO')),
    null,
  )
  assert.deepEqual(await index(root), ['/notes/b.md'])
})

test('a prune that is the first task of a launch leaves nothing of the note', async (t) => {
  const root = await profile(t)
  const api = await main(root)
  const note = saved()
  const path = join(root, 'a.md')
  await fs.writeFile(path, note.source)
  await api.storeUndoHistory(path, note.file, note.history)
  // A crash cut short a write of its history.
  await fs.copyFile(
    kept(root, path),
    join(
      folder(root),
      `.${createHash('sha256').update(path).digest('hex')}.json.left.tmp`,
    ),
  )
  await fs.rm(path)
  await recorded(root, [path], today)
  t.mock.method(Date, 'now', () => today + 31 * day)
  const later = await main(root)
  await later.pruneUndoHistory(0)
  assert.deepEqual(await fs.readdir(folder(root)), [])
  assert.deepEqual(await index(root), [])
})

test('a note the index spells another way, or reached through a link, keeps its history', async (t) => {
  const root = await fs.realpath(await profile(t))
  const api = await main(root)
  const note = saved()
  const folders = ['notes', 'caf\u00e9', 'caf\u0065\u0301 2', 'elsewhere']
  for (const name of folders) {
    await fs.mkdir(join(root, name))
    await fs.writeFile(join(root, name, 'a.md'), note.source)
  }
  await fs.symlink(join(root, 'elsewhere'), join(root, 'linked'))
  await fs.symlink(join(root, 'not there'), join(root, 'dangling'))
  const paths = [join(root, 'linked', 'a.md'), join(root, 'dangling', 'a.md')]
  // A disk that folds case and unicode finds these under other spellings;
  // one that doesn't has other notes under them.
  if (await exists(join(root, 'NOTES'))) paths.push(join(root, 'NOTES', 'A.md'))
  if (await exists(join(root, 'caf\u0065\u0301')))
    paths.push(
      join(root, 'caf\u0065\u0301', 'a.md'),
      join(root, 'caf\u00e9 2', 'a.md'),
    )
  for (const path of paths)
    await api.storeUndoHistory(path, note.file, note.history)
  // Due to go, if any look took one for missing.
  await recorded(root, paths, today)
  t.mock.method(Date, 'now', () => today + 31 * day)
  await (await main(root)).pruneUndoHistory(0)
  for (const path of paths)
    assert.equal(await exists(kept(root, path)), true, path)
  assert.deepEqual(await index(root), [...paths].sort())
})

test('a clear, keeping off or a trash between the looks leaves nothing behind', async (t) => {
  for (const action of ['clear', 'off', 'trash']) {
    const root = await profile(t)
    const api = await main(root)
    const note = saved()
    const notes = join(root, 'notes')
    await fs.mkdir(notes)
    for (const name of ['a.md', 'b.md']) {
      await fs.writeFile(join(notes, name), note.source)
      await api.storeUndoHistory(join(notes, name), note.file, note.history)
    }
    await fs.rm(join(notes, 'a.md'))
    const pruning = api.pruneUndoHistory(100)
    await new Promise((resolve) => setTimeout(resolve, 30))
    if (action === 'clear') await api.clearUndoHistory()
    else if (action === 'off') await api.setKeepUndoHistory(false)
    else await api.removeUndoHistory(notes)
    await pruning
    assert.deepEqual(await fs.readdir(folder(root)).catch(() => []), [], action)
    // A clear's index stays gone: the second look writes none back.
    if (action === 'trash') assert.deepEqual(await index(root), [], action)
    else
      assert.equal(
        await exists(join(root, 'undo-history-notes.json')),
        false,
        action,
      )
  }
})

test('a history grown too large to keep leaves the index too', async (t) => {
  const root = await profile(t)
  const first = await main(root)
  const small = saved()
  for (const path of ['/notes/a.md', '/notes/b.md'])
    await first.storeUndoHistory(path, small.file, small.history)
  // Escaped, 6 MiB of control characters is 36 MiB of JSON. An editor keeps
  // less than that; the store doesn't take its word for it.
  const large = saved('base', ['\u0001'.repeat(6 * mib)], {
    historyBytes: 64 * mib,
  })
  const later = await main(root)
  await later.storeUndoHistory('/notes/a.md', large.file, large.history)
  assert.equal(await exists(kept(root, '/notes/a.md')), false)
  assert.deepEqual(await index(root), ['/notes/b.md'])
})
