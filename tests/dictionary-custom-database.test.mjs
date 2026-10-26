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
    /This word already exists in that language/,
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
  const revision = store.revision()
  assert.deepEqual(store.change({ type: 'dismissNotice' }), {
    revision,
    count: 1,
  })
  store.close()
  store = await ctx.open()
  assert.equal(
    store.metadata().notice,
    undefined,
    'quarantine does not recreate dismissed notice',
  )
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
  assert.equal(reopened.metadata().notice, undefined)
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

test('legacy three-way merge preserves newer fields and deletions across re-upgrades', async (t) => {
  const old = [
    { id: 'z', word: 'zorp', note: 'old note' },
    { id: 'k', word: 'kilig' },
    { id: 'd', word: 'deleteme' },
    { id: 'independent', word: 'mixed', note: 'base' },
    { id: 'language', word: 'language', lang: 'en', note: 'base' },
  ]
  const ctx = await fixture(t, old)
  let store = await ctx.open()
  save(
    store,
    [
      { id: 'z', word: 'Zorp', note: 'NEWER note' },
      { id: 'independent', word: 'Mixed', note: 'base' },
      { id: 'language', word: 'language', lang: 'de', note: 'base' },
    ],
    ['d'],
  )
  store.close()
  await ctx.legacy(
    [
      ...old.slice(0, 3),
      { id: 'independent', word: 'mixed', note: 'legacy\u0000delta' },
      { id: 'language', word: 'language', lang: 'fr', note: 'legacy note' },
      { id: 'o', word: 'oldbuild' },
    ],
    5,
  )
  store = await ctx.open()
  assert.deepEqual(
    store.get({ id: 'z' }).word,
    {
      id: 'z',
      word: 'Zorp',
      note: 'NEWER note',
    },
    'reviewer probe: unchanged legacy fields cannot overwrite newer edits',
  )
  assert.equal(store.get({ id: 'd' }).word, null)
  assert.deepEqual(store.get({ id: 'independent' }).word, {
    id: 'independent',
    word: 'Mixed',
    note: 'legacy\u0000delta',
  })
  assert.deepEqual(store.get({ id: 'language' }).word, {
    id: 'language',
    word: 'language',
    lang: 'de',
    note: 'legacy note',
  })
  assert.equal(store.get({ id: 'o' }).word.word, 'oldbuild')
  store.close()
  await ctx.legacy(
    [
      { id: 'z', word: 'ZORP', note: 'legacy conflicting note' },
      { id: 'd', word: 'DELETEME', note: 'still deleted' },
      { id: 'independent', word: 'mixed', note: 'second delta' },
    ],
    6,
  )
  store = await ctx.open()
  assert.equal(store.get({ id: 'z' }).word.word, 'Zorp')
  assert.equal(store.get({ id: 'z' }).word.note, 'NEWER note')
  assert.equal(store.get({ id: 'd' }).word, null)
  assert.equal(
    store.get({ id: 'k' }).word.word,
    'kilig',
    'legacy absence never implies deletion',
  )
  assert.equal(store.get({ id: 'independent' }).word.note, 'second delta')
  const revision = store.revision()
  store.close()
  store = await ctx.open()
  assert.equal(store.revision(), revision)
})

test('legacy merge preserves current key collisions and does not alias reused legacy ids', async (t) => {
  const ctx = await fixture(t, [
    { id: 'a', word: 'alpha', lang: 'en', note: 'base' },
  ])
  let store = await ctx.open()
  save(store, [{ id: 'b', word: 'alpha', lang: 'de', note: 'newer' }])
  store.close()
  await ctx.legacy([{ id: 'a', word: 'alpha', lang: 'de', note: 'legacy' }], 5)
  store = await ctx.open()
  assert.deepEqual(store.get({ id: 'a' }).word, {
    id: 'a',
    word: 'alpha',
    lang: 'en',
    note: 'legacy',
  })
  assert.equal(store.get({ id: 'b' }).word.note, 'newer')
  store.close()
  await ctx.legacy(
    [
      { id: 'a', word: 'alpha', lang: 'de', note: 'next' },
      { id: 'a', word: 'different' },
    ],
    6,
  )
  store = await ctx.open()
  assert.equal(store.metadata().count, 3)
  assert.equal(store.get({ id: 'a' }).word.note, 'next')
  assert.equal(store.lookup({ term: 'different', lang: '' }).length, 1)
  assert.notEqual(store.lookup({ term: 'different', lang: '' })[0].id, 'a')
})

