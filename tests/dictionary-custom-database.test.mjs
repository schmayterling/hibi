import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { Worker } from 'node:worker_threads'
import { CustomWordDatabase } from '../src/addons/dictionary/custom-word-database.ts'

async function fixture(t, words = []) {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-custom-database-'))
  const file = join(profile, 'addon-storage', 'global', 'dictionary.json')
  const stores = []
  const workers = []
  await mkdir(join(profile, 'addon-storage', 'global'), { recursive: true })
  const legacy = async (value, revision = 4) => {
    const text = JSON.stringify({
      format: 1,
      entries: { 'custom-words': { version: 1, revision, value } },
    })
    await writeFile(file, text)
    return text
  }
  const original = await legacy(words)
  t.after(async () => {
    for (const worker of workers) await worker.terminate()
    for (const store of stores) store.close()
    await rm(profile, { recursive: true, force: true })
  })
  return {
    profile,
    workers,
    file,
    legacy,
    original,
    path: join(profile, 'dictionary-custom-words', 'words.sqlite'),
    async open() {
      const store = await CustomWordDatabase.open(profile)
      stores.push(store)
      return store
    },
  }
}
function save(store, upsert = [], remove = [], options = {}) {
  const { token } = store.change({ type: 'begin', revision: store.revision() })
  store.change({ type: 'stage', token, upsert, remove, ...options })
  return store.change({ type: 'commit', token })
}
function all(store) {
  const words = []
  let after = 0
  for (;;) {
    const page = store.page({ after })
    words.push(...page.words)
    if (!page.more) return words
    assert.ok(page.after > after)
    after = page.after
  }
}

test('new begin replaces abandoned staging; stale stage and lost abort cannot clear current token', async (t) => {
  const ctx = await fixture(t, [{ id: 'a', word: 'alpha' }])
  const store = await ctx.open()
  const old = store.change({ type: 'begin', revision: 1 }).token
  store.change({
    type: 'stage',
    token: old,
    upsert: [{ id: 'lost', word: 'lost' }],
    remove: [],
  })
  // A second connection can write while the renderer is between requests.
  const peer = new DatabaseSync(ctx.path)
  try {
    peer.exec('BEGIN IMMEDIATE; ROLLBACK')
  } finally {
    peer.close()
  }
  const token = store.change({ type: 'begin', revision: 1 }).token
  assert.notEqual(token, old)
  assert.throws(
    () => store.change({ type: 'stage', token: old, upsert: [], remove: [] }),
    /changed in another window/,
  )
  assert.deepEqual(store.change({ type: 'abort', token: old }), {})
  assert.deepEqual(store.change({ type: 'abort', token: 'never received' }), {})
  store.change({
    type: 'stage',
    token,
    upsert: [{ id: 'b', word: 'beta' }],
    remove: [],
  })
  store.change({ type: 'commit', token })
  assert.deepEqual(
    all(store).map(({ id }) => id),
    ['a', 'b'],
  )
  const bad = store.change({ type: 'begin', revision: 2 }).token
  assert.throws(
    () =>
      store.change({
        type: 'stage',
        token: bad,
        upsert: [{ word: 'no id' }],
        remove: [],
      }),
    /Invalid custom words/,
  )
  assert.deepEqual(store.change({ type: 'abort', token: bad }), {})
  save(store, [{ id: 'c', word: 'gamma' }])
  assert.equal(store.metadata().count, 3)
})

test('keyed reads, metadata, sparse ordinal offset pages and commit conflicts', async (t) => {
  const ctx = await fixture(t, [
    { id: 'a', word: 'alpha' },
    { id: 'b', word: 'beta' },
    { id: 'c', word: 'gamma' },
  ])
  const store = await ctx.open()
  assert.deepEqual(store.metadata(), { revision: 1, count: 3 })
  assert.deepEqual(store.get({ id: 'b' }), {
    revision: 1,
    word: { id: 'b', word: 'beta' },
  })
  assert.deepEqual(store.get({ id: 'missing' }), { revision: 1, word: null })
  save(store, [], ['b'])
  assert.equal(store.page({ offset: 1 }).words[0].id, 'c')
  assert.equal(store.page({ after: 1 }).words[0].id, 'c')
  assert.equal(store.page({ offset: 2 }).more, false)
  assert.throws(() => store.page({ offset: -1 }), /Invalid/)
  assert.throws(() => store.page({ offset: 1, after: 1 }), /Invalid/)
  assert.throws(() => store.page({ revision: 1 }), /changed in another window/)
  const peer = await ctx.open()
  const token = store.change({ type: 'begin', revision: 2 }).token
  store.change({
    type: 'stage',
    token,
    upsert: [{ id: 'a', word: 'alpha', note: 'stale' }],
    remove: [],
  })
  save(peer, [{ id: 'c', word: 'gamma', note: 'fresh' }])
  assert.throws(
    () => store.change({ type: 'commit', token }),
    /changed in another window/,
  )
  assert.equal(store.get({ id: 'a' }).word.note, undefined)
  save(store, [{ id: 'a', word: 'alpha', note: 'retry' }])
  assert.deepEqual(store.metadata(), { revision: 4, count: 2 })
})

