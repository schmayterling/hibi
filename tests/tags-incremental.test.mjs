import assert from 'node:assert/strict'
import test from 'node:test'
import { markdown } from '@codemirror/lang-markdown'
import { ensureSyntaxTree, syntaxTreeAvailable } from '@codemirror/language'
import { EditorState as SourceState } from '@codemirror/state'
import { Node, Schema } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import {
  frontmatterPrefix,
  frontmatterState,
  richTags,
  sourceTagRanges,
  updateFrontmatterState,
} from '../src/addons/tags/decorations.ts'
import { scheduleTagCounts } from '../src/addons/tags/schedule.ts'
import { tagMatches } from '../src/addons/tags/syntax.ts'

test('tag count reads source after input settles and reuses document versions', async () => {
  let current = 'first'
  let reads = 0
  const sent = []
  const published = []
  const counter = scheduleTagCounts(
    () => {
      reads++
      return { key: current, source: `#${current}` }
    },
    (job) => sent.push(job),
    (tags) => published.push(tags),
  )
  try {
    counter.refresh('first')
    assert.equal(reads, 0, 'edit callback must not materialize source')
    current = 'second'
    counter.refresh('second')
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.deepEqual(
      sent.map((job) => job.key),
      ['second'],
    )
    counter.receive({ key: 'second', tags: ['second'] })
    counter.refresh('first')
    counter.refresh('second')
    assert.deepEqual(published, [['second'], ['second']])
    assert.equal(reads, 1, 'cached version must not read source again')
  } finally {
    counter.stop()
  }
})

test('source tag scanning stays inside visible lines and skips frontmatter', (t) => {
  const source = [
    '---',
    'title: "#metadata"',
    '---',
    '',
    'opening #first',
    ...Array.from({ length: 1000 }, (_, index) => `ordinary line ${index}`),
    'ending #last',
  ].join('\n')
  let state = SourceState.create({ doc: source, extensions: [markdown()] })
  assert.ok(ensureSyntaxTree(state, state.doc.length, 1000))
  state = state.update({}).state
  const first = state.doc.line(2)
  const last = state.doc.line(state.doc.lines)
  const textPrototype = Object.getPrototypeOf(state.doc)
  const original = textPrototype.sliceString
  const sizes = []
  t.mock.method(textPrototype, 'sliceString', function (...args) {
    sizes.push((args[1] ?? this.length) - (args[0] ?? 0))
    return original.apply(this, args)
  })
  const prefix = frontmatterPrefix(state)
  const hidden = []
  sourceTagRanges(state, [{ from: first.from, to: first.to }], prefix).between(
    0,
    source.length,
    (from, to) => hidden.push([from, to]),
  )
  assert.deepEqual(hidden, [])
  const shown = []
  sourceTagRanges(state, [{ from: last.from, to: last.to }], prefix).between(
    0,
    source.length,
    (from, to, value) =>
      shown.push([from, to, value.spec.attributes['data-tag']]),
  )
  assert.deepEqual(shown, [[last.to - 5, last.to, 'last']])
  assert.ok(
    sizes.every((size) => size < source.length / 4),
    'scrolling must not materialize or scan the full source',
  )
})

test('unclosed frontmatter skips whole-note rescans but finds a new closing fence', (t) => {
  const source = [
    '---',
    'title: note',
    ...Array.from({ length: 5000 }, (_, index) => `body ${index}`),
  ].join('\n')
  const state = SourceState.create({ doc: source })
  const previous = frontmatterState(state)
  const edit = state.update({
    changes: { from: state.doc.length, insert: 'x' },
  })
  const textPrototype = Object.getPrototypeOf(edit.state.doc)
  const original = textPrototype.line
  let lines = 0
  t.mock.method(textPrototype, 'line', function (...args) {
    lines++
    return original.apply(this, args)
  })
  assert.strictEqual(
    updateFrontmatterState(previous, edit.changes, edit.state),
    previous,
  )
  assert.ok(lines < 10, 'ordinary edits must not probe every line')

  const unclosed = SourceState.create({ doc: '---\ntitle: note\nbody #tag' })
  const at = unclosed.doc.line(3).from
  const closed = unclosed.update({ changes: { from: at, insert: '---\n' } })
  assert.equal(
    updateFrontmatterState(
      frontmatterState(unclosed),
      closed.changes,
      closed.state,
    ).prefix,
    closed.state.doc.line(4).from,
  )

  const invalid = SourceState.create({ doc: '---\nplain text\n---\nbody #tag' })
  const badHeader = frontmatterState(invalid)
  assert.equal(badHeader.prefix, 0)
  const line = invalid.doc.line(2)
  const repaired = invalid.update({
    changes: { from: line.from, to: line.to, insert: 'title: note' },
  })
  assert.equal(
    updateFrontmatterState(badHeader, repaired.changes, repaired.state).prefix,
    repaired.state.doc.line(4).from,
  )
})