test('notice dismissal persists without a token, revision change or discarded staging', async (t) => {
  const ctx = await fixture(t, [{ id: 'a', word: 'alpha' }])
  let store = await ctx.open()
  store.close()
  await ctx.legacy(
    [
      { id: 'a', word: 'alpha' },
      { id: 'b', word: 'beta' },
    ],
    5,
  )
  store = await ctx.open()
  assert.ok(store.metadata().notice)
  const before = store.metadata()
  const { token } = store.change({ type: 'begin', revision: before.revision })
  store.change({
    type: 'stage',
    token,
    upsert: [{ id: 'c', word: 'gamma' }],
    remove: [],
  })
  assert.deepEqual(store.change({ type: 'dismissNotice' }), {
    revision: before.revision,
    count: before.count,
  })
  store.change({ type: 'commit', token })
  store.close()
  store = await ctx.open()
  assert.equal(store.metadata().notice, undefined)
  assert.equal(store.get({ id: 'c' }).word.word, 'gamma')
  store.close()
  await writeFile(ctx.file, '{broken')
  store = await ctx.open()
  assert.equal(
    store.metadata().notice,
    undefined,
    'unreadable legacy does not stamp healthy store',
  )
})

test('duplicate language/key has its own error and leaves both records intact', async (t) => {
  const ctx = await fixture(t, [
    { id: 'en', word: 'same', lang: 'en' },
    { id: 'de', word: 'same', lang: 'de' },
  ])
  const store = await ctx.open()
  assert.throws(() => save(store, [{ id: 'en', word: 'same', lang: 'de' }]), {
    message: 'This word already exists in that language.',
  })
  assert.deepEqual(
    all(store).map(({ lang }) => lang),
    ['en', 'de'],
  )
})

test('completion races indexed ranges without full sorting at one million same-length words', async (t) => {
  const ctx = await fixture(t)
  const store = await ctx.open()
  const raw = new DatabaseSync(ctx.path)
  t.after(() => raw.close())
  raw.exec(`
    BEGIN;
    WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i + 1 FROM n WHERE i < 999999)
    INSERT INTO words (id, word, term, lang)
    SELECT 'id' || i, 'a' || printf('%07d', i), 'a' || printf('%07d', i), '' FROM n;
    UPDATE state SET count = 1000000 WHERE id = 1;
    COMMIT;
  `)
  const work = completionWork(t)
  const start = performance.now()
  assert.deepEqual(
    store.complete({ prefix: 'a', langs: [], limit: 5 }).map(({ id }) => id),
    ['id0', 'id1', 'id2', 'id3', 'id4'],
  )
  t.diagnostic(
    `1m same-length broad prefix: ${work.visits} indexed row visits, ${work.records} full records, ${(performance.now() - start).toFixed(2)} ms`,
  )
  assert.equal(work.visits, 11)
  assert.equal(work.records, 5)
  assert.equal(work.openIterators, 0)
  assert.ok(
    [...work.plans].some(
      (detail) =>
        detail.includes('words_length_prefix') &&
        detail.includes('term>? AND term<?'),
    ),
  )
  assert.ok([...work.plans].some((detail) => detail.includes('words_rank')))
  assert.ok(
    [...work.plans].every(
      (detail) =>
        detail.startsWith('SEARCH') && !detail.includes('TEMP B-TREE'),
    ),
  )
  t.diagnostic([...work.plans].join('\n'))
  work.visits = 0
  assert.deepEqual(
    store
      .complete({ prefix: 'a099999', langs: [], limit: 5 })
      .map(({ id }) => id),
    ['id999990', 'id999991', 'id999992', 'id999993', 'id999994'],
  )
  assert.equal(
    work.visits,
    21,
    'sparse prefix finishes without scanning rank index to its tail',
  )
  assert.equal(work.openIterators, 0)
  work.visits = 0
  assert.deepEqual(
    store.complete({ prefix: 'missing', langs: [], limit: 5 }),
    [],
  )
  assert.equal(work.visits, 1, 'one length seek, no prefix matches')
})

