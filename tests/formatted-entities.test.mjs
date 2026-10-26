import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { GFM, parser } from '@lezer/markdown'
import {
  contribution,
  EntityWidget,
} from '../src/renderer/src/formatted/entities.ts'

const markdown = parser.configure(GFM)
const [view] = contribution.views

/** What the entity view draws for `doc`, revealed or not. */
function render(doc, revealed = false) {
  const state = EditorState.create({ doc })
  const out = []
  markdown.parse(doc).iterate({
    enter(node) {
      if (!view.nodes.includes(node.name)) return
      view.decorate(
        node,
        {
          mark: (from, to, attributes) =>
            out.push(['mark', from, to, attributes.class]),
          syntax() {},
          line() {},
          widget() {},
          replace: (from, to, widget) =>
            out.push(['glyph', from, to, widget.text]),
        },
        { state, revealed },
      )
    },
  })
  return out
}

test('entities show their characters and their source while revealed', () => {
  assert.deepEqual(render('a &amp; b'), [['glyph', 2, 7, '&']])
  assert.deepEqual(render('&#169; &#x1F600; &nbsp;'), [
    ['glyph', 0, 6, '©'],
    ['glyph', 7, 16, '😀'],
    ['glyph', 17, 23, ' '],
  ])
  assert.deepEqual(render('a &amp; b', true), [
    ['mark', 2, 7, 'hibi-lp-marker'],
  ])
  // Unknown names stay text; code keeps its source.
  assert.deepEqual(render('&nosuchname; `&amp;`'), [])
  assert.deepEqual(render('```\n&amp;\n```'), [])
  assert.ok(new EntityWidget('&').eq(new EntityWidget('&')))
  assert.ok(!new EntityWidget('&').eq(new EntityWidget('<')))
})
