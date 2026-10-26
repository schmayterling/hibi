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
  assert.deepEqual(images('![two\n  lines](a.png "a\ntitle")'), [
    { source: 'a.png', alt: 'two lines', title: 'a title', label: undefined },
  ])
  // Reference images need the note's definitions, so they stay source.
  assert.deepEqual(images('![ref][r]\n\n[r]: x.png'), [null])
})

test('media replace their source, also across lines, which shows beside them while revealed', () => {
  const [view] = contribution.views
  const render = (doc, revealed) => {
    const state = EditorState.create({ doc })
    const out = []
    markdown.parse(doc).iterate({
      enter(node) {
        if (!view.nodes.includes(node.name)) return
        const context = { state, revealed, visible: null }
        view.layout(
          node,
          {
            replace: (from, to, widget) =>
              out.push(['replace', doc.slice(from, to), widget.source]),
            widget: (at, widget, options) =>
              out.push(['widget', at, widget.source, options.side]),
          },
          context,
        )
        view.decorate(
          node,
          {
            mark: (from, to, attributes) =>
              out.push(['mark', doc.slice(from, to), attributes.class]),
            syntax() {},
            line() {},
            widget() {},
            replace() {},
          },
          { ...context, visible: { from: 0, to: doc.length } },
        )
      },
    })
    return out
  }
  const doc = 'see ![cat](cat.png) here'
  assert.deepEqual(render(doc, false), [
    ['replace', '![cat](cat.png)', 'cat.png'],
  ])
  assert.deepEqual(render(doc, true), [
    ['widget', 19, 'cat.png', 1],
    ['mark', '![', 'hibi-lp-marker'],
    ['mark', '](cat.png)', 'hibi-lp-marker'],
  ])
  // A description or destination on a second line still makes one widget.
  assert.deepEqual(render('see ![a\ncat](cat.png) here', false), [
    ['replace', '![a\ncat](cat.png)', 'cat.png'],
  ])
  assert.deepEqual(render('see ![cat](\ncat.png "t") here', false), [
    ['replace', '![cat](\ncat.png "t")', 'cat.png'],
  ])
  // Equal sources keep their DOM; the revision is the view's, not the widget's.
  const widget = new MediaWidget('cat.png', 'cat', '')
  assert.ok(widget.eq(new MediaWidget('cat.png', 'cat', '')))
  assert.ok(!widget.eq(new MediaWidget('dog.png', 'cat', '')))
  assert.ok(!widget.eq(new MediaWidget('cat.png', 'dog', '')))
})
