import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as nextTask } from 'node:timers/promises'
import { EditorState, Text, Transaction } from '@codemirror/state'
import {
  createSourceSession,
  sourceEditorTextCooperatively,
} from '../src/renderer/src/source-session.ts'
import { DocumentSession } from '../src/shared/document-session.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'
import { normalizedChunks } from '../src/shared/source-projection.ts'
import { sourceEditorText } from './source-editor-text.mjs'

const document = { tabId: 'cm-loading', revision: 0 }
function storeFor(raw) {
  const loader = SourceStore.loader(document)
  for (let from = 0; from < raw.length; from += 65536)
    loader.append(raw.slice(from, from + 65536))
  return loader.finish()
}

async function measuredText(t, store) {
  let treeWork = 0,
    appends = 0,
    maxOfLines = 0
  const restores = []
  const trace = (target, name, observe) => {
    const original = target[name]
    target[name] = function (...args) {
      observe.apply(this, args)
      return original.apply(this, args)
    }
    restores.push(() => {
      target[name] = original
    })
  }
  const restore = () => {
    for (const reset of restores) reset()
  }
  t.after(restore)
  const leaf = Text.of(['x']),
    node = Text.of(Array(128).fill('x'))
  for (const prototype of [
    Text.prototype,
    Object.getPrototypeOf(leaf),
    Object.getPrototypeOf(node),
  ])
    for (const name of ['replace', 'decompose', 'flatten']) {
      if (!Object.hasOwn(prototype, name)) continue
      trace(prototype, name, function () {
        treeWork += this.children?.length ?? this.lines
      })
    }
  for (const [type, name] of [
    [node.constructor, 'from'],
    [leaf.constructor, 'split'],
  ]) {
    trace(type, name, (items) => {
      treeWork += items.length
    })
  }
  trace(Text, 'of', (lines) => {
    maxOfLines = Math.max(maxOfLines, lines.length)
    assert.ok(lines.length <= 512, `Text.of received ${lines.length} lines`)
    treeWork += lines.length
  })
  trace(Text.prototype, 'append', () => {
    appends++
  })
  for (const method of ['toString', 'toJSON'])
    trace(Text.prototype, method, () =>
      assert.fail(`builder must not call Text.${method}`),
    )
  store.counters(true)
  let tasks = 0,
    units = 0,
    yields = 0,
    previousReads = 0,
    maxTreeWork = 0,
    maxAppends = 0,
    maxReadUnits = 0,
    maxChunks = 0
  const text = await sourceEditorTextCooperatively(store.snapshot(), {
    signal: new AbortController().signal,
    yieldTask: async () => {
      yields++
      await nextTask()
    },
    onTask: (work) => {
      tasks++
      units += work.sourceUnits
      const reads = store.counters().sourceUnitsRead - previousReads
      previousReads += reads
      maxReadUnits = Math.max(maxReadUnits, reads)
      maxTreeWork = Math.max(maxTreeWork, treeWork)
      maxAppends = Math.max(maxAppends, appends)
      maxChunks = Math.max(maxChunks, work.chunks)
      assert.ok(work.sourceUnits <= 16384)
      assert.ok(reads <= 16400, `source reads/task: ${reads}`)
      assert.ok(work.maxLines <= 512)
      assert.ok(work.chunks <= 16385)
      assert.equal(work.appends, appends)
      assert.ok(appends <= 34, `appends/task: ${appends}`)
      assert.ok(treeWork < 100000, `tree slots/task: ${treeWork}`)
      treeWork = 0
      appends = 0
    },
  })
  assert.equal(units, store.snapshot().utf16Length)
  assert.ok(tasks > 1)
  assert.equal(yields, tasks - 1)
  assert.ok(maxOfLines > 0)
  assert.equal(store.counters().materializations, 0)
  assert.equal(store.counters().unitsScanned, 0)
  assert.equal(text.length, store.snapshot().normalizedLength)
  assert.equal(text.lines, store.snapshot().lineCount)
  let offset = 0
  for (const chunk of normalizedChunks(store.snapshot())) {
    assert.equal(text.sliceString(offset, offset + chunk.length), chunk)
    offset += chunk.length
  }
  assert.equal(offset, text.length)
  t.diagnostic(
    JSON.stringify({
      units,
      tasks,
      yields,
      maxReadUnits,
      maxChunks,
      maxAppends,
      maxOfLines,
      maxTreeWork,
    }),
  )
  restore()
  return text
}

