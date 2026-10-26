import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorSelection, EditorState, Text } from '@codemirror/state'
import {
  contribution,
  frontmatterField,
  frontmatterOf,
  frontmatterProbe,
} from '../src/addons/frontmatter/formatted.ts'
import * as core from '../src/renderer/src/formatted-frontmatter.ts'
import { readFrontmatter } from '../src/shared/frontmatter.ts'

const text = (doc) => Text.of(doc.split('\n'))
const end = (doc) => frontmatterOf(text(doc)).end

test('frontmatter is a closed YAML mapping at the start, hidden with one blank line', () => {
  const yaml = '---\ntitle: x\ntags: [a]\n---\n'
  assert.equal(end(`${yaml}\n# Title`), yaml.length + 1)
  assert.equal(end(`${yaml}# Title`), yaml.length)
  // More blank lines show; a final empty line stays editable.
  assert.equal(end(`${yaml}\n\n# Title`), yaml.length + 1)
  assert.equal(end(yaml), yaml.length)
  assert.equal(end('---\na: 1\n---'), '---\na: 1\n---'.length)
  assert.equal(end('---\na: 1\n...\nbody'), '---\na: 1\n...\n'.length)
  assert.equal(end('\uFEFF---\n{}\n---\nbody'), '\uFEFF---\n{}\n---\n'.length)
  // Dividers, lists, prose and unclosed blocks are Markdown.
  for (const doc of [
    '---\n\nparagraph',
    '---\n- a\n- b\n---\n',
    '---\njust some words\n---\n',
    '---\n---\n',
    '# ---\na: 1\n---',
    ' ---\na: 1\n---',
  ])
    assert.equal(end(doc), 0, JSON.stringify(doc))
})

test('the shared frontmatter reader decides, for anchors, tags, directives and comments too', () => {
  for (const header of [
    '&a\nkey: value',
    '&a key: value',
    '!!map\nkey: value',
    '!tag\nkey: value',
    '%YAML 1.2\nkey: value',
    '# comment\nkey: value',
    '? complex key\n: value',
    '{a: 1, b: 2}',
    '"quoted": key',
    '- a\n- b',
    '!!str\nkey: value',
    'plain words',
    '*alias',
    '',
  ]) {
    const doc = `---\n${header}\n---\nbody`
    const shared = readFrontmatter(doc)
    assert.equal(
      end(doc),
      shared ? shared.prefix.length : 0,
      JSON.stringify(header),
    )
  }
  // Protection follows: an anchored header is hidden and its body stays editable.
  const doc = '---\n&a\nkey: value\n---\nbody'
  const state = EditorState.create({
    doc,
    selection: { anchor: doc.length },
    extensions: contribution.extension,
  })
  assert.equal(state.field(frontmatterField).end, doc.indexOf('body'))
  assert.equal(
    state
      .update({ changes: { from: 4, insert: 'x' }, userEvent: 'input.type' })
      .state.doc.toString(),
    doc,
  )
})

test('edits after the closing line read no lines; edits inside read only the frontmatter', () => {
  const body = Array.from({ length: 50000 }, (_, i) => `line ${i}`).join('\n')
  const doc = `---\ntitle: big\n---\n\n${body}`
  frontmatterProbe.lines = 0
  let state = EditorState.create({ doc, extensions: frontmatterField })
  assert.ok(frontmatterProbe.lines < 10, `${frontmatterProbe.lines}`)
  const hidden = state.field(frontmatterField).end
  for (let key = 0; key < 100; key++) {
    frontmatterProbe.lines = 0
    state = state.update({
      changes: { from: state.doc.length - 3, insert: 'x' },
    }).state
    assert.equal(frontmatterProbe.lines, 0)
  }
  assert.equal(state.field(frontmatterField).end, hidden)
  frontmatterProbe.lines = 0
  state = state.update({
    changes: { from: 4, insert: 'date: 2026-10-26\n' },
    userEvent: 'input.addon',
  }).state
  assert.ok(frontmatterProbe.lines < 10, `${frontmatterProbe.lines}`)
  assert.equal(state.field(frontmatterField).end, hidden + 17)
  // Body edits parse no YAML; an edit inside parses the frontmatter once.
  frontmatterProbe.parses = 0
  for (let key = 0; key < 100; key++)
    state = state.update({
      changes: { from: state.doc.length, insert: 'y' },
    }).state
  assert.equal(frontmatterProbe.parses, 0)
  state = state.update({
    changes: { from: 4, insert: 'z' },
    userEvent: 'input.addon',
  }).state
  assert.equal(frontmatterProbe.parses, 1)
})

