import assert from 'node:assert/strict'
import test from 'node:test'
import { journalHead } from '../src/shared/document-checkpoint.ts'
import {
  createDocumentJournal,
  createJournalReceiver,
} from '../src/shared/document-journal.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'
import { SOURCE_TRANSFER_UNITS } from '../src/shared/source-transfer.ts'
import { createCheckpointTransfer } from './checkpoint-transfer.mjs'

async function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const initial = 'x'.repeat(20 * SOURCE_TRANSFER_UNITS),
    store = new SourceStore(initial, { tabId: 'a', revision: 0 }),
    receive = createJournalReceiver(() => store),
    recovery = createCheckpointTransfer(() => store)
  let release,
    started,
    reached,
    verification,
    finishing = false
  const ready = new Promise((resolve) => {
    started = resolve
  })
  const journal = createDocumentJournal(
    async (request) => {
      receive(request)
      throw new Error('lost receipt')
    },
    {
      timeoutMs: 10,
      checkpoint: () =>
        recovery.checkpoint(journalHead(store), `kept${initial}`),
      head: async () => journalHead(store),
      verify: (checkpoint, notify) => {
        verification = recovery.verify(checkpoint, () => {
          notify()
          if (finishing) return
          return new Promise((resolve) => {
            release = resolve
            started()
            reached?.()
          })
        })
        return verification
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
    async progress() {
      const next = new Promise((resolve) => {
        reached = resolve
      })
      release()
      await next
    },
    async finish() {
      finishing = true
      release()
      await verification
    },
    store,
  }
}

test('checkpoint progress renews stall deadline without a whole-document deadline', async (t) => {
  const f = await fixture(t)
  const snapshot = f.store.snapshot()
  f.store.counters(true)
  for (let page = 0; page < 20; page++) {
    t.mock.timers.tick(9)
    await f.progress()
  }
  await f.finish()
  await f.flushing
  assert.equal(f.journal.hasPending(), false)
  assert.equal(f.store.snapshot(), snapshot)
  assert.equal(f.store.counters().materializations, 0)
})

test('stalled checkpoint retains pending edits and cannot authorize later publication', async (t) => {
  const f = await fixture(t)
  const snapshot = f.store.snapshot()
  t.mock.timers.tick(11)
  await assert.rejects(f.flushing, /timed out/)
  assert.equal(f.journal.hasPending(), true)
  await f.progress()
  await f.finish()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.journal.hasPending(), true)
  assert.equal(f.store.snapshot(), snapshot)
})
