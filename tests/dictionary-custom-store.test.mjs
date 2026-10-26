import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CustomWordStore } from '../src/addons/dictionary/custom-word-store.ts'
import { waitForAsync } from './poll.mjs'

test('a queued profile commit rechecks its activation before reaching the worker', async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-custom-queue-'))
  const path = join(profile, 'held-worker.mjs')
  await writeFile(
    path,
    `
    import { parentPort } from 'node:worker_threads'
    let held
    const methods = []
    parentPort.on('message', (job) => {
      if (job.release) { parentPort.postMessage({ seq: held.seq, result: methods }); return }
      methods.push(job.method)
      if (job.input?.hold) held = job
      else parentPort.postMessage({ seq: job.seq, result: methods })
    })
  `,
  )
  const store = new CustomWordStore(path, profile)
  t.after(async () => {
    await store.close()
    await rm(profile, { recursive: true, force: true })
  })
  const first = store.request('metadata', { hold: true })
  let current = true
  const stale = store
    .request('change', { type: 'commit' }, () => current)
    .catch((error) => error)
  current = false
  await waitForAsync(
    { evaluate: async (check) => check() },
    () => !!store.worker,
  )
  store.worker.postMessage({ release: true })
  assert.deepEqual(await first, ['metadata'])
  assert.match((await stale).message, /disabled/)
  assert.deepEqual(await store.request('get', { id: 'current' }), [
    'metadata',
    'get',
  ])
})
