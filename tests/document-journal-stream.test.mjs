import assert from 'node:assert/strict'
import test from 'node:test'
import { createDocumentJournal } from '../src/shared/document-journal.ts'

async function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const head = { tabId: 'a', revision: 0, contentVersion: 1 }
  let progress, finish, started
  const ready = new Promise((resolve) => {
    started = resolve
  })
  const journal = createDocumentJournal(
    async () => {
      throw new Error('lost receipt')
    },
    {
      timeoutMs: 10,
      checkpoint: () => ({
        ...head,
        streamId: 'checkpoint',
        length: 50 * 1024 * 1024,
      }),
      head: async () => head,
      verify: (_checkpoint, notify) => {
        progress = notify
        started()
        return new Promise((resolve) => {
          finish = resolve
        })
      },
    },
  )
  await assert.rejects(
    journal.append({
      tabId: 'a',
      revision: 0,
      baseVersion: 0,
      contentVersion: 1,
      from: 0,
      to: 0,
      insert: 'kept',
    }),
    /lost receipt/,
  )
  const flushing = journal.flush()
  void flushing.catch(() => {})
  await ready
  return {
    journal,
    flushing,
    progress: () => progress(),
    finish: () => finish(head),
  }
}

test('checkpoint progress renews stall deadline without a whole-document deadline', async (t) => {
  const f = await fixture(t)
  for (let page = 0; page < 20; page++) {
    t.mock.timers.tick(9)
    f.progress()
    await Promise.resolve()
  }
  f.finish()
  await f.flushing
  assert.equal(f.journal.hasPending(), false)
})

test('stalled checkpoint retains pending edits and cannot authorize later publication', async (t) => {
  const f = await fixture(t)
  t.mock.timers.tick(11)
  await assert.rejects(f.flushing, /timed out/)
  assert.equal(f.journal.hasPending(), true)
  f.progress()
  f.finish()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.journal.hasPending(), true)
})
