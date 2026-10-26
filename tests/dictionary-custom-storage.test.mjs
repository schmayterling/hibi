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
  t.after(() => rm(profile, { recursive: true, force: true }))
  return { profile, file, original }
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
const native = (store, calls = []) => ({
  async query(method, input) {
    calls.push({ method, input })
    return method === 'customWords' ? store.page(input) : store.complete(input)
  },
  async invoke(method, input) {
    assert.equal(method, 'changeCustomWords')
    calls.push({ method, input })
    return store.change(input)
  },
})

test('migration verifies 5,000 words and retains the complete downgrade snapshot', async (t) => {
  const saved = Array.from({ length: 5000 }, (_, index) => ({
    id: `id-${index}`,
    word: `word${index}`,
    note: `note ${index}`,
  }))
  const ctx = await fixture(t, saved)
  let store = await CustomWordDatabase.open(ctx.profile)
  assert.deepEqual(all(store), saved)
  assert.equal(await readFile(ctx.file, 'utf8'), ctx.original)
  store.close()
  store = await CustomWordDatabase.open(ctx.profile)
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
  const store = await CustomWordDatabase.open(ctx.profile)
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
  assert.equal((await handle.set(words)).status, 'saved')
  assert.deepEqual(all(store), words)
  assert.equal(await readFile(ctx.file, 'utf8'), ctx.original)
  calls.length = 0
  const changed = words.with(49999, {
    ...words[49999],
    note: 'one changed record',
  })
  assert.equal((await handle.set(changed)).status, 'saved')
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
  t.after(() => worker.terminate())
  await new Promise((resolve, reject) => {
    worker.once('message', (message) => {
      assert.equal(message, 'migration-held')
      resolve()
    })
    worker.once('error', reject)
  })
  await worker.terminate()
  assert.equal(await readFile(ctx.file, 'utf8'), ctx.original)
  const store = await CustomWordDatabase.open(ctx.profile)
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
    await assert.rejects(
      CustomWordDatabase.open(ctx.profile),
      /original data has been kept/,
    )
    assert.equal(await readFile(ctx.file, 'utf8'), original)
  }
  await writeFile(ctx.file, ctx.original)
  const store = await CustomWordDatabase.open(ctx.profile)
  t.after(() => store.close())
  assert.deepEqual(all(store), [])
})

test('abandoned changes roll back, revision conflicts refresh, and other windows follow commits', async (t) => {
  const ctx = await fixture(t, [{ id: 'kept', word: 'kept', note: 'original' }])
  const store = await CustomWordDatabase.open(ctx.profile)
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
  await first.set(changed)
  await waitForAsync(
    { evaluate: async (check) => check() },
    () => second.snapshot().revision === first.snapshot().revision,
  )
  assert.deepEqual(second.snapshot().value, changed)
  token = store.change({ type: 'begin', revision: store.revision() }).token
  store.change({
    type: 'stage',
    token,
    upsert: [{ id: 'new', word: 'other window' }],
    remove: [],
  })
  store.change({ type: 'commit', token })
  assert.equal(
    (await first.set([{ id: 'kept', word: 'kept', note: 'stale' }])).status,
    'conflict',
  )
  assert.equal(first.snapshot().value.length, 2)
  assert.equal(first.snapshot().value[0].note, 'saved')
})
