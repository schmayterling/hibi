import assert from 'node:assert/strict'
import test from 'node:test'
import { documentRuntime } from '../src/renderer/src/document-runtime.ts'
import * as kept from '../src/renderer/src/undo-history.ts'
import { DocumentSession } from '../src/shared/document-session.ts'
import { keptHistory } from '../src/shared/undo-history.ts'

test('a clear forgets the steps a reopened note was still reading', async (t) => {
  const session = new DocumentSession('base', { tabId: 'n', revision: 0 }, 0, {
    enqueue() {},
    onError(error) {
      throw error
    },
  })
  session.edit([{ from: 4, to: 4, insert: ' one' }], 'source', 'step-0')
  session.sealHistory()
  session.markSaved(session.snapshot())
  const history = JSON.parse(JSON.stringify(keptHistory(session)))
  const asked = Promise.withResolvers()
  const read = Promise.withResolvers()
  const cleared = Promise.withResolvers()
  globalThis.window = {
    hibi: {
      getKeepUndoHistory: async () => true,
      readUndoHistory: () => {
        asked.resolve()
        return read.promise
      },
      clearUndoHistory: () => cleared.promise,
    },
  }
  const restored = []
  Object.assign(documentRuntime, {
    restoreHistory: (...args) => restored.push(args),
    clearHistory: () => {},
    primaryViewId: () => null,
  })
  t.after(() => {
    delete globalThis.window
    for (const name of ['restoreHistory', 'clearHistory', 'primaryViewId'])
      delete documentRuntime[name]
  })
  const reading = kept.restore('n', session)
  await asked.promise
  // Hibi answers the read, queued before the clear, while the clear runs.
  const clearing = kept.clear()
  read.resolve(history)
  await reading
  cleared.resolve()
  await clearing
  assert.deepEqual(restored, [])
})