test('50 mib native Text construction bounds each task and preserves every normalized unit', async (t) => {
  const pattern = `${'line '.repeat(79)}\r\n`
  const raw =
    `\ufeff${pattern.repeat(Math.ceil((50 * 1024 * 1024) / pattern.length))}`.slice(
      0,
      50 * 1024 * 1024,
    )
  const store = storeFor(raw)
  await measuredText(t, store)
  let from = 0
  for (const chunk of store.snapshot().chunks()) {
    assert.equal(chunk, raw.slice(from, from + chunk.length))
    from += chunk.length
  }
  assert.equal(from, raw.length)
})

test('nonascii over 20 mib preserves BOM, CRLF and paired and lone surrogates', async (t) => {
  const raw = `\ufeff${'中😀\r\n'.repeat(3 * 1024 * 1024)}\ud800end\udc00\r`
  const store = storeFor(raw)
  assert.ok(store.snapshot().utf8Bytes > 20 * 1024 * 1024)
  const text = await measuredText(t, store)
  assert.equal(text.sliceString(0, 5), '\ufeff中😀\n')
  assert.equal(text.sliceString(text.length - 6), '\ud800end\udc00\n')
})

test('50 mib single line appends native ropes without collecting one giant lines array', async (t) => {
  const raw = `\ufeff😀${'x'.repeat(50 * 1024 * 1024)}\ud800`
  const text = await measuredText(t, storeFor(raw))
  assert.equal(text.lines, 1)
  assert.equal(text.sliceString(0, 4), '\ufeff😀x')
  assert.equal(text.sliceString(text.length - 2), 'x\ud800')
})

test('newline-dense input bounds line arrays, appends and native tree work per task', async (t) => {
  const store = storeFor('\n'.repeat(2 * 1024 * 1024))
  const text = await measuredText(t, store)
  assert.equal(text.lines, 2 * 1024 * 1024 + 1)
})

test('empty, small and boundary-split text matches existing CM normalization exactly', async () => {
  for (const raw of [
    '',
    '\ufeffa\r\n😀\ud800z\udc00中\r\n\n\r👩🏽‍💻e\u0301',
    `${'x'.repeat(16383)}\r\n😀\r`,
    `${'x'.repeat(16383)}😀\r\n`,
    '\n'.repeat(512),
  ]) {
    const store = new SourceStore(raw, document, 0, { chunkUnits: 4 })
    let yields = 0
    const text = await sourceEditorTextCooperatively(store.snapshot(), {
      signal: new AbortController().signal,
      yieldTask: async () => {
        yields++
      },
    })
    assert.equal(text.toString(), raw.replace(/\r\n?/g, '\n'))
    assert.equal(text.eq(sourceEditorText(store.snapshot())), true)
    if (raw.length <= 16384) assert.equal(yields, 0)
    assert.equal(store.snapshot().materialize(), raw)
  }
})

test('default scheduler allows another task before completing the native Text', async () => {
  const store = storeFor('line\r\n'.repeat(100000))
  let finished = false
  const channel = new MessageChannel()
  const heartbeat = new Promise((resolve) => {
    channel.port1.onmessage = () => resolve(!finished)
    channel.port2.postMessage(null)
  })
  try {
    const pending = sourceEditorTextCooperatively(store.snapshot(), {
      signal: new AbortController().signal,
    }).then((text) => {
      finished = true
      return text
    })
    assert.equal(await heartbeat, true)
    const text = await pending
    assert.equal(text.length, 500000)
  } finally {
    channel.port1.close()
    channel.port2.close()
  }
})

test('abort before start or during a yield stops all further source and tree work', async () => {
  for (const beforeStart of [true, false]) {
    const store = storeFor('x'.repeat(65536)),
      controller = new AbortController()
    let tasks = 0,
      yields = 0,
      readsAtAbort = 0
    if (beforeStart) controller.abort()
    store.counters(true)
    const text = await sourceEditorTextCooperatively(store.snapshot(), {
      signal: controller.signal,
      onTask: () => tasks++,
      yieldTask: async () => {
        yields++
        controller.abort()
        readsAtAbort = store.counters().sourceUnitsRead
      },
    })
    assert.equal(text, null)
    assert.equal(tasks, beforeStart ? 0 : 1)
    assert.equal(yields, beforeStart ? 0 : 1)
    assert.equal(store.counters().sourceUnitsRead, readsAtAbort)
  }
})