test('an edit inside frontmatter longer than one search keeps it hidden and protected', () => {
  const yaml = Array.from({ length: 6000 }, (_, i) => `key${i}: value ${i}`)
  let state = EditorState.create({
    doc: `---\n${yaml.join('\n')}\n---\n\nbody`,
    extensions: frontmatterField,
  })
  // Its closing line is past the first search: idle slices find it.
  while (
    !state.field(core.frontmatterBounds).closer &&
    state.field(core.frontmatterBounds).searched < state.doc.length
  )
    state = state.update({ effects: core.frontmatterSearch.of(null) }).state
  const hidden = state.field(frontmatterField).end
  assert.ok(hidden > core.frontmatterProbe.search, `${hidden}`)
  frontmatterProbe.lines = 0
  frontmatterProbe.parses = 0
  state = state.update({
    changes: { from: 10, insert: 'x' },
    userEvent: 'input.addon',
  }).state
  // Before, the edit searched again from the top and lost the closing line
  // until idle time found it again.
  assert.equal(state.field(frontmatterField).end, hidden + 1)
  assert.ok(frontmatterProbe.lines < 10, `${frontmatterProbe.lines}`)
  assert.equal(frontmatterProbe.parses, 1)
  // An edited line that closes it earlier ends it there.
  const at = state.doc.line(3).to
  state = state.update({
    changes: { from: at, insert: '\n---' },
    userEvent: 'input.addon',
  }).state
  assert.equal(state.field(core.frontmatterBounds).closer, at + 4)
  // An edit to the closing line reads on from it, and idle slices find the
  // next one.
  state = state.update({
    changes: { from: at + 1, to: at + 4, insert: 'key: x' },
    userEvent: 'input.addon',
  }).state
  while (
    !state.field(core.frontmatterBounds).closer &&
    state.field(core.frontmatterBounds).searched < state.doc.length
  )
    state = state.update({ effects: core.frontmatterSearch.of(null) }).state
  assert.equal(state.field(frontmatterField).end, hidden + 1 + 7)
})

test('a divider at the top of a long note reads one search when it opens and the rest in idle slices', () => {
  const body = Array.from({ length: 200000 }, (_, i) => `words ${i}`).join('\n')
  for (const extensions of [frontmatterField, core.frontmatterBounds]) {
    frontmatterProbe.lines = 0
    let state = EditorState.create({ doc: `---\n${body}`, extensions })
    // Before, opening read every line for a closing one: 200,000 here.
    const opened = frontmatterProbe.lines
    assert.ok(opened > 0 && opened < 10000, `${opened}`)
    let slices = 0
    while (state.field(core.frontmatterBounds).searched < state.doc.length) {
      const lines = frontmatterProbe.lines
      state = state.update({ effects: core.frontmatterSearch.of(null) }).state
      assert.ok(frontmatterProbe.lines - lines < 10000)
      slices++
    }
    assert.ok(slices > 10, `${slices}`)
    assert.ok(
      frontmatterProbe.lines <= state.doc.lines,
      `${frontmatterProbe.lines}`,
    )
    assert.equal(state.field(core.frontmatterBounds).end, 0)
  }
})

