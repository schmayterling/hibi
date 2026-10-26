import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { TagLabels } from '../src/addons/tags/formatted-labels.ts'
import { scanTagLabels } from '../src/addons/tags/formatted-labels.worker.ts'
import { tagMatches } from '../src/addons/tags/syntax.ts'

function fixture(t, text) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const workers = []
  const previous = globalThis.Worker
  globalThis.Worker = class {
    onmessage = null
    onerror = null
    terminated = false
    resolve = null
    job = null
    constructor() {
      workers.push(this)
    }
    emit(data) {
      queueMicrotask(() => {
        if (!this.terminated) this.onmessage?.({ data })
      })
    }
    postMessage(message) {
      if (message.type === 'text') this.resolve(message.slice)
      else {
        this.job = message
        void scanTagLabels(
          message,
          (from, to) =>
            new Promise((resolve) => {
              this.resolve = resolve
              this.emit({ type: 'read', id: message.id, from, to })
            }),
        ).then((result) =>
          this.emit({ type: 'done', id: message.id, ...result }),
        )
      }
    }
    terminate() {
      this.terminated = true
    }
  }
  t.after(() => {
    if (previous === undefined) delete globalThis.Worker
    else globalThis.Worker = previous
  })
  const doc = EditorState.create({ doc: text }).doc
  const reads = []
  const tracked = new Proxy(doc, {
    get(target, key) {
      if (key === 'sliceString')
        return (from, to) => {
          reads.push(to - from)
          return target.sliceString(from, to)
        }
      return Reflect.get(target, key, target)
    },
  })
  const labels = new TagLabels(tracked)
  const ready = Promise.withResolvers()
  const release = labels.subscribe(() => ready.resolve())
  t.after(release)
  return { labels, reads, workers, ready: ready.promise, release }
}

test('long labels stream bounded reads, preserve full Unicode names, and reuse cached ranges', async (t) => {
  const name = 'ΟΣ'.repeat(48000)
  const text = 'prefix #' + name + ' suffix'
  const f = fixture(t, text)
  const window = { start: 0, end: text.length, from: 50001, to: 50033 }
  f.labels.request(window)
  assert.equal(f.reads.length, 0)
  assert.equal(f.workers.length, 0)
  t.mock.timers.tick(299)
  assert.equal(f.workers.length, 0)
  t.mock.timers.tick(1)
  await f.ready
  assert.deepEqual(
    f.labels.get(0, text.length, window.from, window.to),
    tagMatches(text),
  )
  assert.ok(Math.max(...f.reads) <= 4098)
  assert.ok(f.reads.reduce((a, b) => a + b, 0) < text.length * 4)
  assert.equal(f.workers.length, 1)
  assert.equal(f.workers[0].terminated, true)
  f.reads.length = 0
  for (let at = 100; at < text.length - 100; at += 4096)
    assert.deepEqual(
      f.labels.get(0, text.length, at, at + 32),
      tagMatches(text),
    )
  assert.equal(f.reads.length, 0)
  assert.equal(f.labels.get(1, text.length, window.from, window.to), null)
})

test('streamed label boundaries preserve astral letters, NFC composition, and lowercase expansion', async (t) => {
  const text = 'prefix #' + '𐐀'.repeat(2050) + '가İΣ suffix'
  const f = fixture(t, text)
  f.labels.request({ start: 0, end: text.length, from: 4097, to: 4101 })
  t.mock.timers.tick(300)
  await f.ready
  assert.deepEqual(f.labels.get(0, text.length, 4097, 4101), tagMatches(text))
  assert.ok(Math.max(...f.reads) <= 4098)
})

test('disposing a document cancels pending work and rejects late label replies', async (t) => {
  const text = '#' + 'a'.repeat(10000)
  const f = fixture(t, text)
  f.labels.request({ start: 0, end: text.length, from: 3000, to: 3032 })
  t.mock.timers.tick(300)
  const worker = f.workers[0]
  const receive = worker.onmessage
  f.release()
  receive({
    data: {
      type: 'done',
      id: worker.job.id,
      from: 0,
      to: text.length,
      matches: tagMatches(text),
    },
  })
  await Promise.resolve()
  assert.equal(worker.terminated, true)
  assert.equal(f.labels.get(0, text.length, 3000, 3032), null)
  assert.equal(f.reads.length, 0)
})

test('only the latest pending window starts after input settles', async (t) => {
  const text = 'prefix #' + 'x'.repeat(10000)
  const f = fixture(t, text)
  for (let at = 1000; at <= 9000; at += 1000)
    f.labels.request({ start: 0, end: text.length, from: at, to: at + 32 })
  assert.equal(f.workers.length, 0)
  t.mock.timers.tick(300)
  await f.ready
  assert.equal(f.workers.length, 1)
  assert.equal(f.workers[0].job.from, 9000)
})