test('merge retains ids and ordinal, last duplicate wins, add keeps absent note, import clears it', async (t) => {
  const ctx = await fixture(t, [
    { id: 'a', word: 'Café', lang: 'de', note: 'keep' },
  ])
  const store = await ctx.open()
  save(store, [{ id: 'ignored', word: 'CAFE\u0301', lang: 'de' }], [], {
    merge: true,
    keepNote: true,
  })
  assert.deepEqual(all(store), [
    { id: 'a', word: 'CAFÉ', lang: 'de', note: 'keep' },
  ])
  const token = store.change({
    type: 'begin',
    revision: store.revision(),
  }).token
  store.change({
    type: 'stage',
    token,
    merge: true,
    upsert: [
      { word: 'new', note: 'first' },
      { word: 'NEW', note: 'second' },
    ],
    remove: [],
  })
  store.change({
    type: 'stage',
    token,
    merge: true,
    upsert: [
      { word: 'new', note: 'last' },
      { word: 'café', lang: 'de' },
    ],
    remove: [],
  })
  store.change({ type: 'commit', token })
  const words = all(store)
  assert.equal(words.length, 2)
  assert.equal(words[0].id, 'a')
  assert.equal(words[0].note, undefined)
  assert.equal(words[1].note, 'last')
  assert.ok(words[1].id)
  assert.equal(store.page({ offset: 1 }).words[0].id, words[1].id)
  save(store, [{ id: 'supplied', word: 'supplied' }], [], { merge: true })
  assert.equal(store.lookup({ term: 'supplied', lang: '' })[0].id, 'supplied')
  assert.throws(
    () => save(store, [{ id: 'supplied', word: 'new' }]),
    /changed in another window|Invalid custom words/,
  )
  assert.equal(store.get({ id: 'supplied' }).word.word, 'supplied')
  assert.equal(store.metadata().count, 3)
  save(store, [{ id: 'supplied', word: 'renamed', note: 'single' }])
  assert.equal(store.get({ id: 'supplied' }).word.word, 'renamed')
})

test('legacy and keyed notes preserve embedded NUL text through SQLite and reopen', async (t) => {
  const ctx = await fixture(t, [
    { id: 'a', word: 'alpha', note: 'legacy\u0000tail' },
  ])
  let store = await ctx.open()
  assert.equal(store.get({ id: 'a' }).word.note, 'legacy\u0000tail')
  save(store, [{ id: 'a', word: 'alpha', note: '\u0000new\u0000tail' }])
  save(store, [{ word: 'ALPHA' }], [], { merge: true, keepNote: true })
  assert.equal(store.get({ id: 'a' }).word.note, '\u0000new\u0000tail')
  assert.equal(
    store.complete({ prefix: 'al', langs: [], limit: 1 })[0].note,
    '\u0000new\u0000tail',
  )
  store.close()
  store = await ctx.open()
  assert.equal(store.page({}).words[0].note, '\u0000new\u0000tail')
  save(store, [{ word: 'alpha', note: '' }], [], {
    merge: true,
    keepNote: true,
  })
  assert.equal(store.get({ id: 'a' }).word.note, undefined)
})

test('malformed schema recovers without leaking SQLite errors or replacing quarantined bytes', async (t) => {
  const ctx = await fixture(t, [{ word: 'legacy' }])
  await mkdir(join(ctx.profile, 'dictionary-custom-words'), { recursive: true })
  const raw = new DatabaseSync(ctx.path)
  raw.exec('CREATE TABLE words (bad TEXT)')
  raw.close()
  const original = await readFile(ctx.path)
  const store = await ctx.open()
  assert.equal(store.metadata().count, 1)
  assert.ok(store.metadata().notice)
  const folder = (
    await readdir(join(ctx.profile, 'dictionary-custom-words'))
  ).find((name) => name.startsWith('quarantine-'))
  assert.deepEqual(
    await readFile(
      join(ctx.profile, 'dictionary-custom-words', folder, 'words.sqlite'),
    ),
    original,
  )
})