function completionWork(t) {
  const work = {
    steps: 0,
    visits: 0,
    records: 0,
    openIterators: 0,
    plans: new Set(),
  }
  const prepare = DatabaseSync.prototype.prepare
  t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) {
    const statement = prepare.call(this, sql)
    if (/^SELECT \* FROM words WHERE (?:id|ordinal) =/.test(sql)) {
      const get = statement.get.bind(statement)
      statement.get = (...args) => {
        work.records++
        return get(...args)
      }
    }
    if (!/FROM words INDEXED BY/.test(sql)) return statement
    const plan = (...args) => {
      for (const { detail } of prepare
        .call(this, `EXPLAIN QUERY PLAN ${sql}`)
        .all(...args))
        work.plans.add(detail)
    }
    const get = statement.get.bind(statement)
    statement.get = (...args) => {
      plan(...args)
      work.steps++
      const row = get(...args)
      if (row) work.visits++
      return row
    }
    const iterate = statement.iterate.bind(statement)
    statement.iterate = function* (...args) {
      plan(...args)
      work.openIterators++
      const rows = iterate(...args)
      try {
        for (;;) {
          work.steps++
          const row = rows.next()
          if (row.done) break
          work.visits++
          yield row.value
        }
      } finally {
        rows.return?.()
        work.openIterators--
      }
    }
    return statement
  })
  return work
}

test('completion skips unrelated lengths at one million skewed words', async (t) => {
  const ctx = await fixture(t)
  const store = await ctx.open()
  const raw = new DatabaseSync(ctx.path)
  try {
    raw.function('base36', (n) => n.toString(36))
    raw.exec(`
      BEGIN;
      WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i + 1 FROM n WHERE i < 999999)
      INSERT INTO words (id, word, term, lang)
      SELECT 'id' || i,
        CASE WHEN i % 2 THEN 'b' || base36(i) ELSE 'con' || base36(i) || 'xxxxxxxxxxxxxxxxxxxx' END,
        CASE WHEN i % 2 THEN 'b' || base36(i) ELSE 'con' || base36(i) || 'xxxxxxxxxxxxxxxxxxxx' END, '' FROM n;
      UPDATE state SET count = 1000000 WHERE id = 1;
      COMMIT;
    `)
  } finally {
    raw.close()
  }
  const work = completionWork(t)
  for (const prefix of ['con', 'con1']) {
    const expected = []
    // Numeric order is length then source ordinal for this base36 fixture.
    for (let n = 0; n < 1_000_000 && expected.length < 64; n += 2)
      if (`con${n.toString(36)}${'x'.repeat(20)}`.startsWith(prefix))
        expected.push(`id${n}`)
    work.steps = 0
    work.visits = 0
    work.records = 0
    const start = performance.now()
    assert.deepEqual(
      store.complete({ prefix, langs: ['en'], limit: 64 }).map(({ id }) => id),
      expected,
    )
    t.diagnostic(
      `1m skewed '${prefix}': ${work.steps} read steps, ${work.visits} indexed row visits, ${work.records} full records, ${(performance.now() - start).toFixed(2)} ms`,
    )
    assert.ok(
      work.steps < 4096,
      `used ${work.steps} read steps for '${prefix}'`,
    )
    assert.equal(work.records, 64)
    assert.equal(work.openIterators, 0)
  }
  t.diagnostic([...work.plans].join('\n'))
  assert.ok([...work.plans].every((detail) => !detail.includes('TEMP B-TREE')))
})

