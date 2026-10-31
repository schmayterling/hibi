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
/** A fresh main process over the same app data. */
async function main(root) {
  const module = { exports: {} }
  const require = createRequire(import.meta.url)
  new Function(
    'require',
    'module',
    'exports',
    (await bundle).outputFiles[0].text,
  )(
    (id) =>
      id === 'electron' ? { app: { getPath: () => root } } : require(id),
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
  await api.storeUndoHistory('/notes/a.md', note.file, note.history)
  const stored = JSON.parse(
    await fs.readFile(kept(root, '/notes/a.md'), 'utf8'),
  )
  assert.equal(stored.format, 1)
  assert.equal(
    stored.hash,
    createHash('sha256').update('base one two').digest('hex'),
  )
  // Another launch reads it for a tab that loaded the same text.
  const later = await main(root)
  assert.deepEqual(
    await later.readUndoHistory('/notes/a.md', reopened(note.source)),
    note.history,
  )
  assert.equal(
    await later.readUndoHistory('/notes/b.md', reopened(note.source)),
    null,
  )
})

test('a note changed outside Hibi drops its kept history without asking', async (t) => {
  const root = await profile(t)
  const api = await main(root)
  const note = saved()
  await api.storeUndoHistory('/notes/a.md', note.file, note.history)
  // Same length, other text.
  assert.equal(
    await api.readUndoHistory('/notes/a.md', reopened('BASE ONE TWO')),
    null,
  )
  assert.equal(await exists(kept(root, '/notes/a.md')), false)
})

test('an unreadable kept history is ignored and removed', async (t) => {
  const root = await profile(t)
  const api = await main(root)
  const note = saved()
  const path = kept(root, '/notes/a.md')
  const valid = async () => {
    await api.storeUndoHistory('/notes/a.md', note.file, note.history)
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
      await api.readUndoHistory('/notes/a.md', reopened(note.source)),
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
  await api.storeUndoHistory('/notes/a.md', newer, note.history)
  assert.equal(await exists(kept(root, '/notes/a.md')), false)
  await assert.rejects(
    api.storeUndoHistory('/notes/a.md', note.file, {
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
  await api.storeUndoHistory('/notes/new.md', note.file, note.history)
  assert.deepEqual(
    await Promise.all(older.map((path) => exists(kept(root, path)))),
    [false, true, true],
  )
  assert.equal(await exists(kept(root, '/notes/new.md')), true)
})

test('keeping turned off removes kept histories and keeps no new ones', async (t) => {
  const root = await profile(t)
  const api = await main(root)
  const note = saved()
  assert.equal(await api.keepsUndoHistory(), true)
  await api.storeUndoHistory('/notes/a.md', note.file, note.history)
  await api.setKeepUndoHistory(false)
  assert.equal(await exists(kept(root, '/notes/a.md')), false)
  const later = await main(root)
  assert.equal(await later.keepsUndoHistory(), false)
  await later.storeUndoHistory('/notes/a.md', note.file, note.history)
  assert.equal(await exists(kept(root, '/notes/a.md')), false)
  assert.equal(
    await later.readUndoHistory('/notes/a.md', reopened(note.source)),
    null,
  )
  await assert.rejects(later.setKeepUndoHistory('no'), /Invalid/)
  await later.setKeepUndoHistory(true)
  await later.storeUndoHistory('/notes/a.md', note.file, note.history)
  assert.equal(await exists(kept(root, '/notes/a.md')), true)
  await later.clearUndoHistory()
  assert.equal(await exists(folder(root)), false)
})

test('kept histories follow notes renamed or moved inside Hibi', async (t) => {
  const root = await profile(t)
  const api = await main(root)
  const note = saved()
  await api.storeUndoHistory('/notes/a.md', note.file, note.history)
  await api.relocateUndoHistory('/notes/a.md', '/notes/b.md')
  assert.equal(await exists(kept(root, '/notes/a.md')), false)
  assert.deepEqual(
    await api.readUndoHistory('/notes/b.md', reopened(note.source)),
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
  assert.equal(await exists(kept(root, '/notes/b.md')), true)
})
