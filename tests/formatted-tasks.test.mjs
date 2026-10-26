import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { parser } from '@lezer/markdown'
import { ChunkedMarkdownParser } from '../src/renderer/src/chunked-markdown.ts'

// Feature modules import their styles; these tests need only the code.
registerHooks({
  load: (url, context, next) =>
    url.endsWith('.css')
      ? { format: 'module', source: '', shortCircuit: true }
      : next(url, context),
})
const { contribution, TaskWidget, toggleTask } = await import(
  '../src/renderer/src/formatted/tasks.ts'
)

const markdown = parser.configure(contribution.syntax)
const tasks = (doc) => {
  const out = []
  markdown.parse(doc).iterate({
    enter(node) {
      if (node.name === 'Task' || node.name === 'TaskMarker')
        out.push(`${node.name}:${node.from}-${node.to}`)
    },
  })
  return out
}

test('task markers parse with text, empty, at a line end and in nested blocks', () => {
  assert.deepEqual(tasks('- [ ] a'), ['Task:2-7', 'TaskMarker:2-5'])
  for (const empty of ['- [ ]', '- [x]', '* [X]', '+ [ ]'])
    assert.deepEqual(tasks(empty), ['Task:2-5', 'TaskMarker:2-5'], empty)
  assert.deepEqual(tasks('- [ ]  '), ['Task:2-7', 'TaskMarker:2-5'])
  assert.deepEqual(tasks('* [ ]\tx'), ['Task:2-7', 'TaskMarker:2-5'])
  // An empty task continues like a paragraph.
  assert.deepEqual(tasks('- [ ]\n  lazy'), ['Task:2-12', 'TaskMarker:2-5'])
  assert.deepEqual(tasks('> - [ ]\n> - [x]'), [
    'Task:4-7',
    'TaskMarker:4-7',
    'Task:12-15',
    'TaskMarker:12-15',
  ])
  assert.deepEqual(tasks('- [ ] a\n  - [ ]'), [
    'Task:2-7',
    'TaskMarker:2-5',
    'Task:12-15',
    'TaskMarker:12-15',
  ])
  for (const text of ['- [ ]text', 'x- [ ]', '[ ]', '- [y]', '-\t[  ]'])
    assert.deepEqual(tasks(text), [], text)
})

test('chunked parses keep task nodes where whole-document parses put them', () => {
  const units = [
    '- [ ] task',
    '- [x] done\n- [ ]',
    '- [ ]\n  lazy',
    '* [X]\n\n  - [ ]',
    '> - [ ]',
    'paragraph [ ] text',
    '1. [ ] numbered',
  ]
  const chunked = new ChunkedMarkdownParser(markdown, markdown, {
    chunkSize: 16,
    groupSize: 3,
  })
  const names = (tree) => {
    const out = []
    tree.iterate({
      enter(node) {
        if (node.type.name) out.push(`${node.name}:${node.from}-${node.to}`)
      },
    })
    return out
  }
  for (let seed = 0; seed < 40; seed++) {
    const text = Array.from(
      { length: 30 },
      (_, i) => units[(i * 7 + seed * 3) % units.length],
    ).join(seed % 2 ? '\n\n' : '\n')
    assert.deepEqual(
      names(chunked.parse(text)),
      names(markdown.parse(text)),
      `seed ${seed}`,
    )
  }
})

test('toggling a task edits only the character inside its marker', () => {
  const state = (doc) => EditorState.create({ doc })
  const toggled = (doc, pos) => {
    const spec = toggleTask(state(doc), pos)
    return spec && state(doc).update(spec).state.doc.toString()
  }
  assert.equal(toggled('- [ ] a', 2), '- [x] a')
  assert.equal(toggled('- [x] a', 2), '- [ ] a')
  assert.equal(toggled('- [X]', 2), '- [ ]')
  const spec = toggleTask(state('- [ ] a'), 2)
  assert.deepEqual(spec.changes, { from: 3, to: 4, insert: 'x' })
  assert.equal(spec.userEvent, 'input.toggle')
  // Stale positions and read-only notes leave the source alone.
  assert.equal(toggleTask(state('- [ ] a'), 0), null)
  assert.equal(toggleTask(state('- (x) a'), 2), null)
  assert.equal(
    toggleTask(
      EditorState.create({
        doc: '- [ ] a',
        extensions: EditorState.readOnly.of(true),
      }),
      2,
    ),
    null,
  )
})

test('the marker and the space after it become one checkbox', () => {
  const view = contribution.views.find((view) =>
    view.nodes.includes('TaskMarker'),
  )
  const render = (doc) => {
    const state = EditorState.create({ doc })
    const replaced = []
    markdown.parse(doc).iterate({
      enter(node) {
        if (!view.nodes.includes(node.name)) return
        view.decorate(
          node,
          {
            mark() {},
            syntax() {},
            line() {},
            widget() {},
            replace: (from, to, widget) =>
              replaced.push({ from, to, checked: widget.checked, widget }),
          },
          { state, revealed: false },
        )
      },
    })
    return replaced
  }
  const [open] = render('- [ ]  buy milk')
  assert.deepEqual([open.from, open.to, open.checked], [2, 7, false])
  assert.equal(open.widget.text, 'buy milk')
  const [done] = render('- [X]')
  assert.deepEqual([done.from, done.to, done.checked], [2, 5, true])
  // Equal checkboxes keep their DOM; a toggled one updates in place.
  assert.ok(new TaskWidget(false, 'a').eq(new TaskWidget(false, 'a')))
  assert.ok(!new TaskWidget(false, 'a').eq(new TaskWidget(true, 'a')))
})

test('task items hang their checkbox in a 30px indent without a bullet', () => {
  const doc = '- [ ] task\n- bullet\n- text\n\n  [ ] later paragraph'
  const state = EditorState.create({ doc })
  const containers = []
  const replaced = []
  const sink = {
    mark() {},
    syntax() {},
    line() {},
    widget() {},
    replace: (from) => replaced.push(from),
  }
  markdown.parse(doc).iterate({
    enter(node) {
      for (const view of contribution.views) {
        if (!view.nodes.includes(node.name)) continue
        if (view.container)
          containers.push(
            view.container(node, { state, revealed: false, visible: null }),
          )
        view.decorate?.(node, sink, {
          state,
          revealed: false,
          visible: { from: 0, to: doc.length },
        })
      }
    },
  })
  assert.deepEqual(containers, [
    { width: '30px', marker: false },
    undefined,
    undefined,
  ])
  // A marker after the item's first block is text.
  assert.deepEqual(replaced, [2])
})
