import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { build } from 'esbuild'
import { CustomWordDatabase } from '../src/addons/dictionary/custom-word-database.ts'
import { openCustomWordStorage } from '../src/addons/dictionary/custom-word-storage.ts'
import {
  customWordsView,
  editCustomWord,
  openCustomWords,
} from '../src/addons/dictionary/custom-words.ts'
import { waitForAsync } from './poll.mjs'

async function fixture(t, words = []) {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-custom-storage-'))
  const folder = join(profile, 'addon-storage', 'global')
  await mkdir(folder, { recursive: true })
  const file = join(folder, 'dictionary.json')
  const original = JSON.stringify({
    format: 1,
    entries: { 'custom-words': { version: 1, revision: 4, value: words } },
  })
  await writeFile(file, original)
  const owned = []
  t.after(async () => {
    for (const close of owned.reverse()) await close()
    await rm(profile, { recursive: true, force: true })
  })
  return {
    profile,
    file,
    original,
    own: (close) => owned.push(close),
    async open() {
      const store = await CustomWordDatabase.open(profile)
      owned.push(() => store.close())
      return store
    },
  }
}
const all = (store) => {
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
const native = (store, calls = []) => {
  const call = async (method, input) => {
    calls.push({ method, input })
    if (method === 'customWordsMetadata') return store.metadata()
    if (method === 'customWordsGet') return store.get(input)
    if (method === 'customWords') return store.page(input)
    if (method === 'customWordsLookup') return store.lookup(input)
    if (method === 'customWordsComplete') return store.complete(input)
    assert.equal(method, 'changeCustomWords')
    return store.change(input)
  }
  return { query: call, invoke: call }
}

test('migration verifies 5,000 words and retains the complete downgrade snapshot', async (t) => {
  const saved = Array.from({ length: 5000 }, (_, index) => ({
    id: `id-${index}`,
    word: `word${index}`,
    note: `note ${index}`,
  }))
  const ctx = await fixture(t, saved)
  let store = await ctx.open()
  assert.deepEqual(all(store), saved)
  assert.equal(await readFile(ctx.file, 'utf8'), ctx.original)
  store.close()
  store = await ctx.open()
  t.after(() => store.close())
  assert.deepEqual(all(store), saved, 'reopening does not import a second copy')
  const token = store.change({
    type: 'begin',
    revision: store.revision(),
  }).token
  store.change({
    type: 'stage',
    token,
    upsert: [{ id: 'new', word: 'new word' }],
    remove: [],
  })
  store.change({ type: 'commit', token })
  assert.equal(all(store).length, 5001)
  assert.equal(
    await readFile(ctx.file, 'utf8'),
    ctx.original,
    'older builds still read their original value',
  )
})

test('50,000 keyed records and long fields persist, with only changed records written', async (t) => {
  const ctx = await fixture(t)
  const store = await ctx.open()
  t.after(() => store.close())
  const calls = []
  const handle = await openCustomWordStorage(native(store, calls))
  t.after(() => handle.close())
  const words = Array.from({ length: 50000 }, (_, index) => ({
    id: `id-${index}`,
    word: `word${index}`,
  }))
  words.push({
    id: 'long',
    word: '界'.repeat(5000),
    lang: 'de',
    note: 'full note '.repeat(5000).trim(),
  })
  assert.equal(
    (
      await handle.change(async (stage) => {
        await stage({ upsert: words })
      })
    ).count,
    50001,
  )
  assert.deepEqual(all(store), words)
  assert.equal(await readFile(ctx.file, 'utf8'), ctx.original)
  await handle.ensure([{ from: 49999, to: 50001 }])
  assert.equal(handle.at(50000).word.length, 5000)
  calls.length = 0
  const current = await handle.get('id-49999')
  const changed = { ...current.word, note: 'one changed record' }
  assert.equal(
    (
      await handle.change(
        async (stage) => {
          await stage({ upsert: [changed] })
        },
        { revision: current.revision, put: changed },
      )
    ).count,
    50001,
  )
  const stages = calls.filter(({ input }) => input?.type === 'stage')
  assert.equal(stages.length, 1)
  assert.equal(stages[0].input.upsert.length, 1)
  assert.equal(stages[0].input.remove.length, 0)
  assert.equal(
    calls.filter(({ method }) => method === 'customWords').length,
    0,
    'no full reread for a note edit',
  )
  assert.equal(all(store)[49999].note, 'one changed record')
  const db = new DatabaseSync(
    join(ctx.profile, 'dictionary-custom-words', 'words.sqlite'),
  )
  const plan = db
    .prepare(
      'EXPLAIN QUERY PLAN SELECT * FROM words WHERE lang = ? AND term >= ? AND term < ? ORDER BY term LIMIT 64',
    )
    .all('', 'word499', 'word49:')
  assert.ok(
    plan.some(
      (row) =>
        String(row.detail).includes('words_prefix') &&
        String(row.detail).includes('term<?'),
    ),
  )
  db.close()
  t.diagnostic(
    '50,001 records: one keyed write and zero list reads for a single-note edit',
  )
})

test('100,000 native records use an indexed exact lookup', async (t) => {
  const ctx = await fixture(t)
  const store = await ctx.open()
  t.after(() => store.close())
  const token = store.change({
    type: 'begin',
    revision: store.revision(),
  }).token
  for (let offset = 0; offset < 100000; offset += 256) {
    store.change({
      type: 'stage',
      token,
      remove: [],
      upsert: Array.from(
        { length: Math.min(256, 100000 - offset) },
        (_, i) => ({ id: `id-${offset + i}`, word: `word${offset + i}` }),
      ),
    })
  }
  store.change({ type: 'commit', token })
  const lower = t.mock.method(String.prototype, 'toLowerCase')
  assert.equal(
    store.lookup({ term: 'WORD99999', lang: '' })[0].word,
    'word99999',
  )
  assert.equal(lower.mock.callCount(), 1)
  lower.mock.restore()
  const db = new DatabaseSync(
    join(ctx.profile, 'dictionary-custom-words', 'words.sqlite'),
  )
  const plan = db
    .prepare(
      'EXPLAIN QUERY PLAN SELECT * FROM words WHERE term = ? AND lang = ?',
    )
    .all('word99999', '')
  assert.ok(
    plan.some(
      (row) =>
        String(row.detail).includes('SEARCH') &&
        String(row.detail).includes('term=?') &&
        String(row.detail).includes('lang=?'),
    ),
  )
  db.close()
  const calls = []
  const bridge = native(store, calls)
  const prior = globalThis.window
  globalThis.window = {
    hibi: {
      invokeAddonProfile: (_id, method, input) => bridge.invoke(method, input),
    },
  }
  ctx.own(() => {
    if (prior === undefined) delete globalThis.window
    else globalThis.window = prior
  })
  const close = await openCustomWords({
    native: bridge,
    host: { selectedIo: {} },
  })
  ctx.own(close)
  assert.equal(calls.filter(({ method }) => method === 'customWords').length, 0)
  assert.equal(customWordsView().count, 100000)
  const target = store.get({ id: 'id-99999' }).word
  calls.length = 0
  await editCustomWord(target, (current) => ({
    ...current,
    note: 'keyed edit',
  }))
  assert.equal(
    calls.filter(({ method }) => method === 'customWordsGet').length,
    1,
  )
  assert.equal(calls.filter(({ method }) => method === 'customWords').length, 0)
  const stages = calls.filter(({ input }) => input?.type === 'stage')
  assert.equal(stages.length, 1)
  assert.equal(stages[0].input.upsert.length, 1)
  await customWordsView().indexed.ensure([{ from: 50000, to: 50040 }])
  assert.equal(calls.filter(({ method }) => method === 'customWords').length, 1)
  assert.equal(customWordsView().indexed.at(50000).word, 'word50000')
  t.diagnostic(
    '100,000 native records: activation reads 0 pages; one keyed edit reads/writes 1 record; viewport reads 1 page',
  )
})

test('a killed migration rolls back every staged record and retries without losing legacy data', async (t) => {
  const saved = Array.from({ length: 5000 }, (_, index) => ({
    word: `word${index}`,
  }))
  const ctx = await fixture(t, saved)
  const path = join(ctx.profile, 'paused-migration.mjs')
  await build({
    stdin: {
      contents: `
      import { parentPort, workerData } from 'node:worker_threads'
      import { DatabaseSync } from 'node:sqlite'
      import { CustomWordDatabase } from ${JSON.stringify(fileURLToPath(new URL('../src/addons/dictionary/custom-word-database.ts', import.meta.url)))}
      const prepare = DatabaseSync.prototype.prepare
      DatabaseSync.prototype.prepare = function(sql) {
        const statement = prepare.call(this, sql)
        if (sql.startsWith('INSERT INTO words (id, word')) {
          const run = statement.run.bind(statement)
          let count = 0
          statement.run = (...args) => {
            const result = run(...args)
            if (++count === 50) {
              parentPort.postMessage('migration-held')
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
            }
            return result
          }
        }
        return statement
      }
      await CustomWordDatabase.open(workerData.profile)
    `,
      resolveDir: process.cwd(),
    },
    outfile: path,
    bundle: true,
    platform: 'node',
    format: 'esm',
  })
  const worker = new Worker(pathToFileURL(path), {
    workerData: { profile: ctx.profile },
  })
  ctx.own(() => worker.terminate())
  await new Promise((resolve, reject) => {
    worker.once('message', (message) => {
      assert.equal(message, 'migration-held')
      resolve()
    })
    worker.once('error', reject)
  })
  await worker.terminate()
  assert.equal(await readFile(ctx.file, 'utf8'), ctx.original)
  const store = await ctx.open()
  t.after(() => store.close())
  assert.deepEqual(
    all(store).map(({ word }) => ({ word })),
    saved,
  )
  assert.equal(new Set(all(store).map(({ id }) => id)).size, 5000)
})

test('corrupt legacy values fail visibly without publishing a partial migration', async (t) => {
  const ctx = await fixture(t)
  for (const original of [
    '{broken',
    JSON.stringify({
      format: 1,
      entries: {
        'custom-words': {
          version: 1,
          revision: 1,
          value: [{ word: 'kept' }, { word: 'bad\u0000' }],
        },
      },
    }),
    JSON.stringify({ format: 1, entries: { 'custom-words': null } }),
  ]) {
    await writeFile(ctx.file, original)
    await assert.rejects(ctx.open(), /original data has been kept/)
    assert.equal(await readFile(ctx.file, 'utf8'), original)
  }
  await writeFile(ctx.file, ctx.original)
  const store = await ctx.open()
  t.after(() => store.close())
  assert.deepEqual(all(store), [])
})

test('a viewport keeps mounted rows until the new revision replaces them', async (t) => {
  let metadataCalls = 0,
    pages = 0
  const handle = await openCustomWordStorage({
    async invoke(method, input) {
      if (method === 'customWordsMetadata')
        return ++metadataCalls === 1
          ? { revision: 1, count: 300 }
          : { revision: 2, count: 1 }
      assert.equal(method, 'customWords')
      pages++
      if (pages === 1)
        return {
          revision: 1,
          words: [{ id: 'old', word: 'old' }],
          after: 1,
          more: true,
        }
      if (pages === 2) {
        assert.equal(input.revision, 1)
        throw new Error('Custom words changed in another window. Try again.')
      }
      assert.equal(input.revision, 2)
      return {
        revision: 2,
        words: [{ id: 'new', word: 'new' }],
        after: 2,
        more: false,
      }
    },
  })
  t.after(() => handle.close())
  await handle.ensure([{ from: 0, to: 300 }])
  assert.equal(handle.snapshot().revision, 2)
  assert.deepEqual(
    handle.at(0),
    { id: 'old', word: 'old' },
    'mounted rows keep their Tab position while loading',
  )
  await handle.ensure([{ from: 0, to: 1 }])
  assert.deepEqual(handle.at(0), { id: 'new', word: 'new' })
  assert.equal(
    pages,
    3,
    'stale rows must be replaced, never mistaken for a fresh cache',
  )
})

test('abandoned changes roll back, revision conflicts refresh, and other windows follow commits', async (t) => {
  const ctx = await fixture(t, [{ id: 'kept', word: 'kept', note: 'original' }])
  const store = await ctx.open()
  t.after(() => store.close())
  let token = store.change({ type: 'begin', revision: 1 }).token
  store.change({
    type: 'stage',
    token,
    upsert: [{ id: 'kept', word: 'kept', note: 'not committed' }],
    remove: [],
  })
  assert.equal(all(store)[0].note, 'original')
  store.change({ type: 'abort', token })
  assert.equal(all(store)[0].note, 'original')
  const first = await openCustomWordStorage(native(store))
  const second = await openCustomWordStorage(native(store))
  t.after(() => {
    first.close()
    second.close()
  })
  const changed = [{ id: 'kept', word: 'kept', note: 'saved' }]
  await first.change(async (stage) => {
    await stage({ upsert: changed })
  })
  await waitForAsync(
    { evaluate: async (check) => check() },
    () => second.snapshot().revision === first.snapshot().revision,
  )
  await second.ensure([{ from: 0, to: 1 }])
  assert.deepEqual(second.at(0), changed[0])
  token = store.change({ type: 'begin', revision: store.revision() }).token
  store.change({
    type: 'stage',
    token,
    upsert: [{ id: 'new', word: 'other window' }],
    remove: [],
  })
  store.change({ type: 'commit', token })
  await assert.rejects(
    first.change(async (stage) => {
      await stage({ upsert: [{ id: 'kept', word: 'kept', note: 'stale' }] })
    }),
    /changed in another window/,
  )
  assert.equal(first.snapshot().count, 2)
  await first.ensure([{ from: 0, to: 2 }])
  assert.equal(first.at(0).note, 'saved')
})

test('a rejected stage and lost abort cannot wedge the next client save', async (t) => {
  const ctx = await fixture(t, [{ id: 'kept', word: 'kept' }])
  const store = await ctx.open()
  const bridge = native(store)
  let loseAbort = true
  const handle = await openCustomWordStorage(bridge, async (method, input) => {
    if (input?.type === 'abort' && loseAbort) {
      loseAbort = false
      throw new Error('renderer lost')
    }
    return bridge.invoke(method, input)
  })
  ctx.own(() => handle.close())
  await assert.rejects(
    handle.change(async (stage) => {
      await stage({ upsert: [{ id: 'lost', word: 'lost' }] })
      throw new Error('renderer lost')
    }),
    /Could not save/,
  )
  await handle.change(async (stage) => {
    await stage({ upsert: [{ id: 'next', word: 'next' }] })
  })
  assert.deepEqual(
    all(store).map(({ word }) => word),
    ['kept', 'next'],
  )
})

test('a late commit reply never replaces a newer profile revision', async (t) => {
  const ctx = await fixture(t, [{ id: 'kept', word: 'kept' }])
  const store = await ctx.open()
  const bridge = native(store)
  const gate = Promise.withResolvers()
  const committed = Promise.withResolvers()
  const handle = await openCustomWordStorage(bridge, async (method, input) => {
    const result = await bridge.invoke(method, input)
    if (input?.type === 'commit') {
      committed.resolve()
      await gate.promise
    }
    return result
  })
  ctx.own(() => handle.close())
  const saved = handle.change(async (stage) => {
    await stage({ upsert: [{ id: 'kept', word: 'kept', note: 'older' }] })
  })
  await committed.promise
  const { token } = store.change({ type: 'begin', revision: store.revision() })
  store.change({
    type: 'stage',
    token,
    upsert: [{ id: 'kept', word: 'kept', note: 'newer' }],
    remove: [],
  })
  store.change({ type: 'commit', token })
  await handle.refresh()
  gate.resolve()
  await saved
  assert.equal(handle.snapshot().revision, 3)
  await handle.ensure([{ from: 0, to: 1 }])
  assert.equal(handle.at(0).note, 'newer')
})

test('duplicate language changes show their own message and leave both words intact', async (t) => {
  const ctx = await fixture(t, [
    { id: 'a', word: 'zorp' },
    { id: 'b', word: 'zorp', lang: 'en', note: 'kept' },
  ])
  const store = await ctx.open()
  const handle = await openCustomWordStorage(native(store))
  ctx.own(() => handle.close())
  const close = await openCustomWords({ host: { selectedIo: {} } }, handle)
  ctx.own(close)
  await assert.rejects(
    editCustomWord({ id: 'a', word: 'zorp' }, (word) => ({
      ...word,
      lang: 'en',
    })),
    /This word already exists in that language\./,
  )
  assert.deepEqual(all(store), [
    { id: 'a', word: 'zorp' },
    { id: 'b', word: 'zorp', lang: 'en', note: 'kept' },
  ])
})

test('dismissed notices refresh other indexed clients without reading word pages', async (t) => {
  const ctx = await fixture(t)
  const store = await ctx.open()
  const db = new DatabaseSync(
    join(ctx.profile, 'dictionary-custom-words', 'words.sqlite'),
  )
  try {
    db.prepare('UPDATE state SET notice = ? WHERE id = 1').run(
      'Recovered words.',
    )
  } finally {
    db.close()
  }
  const calls = []
  const first = await openCustomWordStorage(native(store, calls))
  const second = await openCustomWordStorage(native(store))
  ctx.own(() => first.close())
  ctx.own(() => second.close())
  assert.equal(first.snapshot().notice, 'Recovered words.')
  await first.dismissNotice()
  await waitForAsync(
    { evaluate: (check) => check() },
    () => second.snapshot().notice === undefined,
  )
  assert.equal(first.snapshot().notice, undefined)
  assert.equal(calls.filter(({ method }) => method === 'customWords').length, 0)
})