test('first merge streams across batches with cumulative unique counts and commit metadata', async (t) => {
  const ctx = await fixture(t, [{ id: 'kept', word: 'alpha', note: 'old' }])
  const store = await ctx.open()
  const token = store.change({ type: 'begin', revision: 1 }).token
  assert.deepEqual(
    store.change({
      type: 'stage',
      token,
      merge: true,
      first: true,
      upsert: [
        { word: 'ALPHA', note: 'first' },
        { word: 'alpha', note: 'ignored' },
        { word: 'beta' },
      ],
      remove: [],
    }),
    { count: 2 },
  )
  assert.deepEqual(
    store.change({
      type: 'stage',
      token,
      merge: true,
      first: true,
      upsert: [
        { word: 'Alpha', note: 'also ignored' },
        { word: 'BETA', note: 'ignored' },
      ],
      remove: [],
    }),
    { count: 2 },
  )
  assert.deepEqual(store.change({ type: 'commit', token }), {
    revision: 2,
    count: 2,
    changed: 2,
  })
  assert.deepEqual(store.get({ id: 'kept' }).word, {
    id: 'kept',
    word: 'ALPHA',
    note: 'first',
  })
  assert.equal(all(store)[1].word, 'beta')
})

test('old state schema upgrades once without replacing newer keyed data from untracked legacy', async (t) => {
  const ctx = await fixture(t, [
    { id: 'a', word: 'alpha', note: 'legacy' },
    { id: 'b', word: 'beta' },
  ])
  await mkdir(join(ctx.profile, 'dictionary-custom-words'), { recursive: true })
  const raw = new DatabaseSync(ctx.path)
  raw.exec(`
    CREATE TABLE words (
      ordinal INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
      word TEXT NOT NULL, term TEXT NOT NULL, lang TEXT NOT NULL, note TEXT,
      UNIQUE (term, lang)
    );
    CREATE TABLE state (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL);
    INSERT INTO state VALUES (1, 7);
    INSERT INTO words VALUES (1, 'a', 'alpha', 'alpha', '', 'newer');
  `)
  raw.close()
  let store = await ctx.open()
  assert.equal(store.metadata().count, 2)
  assert.equal(store.get({ id: 'a' }).word.note, 'newer')
  store.close()
  store = await ctx.open()
  assert.equal(store.metadata().count, 2)
  assert.equal(store.metadata().revision, 8)
})

test('failed commit rolls back and clears token; close discards staging', async (t) => {
  const ctx = await fixture(t, [{ id: 'a', word: 'alpha', note: 'original' }])
  let store = await ctx.open()
  const raw = new DatabaseSync(ctx.path)
  raw.exec(
    "CREATE TRIGGER fail_write BEFORE INSERT ON words BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
  )
  assert.throws(
    () => save(store, [{ id: 'a', word: 'alpha', note: 'changed' }]),
    /original data has been kept|changed in another window/,
  )
  assert.equal(store.get({ id: 'a' }).word.note, 'original')
  assert.deepEqual(store.metadata(), { revision: 1, count: 1 })
  raw.exec('DROP TRIGGER fail_write')
  raw.close()
  save(store, [{ id: 'a', word: 'alpha', note: 'saved' }])
  const token = store.change({ type: 'begin', revision: 2 }).token
  store.change({ type: 'stage', token, upsert: [], remove: ['a'] })
  store.close()
  store = await ctx.open()
  assert.equal(store.get({ id: 'a' }).word.note, 'saved')
  save(store, [], ['a'])
  assert.equal(store.metadata().count, 0)
})

test('completion chooses shortest across all matches and stable source ties; surrogate boundary stays exact', async (t) => {
  const words = Array.from({ length: 80 }, (_, i) => ({
    id: `long${i}`,
    word: `aa${String(i).padStart(3, '0')}long`,
  }))
  words.push(
    { id: 'de', word: 'az', lang: 'de' },
    { id: 'global', word: 'ay' },
    { id: 'en', word: 'ax', lang: 'en' },
    { id: 'boundary', word: '\uD7FFx' },
    { id: 'wrong', word: '\uE000x' },
    { id: 'astral', word: 'a😀' },
    { id: 'bmp-two', word: 'at' },
    { id: 'bmp', word: 'abz' },
  )
  const ctx = await fixture(t, words)
  const store = await ctx.open()
  assert.deepEqual(
    store
      .complete({ prefix: 'a', langs: ['en', 'de'], limit: 5 })
      .map(({ id }) => id),
    ['de', 'global', 'en', 'astral', 'bmp-two'],
  )
  assert.deepEqual(
    store.complete({ prefix: 'a', langs: [], limit: 3 }).map(({ id }) => id),
    ['global', 'astral', 'bmp-two'],
    'astral characters count once; equal character lengths retain source order',
  )
  assert.deepEqual(
    store
      .complete({ prefix: '\uD7FF', langs: [], limit: 64 })
      .map(({ id }) => id),
    ['boundary'],
  )
  assert.throws(
    () => store.complete({ prefix: 'a'.repeat(129), langs: [], limit: 1 }),
    /Invalid/,
  )
})

