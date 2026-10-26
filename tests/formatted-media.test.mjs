import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { GFM, parser } from '@lezer/markdown'

// Feature modules import their styles; these tests need only the code.
registerHooks({
  load: (url, context, next) =>
    url.endsWith('.css')
      ? { format: 'module', source: '', shortCircuit: true }
      : next(url, context),
})
const { contribution, imageOf, MediaWidget } = await import(
  '../src/renderer/src/formatted/media.ts'
)
const { formattedDocument } = await import(
  '../src/renderer/src/formatted-contributions.ts'
)

const markdown = parser.configure(GFM)
const images = (doc) => {
  const state = EditorState.create({ doc })
  const out = []
  markdown.parse(doc).iterate({
    enter(node) {
      if (node.name === 'Image') out.push(imageOf(state, node))
    },
  })
  return out.map((image) => image && { ...image, label: undefined })
}

test('image sources, descriptions and titles read like the rich editor', () => {
  assert.deepEqual(images('![a cat](cat.png "A &amp; B")'), [
    { source: 'cat.png', alt: 'a cat', title: 'A & B', label: undefined },
  ])
  assert.deepEqual(images('![](<my file.png>) ![x\\*](b\\(c\\).png)'), [
    { source: 'my file.png', alt: '', title: '', label: undefined },
    { source: 'b(c).png', alt: 'x*', title: '', label: undefined },
  ])
  // Reference images need the note's definitions, so they stay source.
  assert.deepEqual(images('![ref][r]\n\n[r]: x.png'), [null])
})

test('media replace their source, which shows beside them while revealed', () => {
  const [view] = contribution.views
  const doc = 'see ![cat](cat.png) here'
  const render = (revealed) => {
    const state = EditorState.create({
      doc,
      extensions: formattedDocument.of({ revision: 7, tabId: 'tab' }),
    })
    const out = []
    markdown.parse(doc).iterate({
      enter(node) {
        if (!view.nodes.includes(node.name)) return
        view.decorate(
          node,
          {
            mark() {},
            syntax: (from, to) => out.push(['syntax', doc.slice(from, to)]),
            line() {},
            widget: (at, widget) => out.push(['widget', at, widget.revision]),
            replace: (from, to, widget) =>
              out.push(['replace', doc.slice(from, to), widget.revision]),
          },
          { state, revealed, visible: { from: 0, to: doc.length } },
        )
      },
    })
    return out
  }
  assert.deepEqual(render(false), [['replace', '![cat](cat.png)', 7]])
  assert.deepEqual(render(true), [
    ['syntax', '!['],
    ['syntax', '](cat.png)'],
    ['widget', 19, 7],
  ])
  // A new revision resolves the media again; equal widgets keep their DOM.
  const widget = new MediaWidget('cat.png', 'cat', '', 7)
  assert.ok(widget.eq(new MediaWidget('cat.png', 'cat', '', 7)))
  assert.ok(!widget.eq(new MediaWidget('cat.png', 'cat', '', 8)))
  assert.ok(!widget.eq(new MediaWidget('dog.png', 'cat', '', 7)))
})
