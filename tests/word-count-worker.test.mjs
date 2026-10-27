import assert from 'node:assert/strict'
import test from 'node:test'
import { countText } from '../src/addons/word-count/count.ts'
import { richText } from '../src/addons/word-count/formatted-text.ts'
import { defaultNoteSyntax } from '../src/shared/note-syntax.ts'
import { SourceTransferSender } from '../src/shared/source-transfer.ts'

test('worker cancels stale counts, separates document streams and closes cleanly', async (t) => {
  const received = []
  let notify = () => {}
  globalThis.self = {
    postMessage: (message) => {
      received.push(message)
      notify()
    },
  }
  t.after(() => {
    delete globalThis.self
  })
  await import('../src/addons/word-count/counter.worker.ts')
  const send = (data) => self.onmessage({ data })
  async function next(predicate = () => true) {
    for (;;) {
      const at = received.findIndex(predicate)
      if (at >= 0) return received.splice(at, 1)[0]
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('worker reply timeout')),
          5000,
        )
        notify = () => {
          clearTimeout(timer)
          resolve()
        }
      })
    }
  }
  async function open(id, text) {
    const sender = new SourceTransferSender(
      {
        tabId: id,
        revision: 0,
        contentVersion: 0,
        streamId: id,
        length: text.length,
      },
      [text],
    )
    send({ kind: 'open', head: sender.head })
    for (;;) {
      const message = await next((message) => message.request?.streamId === id)
      if (message.kind === 'ready') {
        sender.finish(message.request)
        return
      }
      const chunk = sender.read(message.request)
      assert.ok(
        chunk.chunks.reduce((size, text) => size + text.length, 0) <= 65536,
      )
      send({ kind: 'chunk', chunk })
    }
  }
  const syntax = { ...defaultNoteSyntax, alerts: true, textExtras: true }
  const read = (streamId, version = 0) =>
    send({ kind: 'count', streamId, version, syntax })
  const value = (text) => countText(richText(text, syntax).slice(1))
  const a = '# First\r\n\r\n**old** words 👩🏽‍💻'
  const b = '# Second\n\n-# small words'
  await open('a', a)
  await open('b', b)
  read('a')
  assert.deepEqual(
    (await next((message) => message.kind === 'count')).result,
    value(a),
  )
  read('b')
  assert.deepEqual(
    (await next((message) => message.kind === 'count')).result,
    value(b),
  )
  read('a')
  const from = a.indexOf('old')
  send({
    kind: 'edit',
    streamId: 'a',
    operation: {
      document: { tabId: 'a', revision: 0 },
      operationId: 'edit-a',
      baseVersion: 0,
      contentVersion: 1,
      origin: 'source',
      historyGroup: 'edit-a',
      changes: [{ from, to: from + 3, insert: 'fresh' }],
    },
  })
  assert.equal((await next((message) => message.kind === 'count')).result, null)
  read('a', 1)
  assert.deepEqual(
    (await next((message) => message.kind === 'count')).result,
    value(a.replace('old', 'fresh')),
  )
  read('a', 0)
  assert.equal((await next((message) => message.kind === 'count')).result, null)
  read('b')
  send({ kind: 'close', streamId: 'b' })
  assert.equal((await next((message) => message.kind === 'count')).result, null)
  read('a', 1)
  assert.deepEqual(
    (await next((message) => message.kind === 'count')).result,
    value(a.replace('old', 'fresh')),
  )
  send({ kind: 'close', streamId: 'a' })
  send('raw **source**')
  assert.deepEqual(await next(), countText('raw **source**'))
})
