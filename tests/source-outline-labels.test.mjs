import assert from 'node:assert/strict'
import test from 'node:test'
import { Worker } from 'node:worker_threads'
import { Lexer } from 'marked'
import { SourceOutlineModel } from '../src/renderer/src/source-outline.ts'
import { SourceOutlineLabelClient } from '../src/renderer/src/source-outline-label-client.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'

const text = `${'*a '.repeat(1000)}b${' a*'.repeat(1000)}`

function pendingLabel(model) {
  const work = model.read()
  for (let steps = 0; steps < 100_000; steps++) {
    const step = work.next()
    assert.equal(step.done, false, 'long labels must leave the renderer')
    if (step.value) {
      assert.ok('label' in step.value)
      return { work, request: step.value.label }
    }
  }
  assert.fail('Outline work must converge.')
}

test('long heading lexing and conversion leave the renderer before doing label work', () => {
  const store = new SourceStore(`# ${text}\n`, { tabId: 'labels', revision: 0 })
  const model = new SourceOutlineModel(store.snapshot(), {
    gfm: true,
    frontmatter: false,
    deferLabels: true,
    renderLabel: () =>
      assert.fail('long labels must not convert in the renderer'),
  })
  const inlineTokens = Lexer.prototype.inlineTokens
  Lexer.prototype.inlineTokens = () =>
    assert.fail('long labels must not lex in the renderer')
  try {
    const { work, request } = pendingLabel(model)
    assert.equal(request.text, text)
    assert.equal(request.level, 1)
    assert.deepEqual(request.references, new Map())
    const complete = `${'a '.repeat(1000)}b${' a'.repeat(1000)}`
    let step = work.next({ label: complete, references: [], missing: [] })
    while (!step.done) step = work.next()
    assert.equal(step.value.headings[0].label, complete)
    assert.equal(model.counters().labelsRead, 1)
    assert.equal(model.read().next().value, step.value)
  } finally {
    Lexer.prototype.inlineTokens = inlineTokens
    model.dispose()
  }
})

test('label workers are reused, terminated on cancellation, and ignore late results and errors', () => {
  const workers = []
  const client = new SourceOutlineLabelClient(
    { syntax: { gfm: true }, flavors: [], disabled: [] },
    () => {
      const worker = {
        messages: [],
        terminations: 0,
        postMessage(message) {
          this.messages.push(message)
        },
        terminate() {
          this.terminations++
        },
      }
      workers.push(worker)
      return worker
    },
  )
  const received = []
  const failed = []
  const request = { text, level: 1, references: new Map() }
  const result = { label: 'whole label', references: [], missing: [] }
  client.read(
    request,
    (value) => received.push(value),
    (error) => failed.push(error),
  )
  const first = workers[0]
  first.onmessage({ data: { result } })
  client.read(
    request,
    (value) => received.push(value),
    (error) => failed.push(error),
  )
  assert.equal(workers.length, 1)
  assert.equal(first.messages.length, 2)
  const lateMessage = first.onmessage
  const lateError = first.onerror
  client.cancel()
  assert.equal(first.terminations, 1)
  client.read(
    request,
    (value) => received.push(value),
    (error) => failed.push(error),
  )
  lateMessage({ data: { result } })
  lateError()
  assert.deepEqual(received, [result])
  assert.deepEqual(failed, [])
  const second = workers[1]
  second.onmessage({ data: { error: 'conversion failed' } })
  assert.equal(second.terminations, 1)
  assert.equal(failed[0].message, 'conversion failed')
  client.read(
    request,
    (value) => received.push(value),
    (error) => failed.push(error),
  )
  const error = new Error('unreadable response')
  workers[2].onmessageerror(error)
  assert.equal(workers[2].terminations, 1)
  assert.equal(failed[1], error)
  client.cancel()
})

test('complete nested labels fit a small worker stack', async (t) => {
  for (const disabled of [[], ['core.italic']]) {
    const name = disabled.length ? 'disabled italic' : 'enabled italic'
    await t.test(name, async (t) => {
      const module = new URL(
        '../src/renderer/src/source-outline-label.worker.ts',
        import.meta.url,
      ).href
      const code = `
        import { parentPort } from 'node:worker_threads'
        import { createOutlineLabelReader } from ${JSON.stringify(module)}
        const read = createOutlineLabelReader({
          syntax: { gfm: true },
          flavors: ['markdown.github'],
          disabled: ${JSON.stringify(disabled)},
        })
        parentPort.postMessage(read({
          text: ${JSON.stringify(text)},
          level: 1,
          references: new Map(),
        }).label)
      `
      const worker = new Worker(
        new URL(`data:text/javascript,${encodeURIComponent(code)}`),
        {
          resourceLimits: { stackSizeMb: 0.5 },
        },
      )
      t.after(() => worker.terminate())
      const label = await new Promise((resolve, reject) => {
        worker.once('message', resolve)
        worker.once('error', reject)
      })
      assert.equal(
        label,
        disabled.length ? text : `${'a '.repeat(1000)}b${' a'.repeat(1000)}`,
      )
    })
  }
})

test('pending long labels cannot publish after an edit or disposal', () => {
  const source = `# ${text}\n`
  const store = new SourceStore(source, { tabId: 'labels', revision: 0 })
  const model = new SourceOutlineModel(store.snapshot(), {
    gfm: true,
    frontmatter: false,
    deferLabels: true,
    renderLabel: () =>
      assert.fail('long labels must not convert in the renderer'),
  })
  try {
    const stale = pendingLabel(model).work
    const before = store.snapshot()
    const prepared = store.prepare({
      document: before.document,
      operationId: 'replace-heading',
      baseVersion: before.version,
      contentVersion: before.version + 1,
      origin: 'source',
      historyGroup: 'test',
      changes: [{ from: 2, to: 2, insert: 'new ' }],
    })
    store.commit(prepared)
    model.apply(prepared)
    const reply = { label: 'stale', references: [], missing: [] }
    assert.throws(() => stale.next(reply), /stale/)
    const disposed = pendingLabel(model).work
    model.dispose()
    assert.throws(() => disposed.next(reply), /disposed/)
  } finally {
    model.dispose()
  }
})
