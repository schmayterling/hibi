import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, open, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createTraceFinalizer } from '../../scripts/trace-stream.mjs'

async function fixture(t, handlers = {}, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'hibi-trace-stream-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const session = new EventEmitter(),
    calls = []
  let closes = 0
  session.send = async (method, args) => {
    calls.push({ method, args })
    return handlers[method]?.(args, session)
  }
  const path = join(directory, 'trace.json')
  const finish = createTraceFinalizer(session, path, {
    openFile: async (...args) => {
      const file = await open(...args)
      return {
        writeFile: (data) => file.writeFile(data),
        close() {
          closes++
          return file.close()
        },
      }
    },
    ...options,
  })
  return { session, calls, path, finish, closes: () => closes }
}

test('trace finalization waits for completion and shares one promise across repeated finish calls', async (t) => {
  let read = 0
  const f = await fixture(t, {
    'Tracing.end': (_, session) =>
      assert.equal(session.listenerCount('Tracing.tracingComplete'), 1),
    'IO.read': ({ size }) => {
      assert.equal(size, 1024 * 1024)
      return read++ === 0
        ? { data: '{"text":"', eof: false }
        : {
            data: Buffer.from('café"}').toString('base64'),
            base64Encoded: true,
            eof: true,
          }
    },
  })
  const first = f.finish()
  assert.equal(f.finish(), first)
  await Promise.resolve()
  assert.equal(f.calls.length, 1)
  f.session.emit('Tracing.tracingComplete', { stream: 'trace' })
  const metadata = await first
  assert.equal(f.finish(), first)
  assert.equal(await readFile(f.path, 'utf8'), '{"text":"café"}')
  assert.equal(metadata.bytes, Buffer.byteLength('{"text":"café"}'))
  assert.equal(metadata.reads, 2)
  for (const key of ['completionMs', 'drainMs', 'cleanupMs', 'totalMs'])
    assert.ok(metadata[key] >= 0)
  assert.equal(
    f.calls.filter(({ method }) => method === 'Tracing.end').length,
    1,
  )
  assert.equal(f.calls.filter(({ method }) => method === 'IO.close').length, 1)
  assert.equal(f.closes(), 1)
  assert.equal(f.session.listenerCount('Tracing.tracingComplete'), 0)
})

test('trace read errors retain the original failure while closing stream and file', async (t) => {
  const original = new Error('read failed')
  const f = await fixture(t, {
    'Tracing.end': (_, session) =>
      session.emit('Tracing.tracingComplete', { stream: 'trace' }),
    'IO.read': () => {
      throw original
    },
    'IO.close': () => {
      throw new Error('close failed')
    },
  })
  const first = f.finish()
  await assert.rejects(first, (error) => error === original)
  assert.equal(f.finish(), first)
  assert.equal(f.closes(), 1)
  assert.equal(f.calls.filter(({ method }) => method === 'IO.close').length, 1)
  assert.equal(f.session.listenerCount('Tracing.tracingComplete'), 0)
})

test('completion timeout removes the listener and late events never send another trace end', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await fixture(t)
  const first = f.finish()
  const rejection = assert.rejects(first, /trace completion timed out/)
  await Promise.resolve()
  t.mock.timers.tick(45000)
  await rejection
  assert.equal(f.session.listenerCount('Tracing.tracingComplete'), 0)
  f.session.emit('Tracing.tracingComplete', { stream: 'late' })
  assert.equal(f.finish(), first)
  assert.deepEqual(
    f.calls.map(({ method }) => method),
    ['Tracing.end'],
  )
  assert.equal(f.closes(), 0)
})

test('one drain deadline covers every chunk and late reads cannot write after cleanup', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let clock = 0,
    read = 0,
    resolveLate
  let startedRead
  const pendingRead = new Promise((resolve) => {
    startedRead = resolve
  })
  const f = await fixture(
    t,
    {
      'Tracing.end': (_, session) =>
        session.emit('Tracing.tracingComplete', { stream: 'trace' }),
      'IO.read': () => {
        if (read++ === 0) {
          clock = 80000
          return { data: '{', eof: false }
        }
        startedRead()
        return new Promise((resolve) => {
          resolveLate = resolve
        })
      },
    },
    { now: () => clock },
  )
  const first = f.finish()
  const rejection = assert.rejects(first, /trace drain timed out/)
  await pendingRead
  clock = 90000
  t.mock.timers.tick(10000)
  await rejection
  resolveLate({ data: '}', eof: true })
  await Promise.resolve()
  assert.equal(await readFile(f.path, 'utf8'), '{')
  assert.equal(f.closes(), 1)
  assert.equal(f.calls.filter(({ method }) => method === 'IO.close').length, 1)
  assert.equal(f.session.listenerCount('Tracing.tracingComplete'), 0)
})

test('synchronous cleanup failures cannot replace the original collection error', async (t) => {
  const original = new Error('read failed')
  let closes = 0
  const f = await fixture(
    t,
    {
      'Tracing.end': (_, session) =>
        session.emit('Tracing.tracingComplete', { stream: 'trace' }),
      'IO.read': () => {
        throw original
      },
    },
    {
      openFile: async () => ({
        writeFile() {},
        close() {
          closes++
          throw new Error('file close failed')
        },
      }),
    },
  )
  await assert.rejects(f.finish(), (error) => error === original)
  assert.equal(closes, 1)
  assert.equal(f.calls.filter(({ method }) => method === 'IO.close').length, 1)
  assert.equal(f.session.listenerCount('Tracing.tracingComplete'), 0)
})

test('a stalled file open times out and its late handle closes once without writing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let resolveOpen, notifyOpening, notifyClosed
  let closes = 0,
    writes = 0
  const opening = new Promise((resolve) => {
    notifyOpening = resolve
  })
  const closed = new Promise((resolve) => {
    notifyClosed = resolve
  })
  const f = await fixture(
    t,
    {
      'Tracing.end': (_, session) =>
        session.emit('Tracing.tracingComplete', { stream: 'trace' }),
    },
    {
      now: () => 0,
      openFile: () => {
        notifyOpening()
        return new Promise((resolve) => {
          resolveOpen = resolve
        })
      },
    },
  )
  const first = f.finish()
  const rejection = assert.rejects(first, /trace drain timed out/)
  await opening
  t.mock.timers.tick(90000)
  await rejection
  assert.equal(f.session.listenerCount('Tracing.tracingComplete'), 0)
  assert.equal(f.calls.filter(({ method }) => method === 'IO.close').length, 1)
  resolveOpen({
    writeFile() {
      writes++
    },
    close() {
      closes++
      notifyClosed()
      return Promise.resolve()
    },
  })
  await closed
  assert.equal(closes, 1)
  assert.equal(writes, 0)
  assert.equal(f.finish(), first)
  assert.equal(
    f.calls.filter(({ method }) => method === 'Tracing.end').length,
    1,
  )
  assert.equal(f.calls.filter(({ method }) => method === 'IO.read').length, 0)
})