test('completion bounds all bucket and iterator steps across languages on same-length skew', async (t) => {
  const ctx = await fixture(t, [
    { id: 'selected', word: 'con000000', lang: 'en' },
  ])
  const store = await ctx.open()
  const raw = new DatabaseSync(ctx.path)
  try {
    raw.exec(`
      BEGIN;
      WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i + 1 FROM n WHERE i < 11999)
      INSERT INTO words (id, word, term, lang)
      SELECT 'id' || i,
        CASE WHEN i < 6000 THEN 'bad' || printf('%06d', i) ELSE 'con' || printf('%06d', 11999 - i) END,
        CASE WHEN i < 6000 THEN 'bad' || printf('%06d', i) ELSE 'con' || printf('%06d', 11999 - i) END, '' FROM n;
      UPDATE state SET count = 12001 WHERE id = 1;
      COMMIT;
    `)
  } finally {
    raw.close()
  }
  const work = completionWork(t)
  const start = performance.now()
  const got = store.complete({
    prefix: 'con',
    langs: ['en', 'de', 'fr'],
    limit: 64,
  })
  t.diagnostic(
    `same-length skew guard: ${work.steps} total read steps, ${work.visits} indexed row visits, ${work.records} full records, ${(performance.now() - start).toFixed(2)} ms`,
  )
  assert.equal(
    work.steps,
    4096,
    'one shared budget includes length seeks and both iterators',
  )
  assert.equal(work.visits, 4096)
  assert.equal(work.openIterators, 0)
  assert.equal(work.records, 64, 'only final results materialize full records')
  assert.deepEqual(
    got.map(({ id }) => id),
    Array.from({ length: 64 }, (_, i) => `id${9952 + i}`),
  )
  assert.ok(
    !got.some(({ id }) => id === 'selected'),
    'exhaustion can omit a better unseen language/source match',
  )
  assert.ok(got.every(({ word }) => word.startsWith('con')))
  assert.ok(
    [...work.plans].every(
      (detail) =>
        detail.startsWith('SEARCH') && !detail.includes('TEMP B-TREE'),
    ),
  )
  assert.equal(store.metadata().count, 12001)
  assert.equal(
    store.lookup({ term: 'con000000', lang: 'en' })[0].id,
    'selected',
  )
})

test('completion matches seeded brute-force top-k through edits and index upgrade', async (t) => {
  let seed = 7
  const rand = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
    return seed / 2 ** 32
  }
  const alphabet = ['a', 'b', 'c', 'é', 'É', 'ß', '😀', 'İ', 'ﬁ', 'x']
  const languages = ['', 'en', 'de', 'fr']
  const seen = new Set()
  const words = [
    { id: 'expanded', word: 'İx' },
    { id: 'boundary', word: '\uD7FFx' },
    { id: 'max', word: '\u{10FFFF}x' },
    { id: 'nested', word: 'a\u{10FFFF}x' },
  ]
  for (const row of words)
    seen.add(JSON.stringify([row.word.toLowerCase(), '']))
  while (words.length < 6000) {
    let spelling = ''
    const size = 1 + Math.floor(rand() * 7)
    for (let i = 0; i < size; i++)
      spelling += alphabet[Math.floor(rand() * alphabet.length)]
    const word = spelling.normalize('NFC')
    const lang = languages[Math.floor(rand() * languages.length)]
    const key = JSON.stringify([word.toLowerCase(), lang])
    if (seen.has(key)) continue
    seen.add(key)
    words.push({ id: `id${words.length}`, word, ...(lang ? { lang } : {}) })
  }
  const ctx = await fixture(t)
  let store = await ctx.open()
  save(store, words)
  const raw = new DatabaseSync(ctx.path)
  t.after(() => raw.close())
  const prefixes = [
    'a',
    'b',
    'é',
    'É',
    'ß',
    'ss',
    '😀',
    'i',
    'İ',
    'ﬁ',
    'fi',
    'ab',
    'ca',
    'x',
    'xa',
    'aé',
    'zz',
    '\uD7FF',
    '\u{10FFFF}',
    'a\u{10FFFF}',
  ]
  let comparisons = 0
  const check = () => {
    const rows = raw
      .prepare('SELECT ordinal, id, word, term, lang FROM words')
      .all()
    for (const prefix of prefixes)
      for (const langs of [[], ['en'], ['de', 'fr'], ['en', 'de', 'fr', 'en']])
        for (const limit of [1, 5, 64]) {
          const term = prefix.normalize('NFC').toLowerCase()
          const expected = rows
            .filter(
              (row) =>
                (row.lang === '' || langs.includes(row.lang)) &&
                row.term !== term &&
                row.term.startsWith(term),
            )
            .sort(
              (a, b) =>
                [...a.word].length - [...b.word].length ||
                a.ordinal - b.ordinal,
            )
            .slice(0, limit)
            .map(({ id }) => id)
          assert.deepEqual(
            store.complete({ prefix, langs, limit }).map(({ id }) => id),
            expected,
            JSON.stringify({ prefix, langs, limit }),
          )
          comparisons++
        }
  }
  check()
  save(
    store,
    words.slice(0, 300).map((word) => ({ ...word, word: `${word.word}q` })),
    words.slice(300, 400).map(({ id }) => id),
  )
  save(store, words.slice(300, 350))
  const before = store.metadata()
  const base = raw.prepare('SELECT * FROM legacy_base').all()
  store.close()
  // Simulate the previous schema: a new expression index must not recover or migrate data.
  raw.exec('DROP INDEX IF EXISTS words_length_prefix')
  store = await ctx.open()
  assert.deepEqual(store.metadata(), before)
  assert.deepEqual(raw.prepare('SELECT * FROM legacy_base').all(), base)
  assert.equal(await readFile(ctx.file, 'utf8'), ctx.original)
  check()
  t.diagnostic(`seeded brute-force top-k: ${comparisons}/${comparisons} equal`)
})

