import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as nextTask } from 'node:timers/promises'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { EditorState } from '@codemirror/state'
import { GFM, parser } from '@lezer/markdown'
import { ChunkedMarkdownParser } from '../src/renderer/src/chunked-markdown.ts'
import { blockBreak } from '../src/renderer/src/formatted-commands.ts'
import {
  createSourceSession,
  sourceEditorTextCooperatively,
} from '../src/renderer/src/source-session.ts'
import { sourceWhitespace } from '../src/renderer/src/source-whitespace.ts'
import { DocumentSession } from '../src/shared/document-session.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'

// The test runner passes no --expose-gc.
setFlagsFromString('--expose-gc')
const gc = runInNewContext('gc')
const key = { tabId: 'whitespace', revision: 0 }
const textFor = (snapshot) =>
  sourceEditorTextCooperatively(snapshot, {
    signal: new AbortController().signal,
    yieldTask: nextTask,
  })

test('source whitespace matches every JavaScript whitespace unit and normalized endpoint', async () => {
  const whitespace =
    '\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'
  const raw = `😀\ud800x\r\n${whitespace}\r\n\udfffz \t`
  const store = new SourceStore(raw, key)
  const text = await textFor(store.snapshot())
  const normalized = raw.replace(/\r\n?/g, '\n')
  assert.equal(
    sourceWhitespace(EditorState.create({ doc: ' ' }).doc, 0),
    undefined,
  )
  for (let from = 0; from <= normalized.length; from++)
    for (let to = from; to <= normalized.length; to++) {
      const range = normalized.slice(from, to)
      assert.equal(sourceWhitespace(text, from, to), !/\S/.test(range))
    }
  const clone = SourceStore.fromSnapshot(store.snapshot())
  assert.equal(clone.snapshot().isWhitespace(6, 6 + whitespace.length), true)
})

test('source whitespace follows admitted edits, hidden echoes and undo without changing older snapshots', async () => {
  const session = new DocumentSession('x\r\n \t', key, 0, {
    enqueue: () => {},
    onError: (error) => {
      throw error
    },
  })
  const bridge = createSourceSession(session)
  const before = session.snapshot()
  const original = await textFor(before)
  const view = {
    state: EditorState.create({ doc: original }),
    update(transactions) {
      for (const transaction of transactions) this.state = transaction.state
    },
  }
  const detach = bridge.attach(view)
  const check = (expected) =>
    assert.equal(sourceWhitespace(view.state.doc, 2), expected)
  check(true)
  bridge.dispatch(
    [view.state.update({ changes: { from: 3, insert: 'z' } })],
    view,
  )
  check(false)
  assert.equal(sourceWhitespace(original, 2), true)
  assert.equal(before.isWhitespace(3), true)
  assert.equal(bridge.undo(), true)
  check(true)
  assert.equal(bridge.redo(), true)
  check(false)
  bridge.setVisible(false)
  session.edit([{ from: 4, to: 5, insert: '\u00a0' }], 'source', 'replace')
  check(false)
  bridge.setVisible(true)
  check(true)
  detach()
  session.dispose()
})

async function compactableView(t, source) {
  const session = new DocumentSession(source, key, 0, {
    chunkUnits: 65536,
    enqueue: () => {},
    onError: (error) => {
      throw error
    },
  })
  // Retain one space per arena chunk so maintenance has storage to reclaim.
  session.edit(
    [{ from: 0, to: 0, insert: ' '.repeat(5 * 65536) }],
    'source',
    'paste',
  )
  session.edit(
    Array.from({ length: 5 }, (_, i) => ({
      from: 1 + i * 65536,
      to: (i + 1) * 65536,
      insert: '',
    })),
    'source',
    'cut',
  )
  const bridge = createSourceSession(session)
  const view = {
    state: EditorState.create({ doc: await textFor(session.snapshot()) }),
    update(transactions) {
      for (const transaction of transactions) this.state = transaction.state
    },
  }
  const detach = bridge.attach(view)
  t.after(() => {
    detach()
    session.dispose()
  })
  return { session, bridge, view }
}