test('pages count actual serialized envelope bytes, handle long records and never claim phantom next page', async (t) => {
  const ctx = await fixture(t)
  const store = await ctx.open()
  for (let batch = 0; batch < 2; batch++)
    save(
      store,
      Array.from({ length: 256 }, (_, i) => ({
        id: `w${batch * 256 + i}`,
        word: `word${batch * 256 + i}`,
      })),
    )
  let page = store.page({ offset: 256 })
  assert.equal(page.words.length, 256)
  assert.equal(page.more, false)
  save(store, [
    { id: 'long1', word: 'long1', note: '界'.repeat(180000) },
    { id: 'long2', word: 'long2', note: '界'.repeat(180000) },
  ])
  page = store.page({ offset: 512 })
  assert.equal(page.words.length, 1)
  assert.equal(page.more, true)
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 1024 * 1024)
  save(store, [
    {
      id: 'envelope',
      word: 'envelope',
      note: 'x'.repeat(16 * 1024 * 1024 - 200),
    },
  ])
  page = store.page({ offset: 514 })
  assert.equal(page.words.length, 1)
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 16 * 1024 * 1024)
  assert.equal(page.more, false)
})

test('migration regenerates duplicate legacy ids, and downgrade merge preserves database-only words', async (t) => {
  const ctx = await fixture(t, [
    { id: 'same', word: 'alpha' },
    { id: 'same', word: 'beta' },
  ])
  let store = await ctx.open()
  assert.equal(store.metadata().count, 2)
  assert.equal(new Set(all(store).map(({ id }) => id)).size, 2)
  const alpha = store.lookup({ term: 'alpha', lang: '' })[0]
  save(store, [{ id: 'newer', word: 'newer' }])
  store.close()
  const changed = await ctx.legacy(
    [{ id: 'old', word: 'ALPHA', note: 'downgrade' }, { word: 'older-only' }],
    5,
  )
  store = await ctx.open()
  assert.equal(store.metadata().revision, 3)
  assert.equal(store.metadata().count, 4)
  assert.ok(store.metadata().notice)
  assert.equal(store.lookup({ term: 'alpha', lang: '' })[0].id, alpha.id)
  assert.equal(store.lookup({ term: 'alpha', lang: '' })[0].note, 'downgrade')
  assert.equal(await readFile(ctx.file, 'utf8'), changed)
  store.close()
  store = await ctx.open()
  assert.equal(
    store.metadata().revision,
    3,
    'same legacy revision is merged only once',
  )
  store.close()
  await writeFile(ctx.file, '{broken')
  store = await ctx.open()
  assert.equal(store.metadata().count, 4)
  assert.ok(store.metadata().notice)
})

test('malformed database is quarantined with bytes and sidecars preserved; warning survives reopen', async (t) => {
  const ctx = await fixture(t, [{ word: 'legacy' }])
  await mkdir(join(ctx.profile, 'dictionary-custom-words'), { recursive: true })
  const corrupt = Buffer.from('not a sqlite database'.repeat(100))
  await writeFile(ctx.path, corrupt)
  await writeFile(`${ctx.path}-wal`, 'wal bytes')
  await writeFile(`${ctx.path}-shm`, 'shm bytes')
  let store = await ctx.open()
  assert.deepEqual(
    all(store).map(({ word }) => word),
    ['legacy'],
  )
  assert.ok(store.metadata().notice)
  const folder = (
    await readdir(join(ctx.profile, 'dictionary-custom-words'))
  ).find((name) => name.startsWith('quarantine-'))
  assert.ok(folder)
  const quarantined = join(ctx.profile, 'dictionary-custom-words', folder)
  assert.deepEqual(await readFile(join(quarantined, 'words.sqlite')), corrupt)
  assert.equal(
    await readFile(join(quarantined, 'words.sqlite-wal'), 'utf8'),
    'wal bytes',
  )
  assert.equal(
    await readFile(join(quarantined, 'words.sqlite-shm'), 'utf8'),
    'shm bytes',
  )
  assert.equal(await readFile(ctx.file, 'utf8'), ctx.original)
  store.close()
  store = await ctx.open()
  assert.ok(store.metadata().notice)
})

