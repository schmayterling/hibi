import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CustomWordDatabase } from '../src/addons/dictionary/custom-word-database.ts'
import {
  customWordsView,
  editCustomWord,
  openCustomWords,
} from '../src/addons/dictionary/custom-words.ts'

const count = Number(process.argv[2] ?? 100000)
if (!Number.isSafeInteger(count) || count < 1 || !globalThis.gc)
  throw new Error(
    'Run node --expose-gc scripts/benchmark-dictionary-custom-words.mjs <word-count>.',
  )
const profile = await mkdtemp(join(tmpdir(), 'hibi-custom-scale-'))
let database, close
try {
  database = await CustomWordDatabase.open(profile)
  const { token } = database.change({
    type: 'begin',
    revision: database.revision(),
  })
  for (let offset = 0; offset < count; offset += 10000) {
    database.change({
      type: 'stage',
      token,
      remove: [],
      upsert: Array.from(
        { length: Math.min(10000, count - offset) },
        (_, index) => ({
          id: `id-${offset + index}`,
          word: `w${(offset + index).toString(36)}x`,
          note: 'a short note',
        }),
      ),
    })
  }
  database.change({ type: 'commit', token })
  const calls = []
  const call = async (method, input) => {
    calls.push({ method, input })
    if (method === 'customWordsMetadata') return database.metadata()
    if (method === 'customWordsGet') return database.get(input)
    if (method === 'customWords') return database.page(input)
    if (method === 'changeCustomWords') return database.change(input)
    if (method === 'customWordsLookup') return database.lookup(input)
    if (method === 'customWordsComplete') return database.complete(input)
    throw new Error('Unexpected probe request.')
  }
  globalThis.window = {
    hibi: { invokeAddonProfile: (_id, method, input) => call(method, input) },
  }
  await new Promise((resolve) => setImmediate(resolve))
  gc()
  await new Promise((resolve) => setImmediate(resolve))
  gc()
  const before = process.memoryUsage().heapUsed
  const started = performance.now()
  close = await openCustomWords({
    native: { query: call, invoke: call },
    host: { selectedIo: {} },
  })
  const activationMs = performance.now() - started
  gc()
  const activeHeap = process.memoryUsage().heapUsed
  const activationPages = calls.filter(
    ({ method }) => method === 'customWords',
  ).length
  assert.equal(activationPages, 0)
  const middle = Math.floor(count / 2)
  const model = customWordsView().indexed
  await model.ensure([{ from: middle, to: Math.min(count, middle + 40) }])
  const target = model.at(middle)
  assert.ok(target)
  gc()
  const visibleHeap = process.memoryUsage().heapUsed
  calls.length = 0
  const edits = []
  for (let index = 0; index < 5; index++) {
    const started = performance.now()
    await editCustomWord(target, (word) => ({
      ...word,
      note: `edited ${index}`,
    }))
    edits.push(performance.now() - started)
  }
  const pageReads = calls.filter(
    ({ method }) => method === 'customWords',
  ).length
  const stages = calls.filter(({ input }) => input?.type === 'stage')
  assert.equal(pageReads, 0)
  assert.equal(stages.length, 5)
  assert.ok(
    stages.every(
      ({ input }) => input.upsert.length === 1 && input.remove.length === 0,
    ),
  )
  edits.sort((a, b) => a - b)
  console.log(
    JSON.stringify({
      words: count,
      activationPages,
      activationMs: Number(activationMs.toFixed(2)),
      activationHeapMiB: Number(((activeHeap - before) / 2 ** 20).toFixed(3)),
      visibleHeapMiB: Number(((visibleHeap - before) / 2 ** 20).toFixed(3)),
      medianEditMs: Number(edits[2].toFixed(2)),
      editPageReads: pageReads,
      recordsPerEdit: 1,
      note: 'isolated renderer client + sqlite probe; host ipc excluded',
    }),
  )
} finally {
  close?.()
  database?.close()
  await rm(profile, { recursive: true, force: true })
}