test('other-pane edits cancel stale construction; retry captures only latest version', async () => {
  const session = new DocumentSession(
    storeFor('line\r\n'.repeat(20000)),
    document,
    0,
    { enqueue() {}, onError: assert.fail },
  )
  try {
    const staleBridge = createSourceSession(session)
    let staleTasks = 0
    const stale = await sourceEditorTextCooperatively(staleBridge.snapshot(), {
      signal: new AbortController().signal,
      isCurrent: () => session.ownsCurrentSnapshot(staleBridge.snapshot()),
      onTask: () => staleTasks++,
      yieldTask: async () => {
        for (let i = 0; i < 10; i++)
          session.edit(
            [{ from: i, to: i, insert: '中' }],
            'source',
            `other-${i}`,
          )
      },
    })
    assert.equal(stale, null)
    assert.equal(staleTasks, 1)
    const bridge = createSourceSession(session, 'waiting')
    const text = await sourceEditorTextCooperatively(bridge.snapshot(), {
      signal: new AbortController().signal,
      isCurrent: () => session.ownsCurrentSnapshot(bridge.snapshot()),
      yieldTask: nextTask,
    })
    assert.equal(bridge.snapshot().version, 10)
    assert.equal(text.eq(sourceEditorText(session.snapshot())), true)
    const view = {
      state: EditorState.create({ doc: text }),
      update(transactions) {
        for (const transaction of transactions) this.state = transaction.state
      },
    }
    const detach = bridge.attach(view)
    assert.deepEqual(session.historyDepth(), { undo: 10, redo: 0 })
    detach()
  } finally {
    session.dispose()
  }
})

test('version or identity changes on final task never publish stale completed Text', async () => {
  for (const change of [
    (session) =>
      session.edit([{ from: 0, to: 0, insert: '!' }], 'source', 'other'),
    (session) => session.reidentify({ ...document, revision: 1 }),
  ]) {
    const session = new DocumentSession('small\r\nnote', document, 0, {
      enqueue() {},
      onError: assert.fail,
    })
    try {
      const source = session.snapshot()
      const text = await sourceEditorTextCooperatively(source, {
        signal: new AbortController().signal,
        isCurrent: () => session.ownsCurrentSnapshot(source),
        onTask: () => change(session),
      })
      assert.equal(text, null)
    } finally {
      session.dispose()
    }
  }
})

test('cooperatively mounted session retains exact raw text, history and selection', async () => {
  const raw = '\ufeffone\r\n😀two\ud800\nthree\r'
  const session = new DocumentSession(raw, document, 0, {
    enqueue() {},
    onError: assert.fail,
  })
  try {
    session.select({
      ranges: [{ anchor: 6, head: 6, association: 1 }],
      mainIndex: 0,
    })
    const bridge = createSourceSession(session)
    const text = await sourceEditorTextCooperatively(bridge.snapshot(), {
      signal: new AbortController().signal,
    })
    const view = {
      state: EditorState.create({ doc: text, selection: bridge.selection() }),
      update(transactions) {
        for (const transaction of transactions) this.state = transaction.state
      },
    }
    const detach = bridge.attach(view)
    assert.equal(view.state.selection.main.head, 5)
    bridge.dispatch(
      [
        view.state.update({
          changes: { from: 5, insert: '中\n' },
          selection: { anchor: 7 },
          annotations: Transaction.userEvent.of('input.type'),
        }),
      ],
      view,
    )
    assert.equal(
      session.snapshot().materialize(),
      '\ufeffone\r\n中\r\n😀two\ud800\nthree\r',
    )
    assert.deepEqual(session.historyDepth(), { undo: 1, redo: 0 })
    assert.equal(bridge.undo(), true)
    assert.equal(session.snapshot().materialize(), raw)
    assert.equal(view.state.selection.main.head, 5)
    detach()
    const remount = createSourceSession(session)
    assert.equal(remount.selection().main.head, 5)
  } finally {
    session.dispose()
  }
})