test('completion keeps codepoint boundaries and exact exclusion in the ranked path', async (t) => {
  const words = [
    { id: 'exact', word: '\u{10FFFF}' },
    ...Array.from({ length: 80 }, (_, i) => ({
      id: `max${i}`,
      word: `\u{10FFFF}${i}`,
    })),
    { id: 'wrong', word: '\uE000wrong' },
    { id: 'nested', word: `a\u{10FFFF}x` },
  ]
  const ctx = await fixture(t, words)
  const store = await ctx.open()
  assert.deepEqual(
    store
      .complete({ prefix: '\u{10FFFF}', langs: [], limit: 3 })
      .map(({ id }) => id),
    ['max0', 'max1', 'max2'],
  )
  assert.deepEqual(
    store
      .complete({ prefix: `a\u{10FFFF}`, langs: [], limit: 3 })
      .map(({ id }) => id),
    ['nested'],
  )
})

test('killed legacy merge rolls back words, durable base and legacy revision together', async (t) => {
  const old = [{ id: 'a', word: 'alpha', note: 'base' }]
  const ctx = await fixture(t, old)
  const first = await ctx.open()
  save(first, [{ id: 'new', word: 'newer only' }])
  first.close()
  await ctx.legacy([{ id: 'a', word: 'ALPHA', note: 'legacy\u0000delta' }], 5)
  const worker = new Worker(
    `
    const { parentPort, workerData } = require('node:worker_threads')
    const { DatabaseSync } = require('node:sqlite')
    const prepare = DatabaseSync.prototype.prepare
    DatabaseSync.prototype.prepare = function(sql) {
      const statement = prepare.call(this, sql)
      if (sql.startsWith('INSERT INTO legacy_base')) {
        const run = statement.run.bind(statement)
        statement.run = (...args) => {
          const result = run(...args)
          parentPort.postMessage('base-held')
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
          return result
        }
      }
      return statement
    }
    import(workerData.module).then(({ CustomWordDatabase }) => CustomWordDatabase.open(workerData.profile))
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
  const raw = new DatabaseSync(ctx.path)
  try {
    assert.equal(
      raw.prepare('SELECT legacy_revision FROM state').get().legacy_revision,
      4,
    )
    assert.equal(
      raw.prepare('SELECT word FROM legacy_base').get().word,
      'alpha',
    )
    assert.equal(
      raw.prepare("SELECT word FROM words WHERE id = 'a'").get().word,
      'alpha',
    )
  } finally {
    raw.close()
  }
  let store = await ctx.open()
  assert.equal(store.get({ id: 'a' }).word.word, 'ALPHA')
  assert.equal(store.get({ id: 'a' }).word.note, 'legacy\u0000delta')
  assert.equal(store.get({ id: 'new' }).word.word, 'newer only')
  const revision = store.revision()
  store.close()
  store = await ctx.open()
  assert.equal(store.revision(), revision)
})