test('source tags wait for distant syntax before highlighting code fences', () => {
  const source = [
    ...Array.from({ length: 10000 }, (_, index) => `ordinary line ${index}`),
    '```md',
    '#hidden',
    '```',
    'plain #visible',
  ].join('\n')
  const state = SourceState.create({ doc: source, extensions: [markdown()] })
  const hidden = state.doc.line(10002)
  const visible = state.doc.line(10004)
  assert.equal(syntaxTreeAvailable(state, visible.to), false)
  const tags = (current) => {
    const found = []
    sourceTagRanges(
      current,
      [{ from: hidden.from, to: visible.to }],
      0,
    ).between(0, source.length, (_from, _to, value) =>
      found.push(value.spec.attributes['data-tag']),
    )
    return found
  }
  assert.deepEqual(tags(state), [])
  assert.ok(ensureSyntaxTree(state, visible.to, 1000))
  assert.deepEqual(tags(state), [], 'uncommitted syntax remains unavailable')
  const parsed = state.update({}).state
  assert.equal(syntaxTreeAvailable(parsed, visible.to), true)
  assert.deepEqual(tags(parsed), ['visible'])
})

test('rich tags map decorations and rescan only changed blocks', (t) => {
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      text: { group: 'inline' },
      paragraph: { group: 'block', content: 'text*' },
      codeBlock: { group: 'block', content: 'text*', code: true },
    },
    marks: { code: {}, link: { attrs: { href: {} } } },
  })
  const paragraph = (text) =>
    schema.nodes.paragraph.create(null, schema.text(text))
  let plugin
  richTags(() => {}).attach({
    state: { doc: schema.nodes.doc.create(null, [paragraph('start')]) },
    registerPlugin(value) {
      plugin = value
    },
  })
  let state = EditorState.create({
    schema,
    plugins: [plugin],
    doc: schema.nodes.doc.create(null, [
      paragraph('first #one'),
      ...Array.from({ length: 400 }, (_, index) =>
        paragraph(`ordinary line ${index}`),
      ),
      paragraph('last #two'),
    ]),
  })
  const spans = () =>
    plugin
      .getState(state)
      .find()
      .map((range) => [range.from, range.to, range.type.attrs['data-tag']])
  const expected = () => {
    const ranges = []
    state.doc.descendants((node, position) => {
      if (
        node.type.spec.code ||
        node.marks.some((mark) => ['code', 'link'].includes(mark.type.name))
      )
        return false
      if (node.isText)
        for (const match of tagMatches(node.text ?? ''))
          ranges.push([position + match.from, position + match.to, match.tag])
    })
    return ranges
  }
  const apply = (transaction) => {
    state = state.apply(transaction)
    assert.deepEqual(spans(), expected())
  }
  assert.deepEqual(spans(), expected())
  const edit = state.tr.insertText('x', 2)
  const changedDoc = edit.doc
  const original = Node.prototype.nodesBetween
  let fullScans = 0
  t.mock.method(Node.prototype, 'nodesBetween', function (...args) {
    if (this === changedDoc && args[0] === 0 && args[1] === this.content.size)
      fullScans++
    return original.apply(this, args)
  })
  state = state.apply(edit)
  assert.equal(fullScans, 0, 'local edit must not walk the full rich document')
  assert.deepEqual(spans(), expected())
  const firstEnd = state.doc.firstChild.nodeSize
  apply(state.tr.addMark(2, firstEnd - 1, schema.marks.code.create()))
  apply(state.tr.removeMark(2, firstEnd - 1, schema.marks.code))
  apply(
    state.tr.addMark(2, firstEnd - 1, schema.marks.link.create({ href: '#' })),
  )
  apply(state.tr.removeMark(2, firstEnd - 1, schema.marks.link))
  apply(state.tr.setNodeMarkup(0, schema.nodes.codeBlock))
  apply(state.tr.setNodeMarkup(0, schema.nodes.paragraph))
  apply(state.tr.insertText(' #three', 3))
})