test('invalid legacy never publishes a filtered migration; valid database survives invalid legacy', async (t) => {
  const ctx = await fixture(t, [{ word: 'kept' }, { word: 'bad\u0000' }])
  await assert.rejects(ctx.open(), /original data has been kept/)
  await ctx.legacy([{ word: 'valid' }])
  const store = await ctx.open()
  assert.equal(store.metadata().count, 1)
  store.close()
  await ctx.legacy([{ word: 'kept' }, { word: 'bad\u0000' }], 5)
  const reopened = await ctx.open()
  assert.equal(reopened.metadata().count, 1)
  assert.equal(reopened.page({}).words[0].word, 'valid')
  assert.ok(reopened.metadata().notice)
})

test('symlinked database, sidecars and legacy path are refused without following links', async (t) => {
  const ctx = await fixture(t)
  await mkdir(join(ctx.profile, 'dictionary-custom-words'), { recursive: true })
  await symlink(ctx.file, ctx.path)
  await assert.rejects(ctx.open(), /original data has been kept/)
  assert.equal(await readFile(ctx.file, 'utf8'), ctx.original)
})

test('metadata and one-note edit use indexed work without full count scan or list reads', async (t) => {
  const ctx = await fixture(
    t,
    Array.from({ length: 2048 }, (_, i) => ({
      id: `id${i}`,
      word: `word${i}`,
    })),
  )
  const store = await ctx.open()
  const sql = []
  const prepare = DatabaseSync.prototype.prepare
  const exec = DatabaseSync.prototype.exec
  t.mock.method(DatabaseSync.prototype, 'prepare', function (text) {
    sql.push(text)
    return prepare.call(this, text)
  })
  t.mock.method(DatabaseSync.prototype, 'exec', function (text) {
    sql.push(text)
    return exec.call(this, text)
  })
  assert.equal(store.metadata().count, 2048)
  const word = store.get({ id: 'id2047' }).word
  save(store, [{ ...word, note: 'one record' }])
  assert.equal(store.metadata().count, 2048)
  assert.ok(
    !sql.some((query) =>
      /count\s*\(\s*\*\s*\)\s+(?:as\s+\w+\s+)?from\s+words\b/i.test(query),
    ),
  )
  assert.ok(!sql.some((query) => /SELECT \* FROM words\s*(?:;|$)/i.test(query)))
  const raw = new DatabaseSync(ctx.path)
  try {
    assert.ok(
      raw
        .prepare('EXPLAIN QUERY PLAN SELECT * FROM words WHERE id = ?')
        .all('id2047')
        .some(({ detail }) => detail.includes('SEARCH')),
    )
  } finally {
    raw.close()
  }
})

test('interrupted commit rolls back on reopen without losing original words or revision', async (t) => {
  const ctx = await fixture(t, [{ id: 'a', word: 'alpha', note: 'original' }])
  const first = await ctx.open()
  first.close()
  const worker = new Worker(
    `
    const { parentPort, workerData } = require('node:worker_threads')
    const { DatabaseSync } = require('node:sqlite')
    const run = DatabaseSync.prototype.exec
    DatabaseSync.prototype.exec = function(sql) {
      if (/COMMIT/i.test(sql) && !/CREATE/i.test(sql)) {
        parentPort.postMessage('commit-held')
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
      }
      return run.call(this, sql)
    }
    import(workerData.module).then(async ({ CustomWordDatabase }) => {
      const store = await CustomWordDatabase.open(workerData.profile)
      const { token } = store.change({ type: 'begin', revision: 1 })
      store.change({ type: 'stage', token, upsert: [{ id: 'a', word: 'alpha', note: 'interrupted' }], remove: [] })
      store.change({ type: 'commit', token })
    })
  `,
    {
      eval: true,
      workerData: {
        profile: ctx.profile,
        module: new URL(
          '../src/addons/dictionary/custom-word-database.ts',
          import.meta.url,
        ).href,
      },
    },
  )
  ctx.workers.push(worker)
  await new Promise((resolve, reject) => {
    worker.once('message', resolve)
    worker.once('error', reject)
    worker.once('exit', (code) =>
      reject(new Error(`worker exited early: ${code}`)),
    )
  })
  await worker.terminate()
  const store = await ctx.open()
  assert.deepEqual(store.metadata(), { revision: 1, count: 1 })
  assert.equal(store.get({ id: 'a' }).word.note, 'original')
  save(store, [{ id: 'a', word: 'alpha', note: 'recovered' }])
  assert.equal(store.get({ id: 'a' }).word.note, 'recovered')
})