test('live mixed-tail Enter survives storage compaction and garbage collection', async (t) => {
  for (const visible of [true, false])
    await t.test(
      visible ? 'shown' : 'hidden without pending edits',
      async (t) => {
        const prefix = `first\n\n${'old tail\n\n'.repeat(20000)}`
        const { session, bridge, view } = await compactableView(
          t,
          prefix + ' \t\n'.repeat(1400),
        )
        const from = prefix.length + 5
        view.state = view.state.update({ selection: { anchor: from } }).state
        bridge.setVisible(visible)
        const doc = view.state.doc
        const markdown = parser.configure(GFM)
        const parse = new ChunkedMarkdownParser(
          markdown,
          markdown,
        ).startChunkedParse(
          {
            length: doc.length,
            lineChunks: false,
            chunk: (from) =>
              doc.sliceString(from, Math.min(from + 4096, doc.length)),
            read: (from, to) => doc.sliceString(from, to),
          },
          [],
          { from: 0, to: 8192 },
        )
        let tree
        while (!tree) tree = parse.advance()
        assert.ok(tree.topNode.lastChild.to < from)
        const inserted = () =>
          view.state.update(blockBreak(view.state, tree)).newDoc.length -
          doc.length
        assert.equal(sourceWhitespace(doc, from), true)
        assert.equal(inserted(), 2)
        const oldSnapshot = new WeakRef(session.snapshot())
        const epoch = session.snapshot().storageEpoch
        await session.maintainStorage()
        assert.equal(session.snapshot().storageEpoch, epoch + 1)
        for (let i = 0; i < 20; i++) {
          await nextTask()
          gc()
        }
        assert.equal(oldSnapshot.deref(), undefined)
        assert.equal(view.state.doc, doc)
        assert.equal(bridge.isCurrent(), true)
        assert.equal(sourceWhitespace(doc, from), true)
        assert.equal(inserted(), 2)
      },
    )
})

test('storage replacement does not bind stale hidden text to newer same-length content', async (t) => {
  const { session, bridge, view } = await compactableView(
    t,
    `x\n${' \t\n'.repeat(1400)}`,
  )
  const before = session.snapshot()
  const doc = view.state.doc
  const from = 7
  bridge.setVisible(false)
  session.edit([{ from, to: from + 1, insert: 'z' }], 'source', 'replace')
  const epoch = session.snapshot().storageEpoch
  await session.maintainStorage()
  assert.equal(session.snapshot().storageEpoch, epoch + 1)
  for (let i = 0; i < 20; i++) {
    await nextTask()
    gc()
  }
  assert.equal(view.state.doc, doc)
  assert.equal(before.isWhitespace(from), true)
  assert.equal(session.snapshot().isWhitespace(from), false)
  assert.equal(session.snapshot().normalizedLength, doc.length)
  assert.equal(bridge.isCurrent(), false)
  assert.equal(sourceWhitespace(doc, from), true)
  bridge.setVisible(true)
  assert.equal(bridge.isCurrent(), true)
  assert.equal(sourceWhitespace(view.state.doc, from), false)
})

test('indexed whitespace proofs keep bounded reads at 1 and 50 MiB', async (t) => {
  for (const size of [1, 50]) {
    const loader = SourceStore.loader(key)
    const prefix = 'first\n\n'
    const chunk = `${' \t'.repeat(2047)} \n`
    loader.append(prefix)
    for (let at = 0; at < size * 2 ** 20; at += chunk.length)
      loader.append(chunk)
    const store = loader.finish()
    const snapshot = store.snapshot()
    const text = await textFor(snapshot)
    store.counters(true)
    assert.equal(snapshot.isWhitespace(prefix.length), true)
    const raw = store.counters(true)
    assert.equal(sourceWhitespace(text, prefix.length), true)
    const indexed = store.counters()
    assert.ok(raw.unitsScanned <= 64, JSON.stringify(raw))
    assert.ok(indexed.unitsScanned <= 1024, JSON.stringify(indexed))
    assert.ok(indexed.nodeVisits <= 32, JSON.stringify(indexed))
    assert.equal(indexed.materializations, 0)
    assert.ok(indexed.sourceUnitsRead <= 2)
    t.diagnostic(JSON.stringify({ mib: size, raw, indexed }))
  }
})

test('whitespace bindings do not retain disposed source snapshots', async () => {
  const make = async () => {
    const store = new SourceStore('x\n \t'.repeat(1000), key)
    return {
      text: await textFor(store.snapshot()),
      snapshot: new WeakRef(store.snapshot()),
    }
  }
  const { text, snapshot } = await make()
  for (let tries = 0; tries < 20; tries++) {
    await nextTask()
    gc()
    if (!snapshot.deref()) break
  }
  assert.equal(snapshot.deref(), undefined)
  assert.equal(sourceWhitespace(text, 0), undefined)
})