test('a divider at the top of a long note is read once, then only edited lines', () => {
  const body = Array.from({ length: 50000 }, (_, i) => `words ${i}`).join('\n')
  frontmatterProbe.lines = 0
  let state = EditorState.create({
    doc: `---\n${body}`,
    extensions: frontmatterField,
  })
  assert.equal(state.field(frontmatterField).end, 0)
  assert.ok(frontmatterProbe.lines <= 50001)
  for (let key = 0; key < 100; key++) {
    frontmatterProbe.lines = 0
    state = state.update({ changes: { from: 2000, insert: 'y' } }).state
    assert.ok(frontmatterProbe.lines <= 1, `${frontmatterProbe.lines}`)
  }
  // A closing line after prose does not make the prose frontmatter.
  const at = state.doc.line(30).to
  frontmatterProbe.lines = 0
  state = state.update({ changes: { from: at, insert: '\n---' } }).state
  assert.equal(state.field(frontmatterField).end, 0)
  assert.ok(frontmatterProbe.lines < 10, `${frontmatterProbe.lines}`)
  // Closing a mapping does.
  state = EditorState.create({
    doc: `---\nkey: value\n${body}`,
    extensions: frontmatterField,
  })
  state = state.update({
    changes: { from: state.doc.line(2).to, insert: '\n---' },
  }).state
  assert.equal(
    state.field(frontmatterField).end,
    '---\nkey: value\n---\n'.length,
  )
})

test('typing, deleting and selecting all stop at the frontmatter', () => {
  const doc = '---\ntitle: x\n---\n\nBody text'
  const start = doc.indexOf('Body')
  const create = (selection = start) =>
    EditorState.create({
      doc,
      selection: { anchor: selection },
      extensions: contribution.extension,
    })
  let state = create()
  assert.equal(state.field(frontmatterField).end, start)
  // Backspace at the body start would delete the hidden blank line.
  assert.equal(
    state
      .update({
        changes: { from: start - 1, to: start },
        userEvent: 'delete.backward',
      })
      .state.doc.toString(),
    doc,
  )
  assert.equal(
    state.update({ changes: { from: 5, insert: 'z' }, userEvent: 'input.type' })
      .state.doc.length,
    doc.length,
  )
  // Addon edits, such as the properties editor's, change it.
  assert.ok(
    state
      .update({
        changes: { from: 4, to: 9, insert: 'name' },
        userEvent: 'input.addon',
      })
      .state.doc.toString()
      .startsWith('---\nname: x'),
  )
  // Selections that reach into it end at the note's text.
  state = state.update({
    selection: EditorSelection.range(0, doc.length),
  }).state
  assert.deepEqual(
    [state.selection.main.from, state.selection.main.to],
    [start, doc.length],
  )
  const [selectAll] = contribution.keys
  let dispatched = null
  const view = {
    get state() {
      return create(0)
    },
    dispatch: (spec) => {
      dispatched = spec
    },
  }
  assert.equal(selectAll.run(view), true)
  assert.deepEqual(
    [dispatched.selection.from, dispatched.selection.to],
    [start, doc.length],
  )
  // A note that ends on its closing line gets a line break before typed text.
  state = EditorState.create({
    doc: '---\na: 1\n---',
    selection: { anchor: 12 },
    extensions: contribution.extension,
  })
  const typed = state.update({
    changes: { from: 12, insert: 'x' },
    selection: { anchor: 13 },
    userEvent: 'input.type',
  }).state
  assert.equal(typed.doc.toString(), '---\na: 1\n---\nx')
  assert.equal(typed.selection.main.head, 14)
  // Typing the closing line hides the frontmatter and moves the caret below it.
  state = EditorState.create({
    doc: '---\na: 1\n\nbody',
    selection: { anchor: 9 },
    extensions: contribution.extension,
  })
  const closed = state.update({
    changes: { from: 9, insert: '---' },
    selection: { anchor: 12 },
    userEvent: 'input.type',
  }).state
  assert.equal(closed.field(frontmatterField).end, 13)
  assert.equal(closed.selection.main.head, 13)
})
