import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { GFM, parser } from '@lezer/markdown'
import { contributions } from '../src/renderer/src/formatted/html.ts'

const markdown = parser.configure(GFM)

/** What the HTML views draw for `doc`. */
function render(doc, revealed = false) {
  const state = EditorState.create({ doc })
  const out = []
  const sink = {
    mark: (from, to, attributes) =>
      out.push(['chip', doc.slice(from, to), attributes.class]),
    syntax() {},
    line: (at, attributes) => out.push(['line', at, attributes.class]),
    widget: (at) => out.push(['break after', at]),
    replace: (from, to) => out.push(['break', doc.slice(from, to)]),
  }
  markdown.parse(doc).iterate({
    enter(node) {
      for (const { views } of contributions)
        for (const view of views)
          if (view.nodes.includes(node.name))
            view.decorate?.(node, sink, { state, revealed })
    },
  })
  return out
}

test('inline html shows as editable source chips and <br> breaks the line', () => {
  const chip = 'hibi-lp-code hibi-lp-html'
  assert.deepEqual(render('a <b>bold</b> <!-- note --> <?pi?>'), [
    ['chip', '<b>', chip],
    ['chip', '</b>', chip],
    ['chip', '<!-- note -->', chip],
    ['chip', '<?pi?>', chip],
  ])
  assert.deepEqual(render('one<br>two<BR />three'), [
    ['break', '<br>'],
    ['break', '<BR />'],
  ])
  // A revealed break shows its tag and still breaks after it.
  assert.deepEqual(render('one<br/>two', true), [
    ['chip', '<br/>', chip],
    ['break after', 8],
  ])
})
