import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { uncovered } from '../src/renderer/src/chunked-markdown.ts'
import {
  formattedSyntax,
  restoredOpening,
} from '../src/renderer/src/formatted-syntax.ts'

const doc = Array.from(
  { length: 2000 },
  (_, i) => `line ${i} with *some* text\n\n`,
).join('')

/** Where the first parse of a new view reads inline syntax, with each clock read `step` ms on. */
const parsed = (t, extensions, options, step) => {
  let now = 0
  t.mock.method(performance, 'now', () => {
    now += step
    return now
  })
  const syntax = formattedSyntax(options)
  const state = EditorState.create({
    doc,
    extensions: [extensions, syntax.extension],
  })
  t.mock.restoreAll()
  const emphasis = []
  syntax.tree(state).iterate({
    enter: (node) => {
      if (node.name === 'Emphasis') emphasis.push(node.from)
    },
  })
  return emphasis
}

test('a restored view parses its opening up to its ceiling, a new view one slice, and a set slice bounds it', (t) => {
  // 10 ms per clock read: a slice ends at its first check, the restored
  // ceiling after a few parse steps, well before the 8 KB opening.
  const last = (...args) => parsed(t, ...args, 10).at(-1) ?? 0
  const restored = last(restoredOpening.of(0), {})
  assert.ok(restored > 0 && restored < 8192, `restored parsed to ${restored}`)
  assert.equal(last([], {}), 0)
  assert.equal(last(restoredOpening.of(0), { slice: 0 }), 0)
  assert.equal(last(restoredOpening.of(0), { slice: 8 }), 0)
  assert.equal(last(restoredOpening.of(0), { slice: 1e6 }), restored)
})

test('a view restored deep in a note reads inline syntax at its place, not at the note start', (t) => {
  const at = doc.indexOf('line 1500 ')
  const deep = parsed(t, restoredOpening.of(at), {}, 0)
  assert.ok(
    deep[0] > 8192 && deep[0] <= at && deep.some((from) => from >= at),
    `inline syntax from ${deep[0]} to ${deep.at(-1)} around ${at}`,
  )
  // A new view reads its first 8 KB.
  assert.ok(parsed(t, [], {}, 1).every((from) => from < 8192 + 64))
})

test('a restored note shorter than a chunk opens parsed within its ceiling on a slow first slice', (t) => {
  // The rebuilt reading note: a view restored near its end. Before, a boundary
  // scan of the whole note came first, and at 16 ms per clock read the
  // ceiling ended the parse with nothing parsed.
  const note = `${Array.from({ length: 400 }, (_, i) => `line ${i}\n\n`).join('')}end\n\n`
  const at = note.indexOf('line 300')
  const opened = (step) => {
    let now = 0
    t.mock.method(performance, 'now', () => {
      now += step
      return now
    })
    const syntax = formattedSyntax({})
    const state = EditorState.create({
      doc: note,
      extensions: [restoredOpening.of(at), syntax.extension],
    })
    t.mock.restoreAll()
    return syntax.tree(state)
  }
  assert.equal(uncovered(opened(16), 0, note.length), false)
  // The ceiling still ends a parse step that takes all of it.
  assert.equal(uncovered(opened(48), at, note.length), true)
})
