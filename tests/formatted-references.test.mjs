import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { parser } from '@lezer/markdown'
import {
  drawReference,
  formattedReferences,
  knownReference,
  referenceLink,
  referenceLinks,
  referenceWork,
  retainedLabels,
  retainedReferences,
} from '../src/renderer/src/formatted-references.ts'
import { markdownLink } from '../src/shared/markdown-link.ts'

test('reference labels normalize as link following and definitions do', () => {
  for (const source of [
    '[text][ label ]',
    '[ label ]',
    '[ẞ]',
    '[Foo\n\t Bar][]',
    '[x][İstanbul]',
    '[a  b]',
  ]) {
    const state = EditorState.create({ doc: source })
    let label
    parser.parse(source).iterate({
      enter(node) {
        if (node.name === 'Link')
          label ??= referenceLink(state.doc, node.node)?.label
      },
    })
    assert.equal(label, markdownLink(source)?.label, JSON.stringify(source))
  }
})

/** A view of the reference state and requests, without a DOM. */
function referenceView(resolve) {
  const view = {
    viewport: { from: 0, to: 4 },
    state: EditorState.create({
      doc: 'text',
      extensions: [
        referenceLinks,
        formattedReferences.of({ syntax: () => 'test', resolve }),
      ],
    }),
    dispatch(spec) {
      const startState = this.state
      const transaction = startState.update(spec)
      this.state = transaction.state
      plugin.update({
        state: this.state,
        startState,
        docChanged: transaction.docChanged,
        viewportChanged: false,
      })
    },
  }
  const plugin = referenceLinks[1].create(view)
  return { view, plugin }
}

const idle = new Map()
let nextIdle = 0
globalThis.requestIdleCallback = (callback) => {
  idle.set(++nextIdle, callback)
  return nextIdle
}
globalThis.cancelIdleCallback = (id) => idle.delete(id)
/** Run microtasks and idle callbacks until requests settle. */
async function settle() {
  for (let round = 0; round < 12; round++) {
    await Promise.resolve()
    const callbacks = [...idle.values()]
    idle.clear()
    for (const callback of callbacks) callback()
  }
}

test('reference answers stay bounded by recently drawn labels and restart with a replaced note', async () => {
  let calls = 0
  const { view, plugin } = referenceView(async () => {
    calls++
    return { status: 'resolved', value: { href: '/x', title: null } }
  })
  const before = { ...referenceWork }
  // 20,000 labels drawn 32 at a time, as scrolling through a long note does.
  for (let batch = 0; batch < 625; batch++) {
    for (let i = 0; i < 32; i++) drawReference(view.state, `r${batch * 32 + i}`)
    plugin.later()
    await settle()
  }
  assert.equal(calls, 20000)
  assert.equal(retainedReferences(view.state), retainedLabels)
  // Each answer is stored once: no copies of earlier answers per batch.
  assert.equal(referenceWork.stored - before.stored, 20000)
  // A note replaced whole keeps none of its labels.
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: 'new note text' },
  })
  await settle()
  assert.equal(retainedReferences(view.state), 0)
  plugin.destroy()
})

for (const cell of [undefined, 100])
  test(`lookups for ${cell === undefined ? 'paragraph' : 'table cell'} labels scrolled out of view are dropped for those in view`, async () => {
    const jobs = [],
      aborted = []
    const { view, plugin } = referenceView(
      (label, signal) =>
        new Promise((resolve) => {
          jobs.push({ label, resolve })
          signal.addEventListener('abort', () => aborted.push(label))
        }),
    )
    // A table cell still in view keeps its lookup.
    drawReference(view.state, 'kept', 2)
    for (let i = 0; i < 31; i++) drawReference(view.state, `old-${i}`, cell)
    plugin.later()
    await settle()
    assert.equal(jobs.length, 32)
    for (let i = 0; i < 32; i++) drawReference(view.state, `visible-${i}`)
    plugin.update({
      state: view.state,
      startState: view.state,
      docChanged: false,
      viewportChanged: true,
    })
    await settle()
    assert.deepEqual(
      aborted.sort(),
      Array.from({ length: 31 }, (_, i) => `old-${i}`).sort(),
    )
    assert.equal(
      jobs.filter(({ label }) => label.startsWith('visible')).length,
      31,
    )
    plugin.destroy()
  })

for (const order of [
  [2, 100],
  [100, 2],
])
  test(`a label in table cells in and out of view keeps its lookup, drawn in order ${order}`, async () => {
    const jobs = [],
      aborted = []
    const { view, plugin } = referenceView(
      (label, signal) =>
        new Promise((resolve) => {
          jobs.push({ label, resolve })
          signal.addEventListener('abort', () => aborted.push(label))
        }),
    )
    view.viewport = { from: 0, to: 104 }
    for (const at of order) drawReference(view.state, 'shared', at)
    plugin.later()
    await settle()
    assert.equal(jobs.length, 1)
    // Only the cell at 100 scrolls away.
    view.viewport = { from: 0, to: 4 }
    plugin.update({
      state: view.state,
      startState: view.state,
      docChanged: false,
      viewportChanged: true,
    })
    await settle()
    assert.deepEqual(aborted, [])
    plugin.destroy()
  })

test('only definitive host answers make reference labels known', async () => {
  for (const [result, expected] of [
    [{ status: 'unavailable' }, undefined],
    [{ status: 'resolved', value: null }, null],
    [
      { status: 'resolved', value: { href: '/x', title: 'title' } },
      { title: 'title' },
    ],
  ]) {
    const { view, plugin } = referenceView(async () => result)
    try {
      assert.equal(knownReference(view.state, 'label'), undefined)
      drawReference(view.state, 'label')
      plugin.later()
      await settle()
      assert.deepEqual(knownReference(view.state, 'label'), expected)
    } finally {
      plugin.destroy()
    }
  }
})

test('an edit makes a cached negative reference answer unknown until refreshed', async () => {
  let result = { status: 'resolved', value: null }
  const { view, plugin } = referenceView(async () => result)
  try {
    drawReference(view.state, 'label')
    plugin.later()
    await settle()
    assert.equal(knownReference(view.state, 'label'), null)
    result = {
      status: 'resolved',
      value: { href: '/x', title: 'new definition' },
    }
    view.dispatch({ changes: { from: 0, insert: 'x' } })
    assert.equal(knownReference(view.state, 'label'), undefined)
    drawReference(view.state, 'label')
    plugin.later()
    await settle()
    assert.deepEqual(knownReference(view.state, 'label'), {
      title: 'new definition',
    })
  } finally {
    plugin.destroy()
  }
})
