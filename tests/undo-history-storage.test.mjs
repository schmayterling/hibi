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
function saved(text = 'base', edits = [' one', ' two']) {
  const session = new DocumentSession(text, { tabId: 'n', revision: 0 }, 0, {
    enqueue() {},
    onError(error) {
      throw error
    },
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
