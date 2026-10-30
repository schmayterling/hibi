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
const { contributions } = await import('../src/renderer/src/formatted/html.ts')

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

test('html blocks are code-like boxes, styled only on their visible lines', () => {
  const doc = `<div>\n${Array.from({ length: 50 }, (_, i) => `row ${i}`).join('\n')}\n</div>\n\ntext`
  const state = EditorState.create({ doc })
  const [blocks] = contributions
  const [view] = blocks.views
  assert.deepEqual(view.space, { top: 16, bottom: 16 })
  const render = (visible) => {
    const lines = []
    markdown.parse(doc).iterate({
      enter(node) {
        if (view.nodes.includes(node.name))
          view.decorate(
            node,
            {
              mark() {},
              syntax() {},
              line: (at, attributes) =>
                lines.push([state.doc.lineAt(at).number, attributes.class]),
              widget() {},
              replace() {},
            },
            { state, revealed: false, visible },
          )
      },
    })
    return lines
  }
  const all = render({ from: 0, to: doc.length })
  assert.equal(all.length, 52)
  assert.deepEqual(all[0], [1, 'hibi-lp-codeblock hibi-lp-codeblock-first'])
  assert.deepEqual(all.at(-1), [52, 'hibi-lp-codeblock hibi-lp-codeblock-last'])
  // A viewport inside the block styles only its lines.
  const middle = render({
    from: state.doc.line(20).from,
    to: state.doc.line(24).to,
  })
  assert.deepEqual(
    middle.map(([number]) => number),
    [20, 21, 22, 23, 24],
  )
})

test('a lone <img> tag shows its image like a Markdown image, inline or as a block', () => {
  const draw = (doc, revealed = false) => {
    const state = EditorState.create({ doc })
    const out = []
    const widget = (widget) => [widget.source, widget.alt, widget.title]
    markdown.parse(doc).iterate({
      enter(node) {
        for (const { views } of contributions)
          for (const view of views) {
            if (!view.nodes.includes(node.name)) continue
            const context = { state, revealed, visible: null }
            view.layout?.(
              node,
              {
                replace: (from, to, image) =>
                  out.push(['replace', doc.slice(from, to), ...widget(image)]),
                widget: (at, image, options) =>
                  out.push(['widget', at, ...widget(image), options.side]),
              },
              context,
            )
            view.decorate?.(
              node,
              {
                mark: (from, to) => out.push(['chip', doc.slice(from, to)]),
                syntax() {},
                line: (at) => out.push(['line', at]),
                widget() {},
                replace() {},
              },
              { ...context, visible: { from: 0, to: doc.length } },
            )
          }
      },
    })
    return out
  }
  assert.deepEqual(draw('a <img src=cat.png alt="a &amp; b"> b'), [
    ['replace', '<img src=cat.png alt="a &amp; b">', 'cat.png', 'a & b', ''],
  ])
  assert.deepEqual(
    draw(
      '<IMG title=\'T\' SRC="https://example.com/a.png?x=1&amp;y=2" src=b.png />  \n\ntext',
    ),
    [
      [
        'replace',
        `<IMG title='T' SRC="https://example.com/a.png?x=1&amp;y=2" src=b.png />`,
        'https://example.com/a.png?x=1&y=2',
        '',
        'T',
      ],
    ],
  )
  // Revealed, the source stays editable with the image beside it.
  assert.deepEqual(draw('a <img src=cat.png> b', true), [
    ['widget', 19, 'cat.png', '', '', 1],
    ['chip', '<img src=cat.png>'],
  ])
  assert.deepEqual(draw('<img src=cat.png>', true), [
    ['widget', 17, 'cat.png', '', '', 1],
    ['line', 0],
    ['chip', '<img src=cat.png>'],
  ])
  // Without a source, or inside an HTML block, it stays source.
  assert.deepEqual(draw('a <img alt=x> b'), [['chip', '<img alt=x>']])
  assert.deepEqual(draw('<div><img src=a.png></div>'), [
    ['line', 0],
    ['chip', '<div><img src=a.png></div>'],
  ])
})
