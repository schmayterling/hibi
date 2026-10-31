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
const { renderInline } = await import(
  '../src/renderer/src/formatted/table-cells.ts'
)
const { formattedViews } = await import(
  '../src/renderer/src/formatted-contributions.ts'
)
const { formattedMarkdownParser } = await import(
  '../src/shared/formatted-markdown.ts'
)

const markdown = parser.configure(GFM)
const formatted = formattedMarkdownParser([...GFM])
const views = contributions.flatMap((contribution) => contribution.views)

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

/**
 * What the HTML views lay out, then draw, for `doc` in the formatted view's
 * grammar; each pass skips the children of a node a view returns false for.
 */
function draw(doc, revealed = false, state = EditorState.create({ doc })) {
  const tree = formatted.parse(doc)
  const visit = (run) =>
    tree.iterate({
      enter(node) {
        let skip = false
        for (const view of views)
          if (view.nodes.includes(node.name) && run(view, node) === false)
            skip = true
        return skip ? false : undefined
      },
    })
  const out = []
  const image = (widget) => [
    widget.source,
    widget.alt,
    widget.title,
    widget.width,
    widget.height,
  ]
  const context = { state, revealed, visible: null }
  visit((view, node) =>
    view.layout?.(
      node,
      {
        replace: (from, to, widget) =>
          out.push(['replace', doc.slice(from, to), ...image(widget)]),
        widget: (at, widget, options) =>
          out.push(['widget', at, ...image(widget), options.side]),
      },
      context,
    ),
  )
  visit((view, node) =>
    view.decorate?.(
      node,
      {
        mark: (from, to) => out.push(['chip', doc.slice(from, to)]),
        syntax() {},
        line: (at) => out.push(['line', at]),
        widget() {},
        replace() {},
      },
      { ...context, visible: { from: 0, to: Math.min(doc.length, 200) } },
    ),
  )
  return out
}

test('an <img> tag shows its image like a Markdown image, inline or alone on its line', () => {
  assert.deepEqual(draw('a <img src=cat.png alt="a &amp; b"> b'), [
    [
      'replace',
      '<img src=cat.png alt="a &amp; b">',
      'cat.png',
      'a & b',
      '',
      0,
      0,
    ],
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
        0,
        0,
      ],
    ],
  )
  // Revealed, the source stays editable with the image beside it.
  assert.deepEqual(draw('a <img src=cat.png> b', true), [
    ['widget', 19, 'cat.png', '', '', 0, 0, 1],
    ['chip', '<img src=cat.png>'],
  ])
  // Alone on its line, too: a paragraph's tag, not an HTML block's box.
  assert.deepEqual(draw('<img src=cat.png>', true), [
    ['widget', 17, 'cat.png', '', '', 0, 0, 1],
    ['chip', '<img src=cat.png>'],
  ])
  // Without a source, or inside an HTML block, it stays source.
  assert.deepEqual(draw('a <img alt=x> b'), [['chip', '<img alt=x>']])
  assert.deepEqual(draw('<div><img src=a.png></div>'), [
    ['line', 0],
    ['chip', '<div><img src=a.png></div>'],
  ])
  assert.deepEqual(draw('<img src=a.png>\nmore'), [
    ['line', 0],
    ['chip', '<img src=a.png>'],
    ['line', 16],
    ['chip', 'more'],
  ])
})

test('an <img> tag sizes its image by its width and height in whole pixels', () => {
  const size = (tag) => draw(`a ${tag} b`)[0].slice(5, 7)
  assert.deepEqual(size('<img src=a.png width=200 height="100">'), [200, 100])
  assert.deepEqual(size("<img src=a.png WIDTH='0320'>"), [320, 0])
  assert.deepEqual(
    size('<img src=a.png height=9999 width=10 width=20>'),
    [10, 9999],
  )
  // Up to four digits, as an embed's `|200x100`; anything else keeps the
  // image's own size.
  for (const tag of [
    '<img src=a.png width=50% height=1e3>',
    '<img src=a.png width=12345 height=-1>',
    '<img src=a.png width=" 20" height=2.5>',
    '<img src=a.png width height>',
  ])
    assert.deepEqual(size(tag), [0, 0], tag)
})

test('only <img> tags are laid out, so other HTML adds no layout work on edits', () => {
  // A parsed chunk is laid out again after every edit while it holds a node
  // that a view with a layout hook renders.
  assert.deepEqual(
    views.filter((view) => view.layout).flatMap((view) => view.nodes),
    ['HTMLImage'],
  )
  const doc =
    'a <kbd>k</kbd> <img src=x> <imgx> <img:x> <IMG\nsrc=y alt="a b"/> <br> `<img src=z>` \\<img src=w>\n\n<img src=v>\n\n<!-- <img src=u> -->\n\n<div><img src=t></div>'
  const images = []
  formatted.parse(doc).iterate({
    enter(node) {
      if (node.name === 'HTMLImage') images.push(doc.slice(node.from, node.to))
    },
  })
  assert.deepEqual(images, [
    '<img src=x>',
    '<IMG\nsrc=y alt="a b"/>',
    '<img src=v>',
  ])
})

test('drawing images never reads HTML blocks', () => {
  const lines = Array.from(
    { length: 20000 },
    (_, i) => `line ${i} of the block`,
  ).join('\n')
  for (const doc of [
    `<img src=a.png>\n${lines}\n\nafter`,
    `<div>\n<img src=a.png>\n${lines}\n</div>\n\nafter`,
  ]) {
    const state = EditorState.create({ doc })
    let read = 0
    const slice = state.sliceDoc.bind(state)
    state.sliceDoc = (from = 0, to = state.doc.length) => {
      read += to - from
      return slice(from, to)
    }
    assert.deepEqual(draw(doc, false, state).slice(0, 2), [
      ['line', 0],
      ['chip', doc.slice(0, doc.indexOf('\n'))],
    ])
    assert.ok(read < 1000, `${read} characters read`)
  }
})

test('a lone <img> line is a paragraph, so it is spaced like a Markdown image', () => {
  const blocks = (doc) => {
    const out = []
    formatted.parse(doc).iterate({
      enter(node) {
        if (node.name === 'Paragraph' || node.name === 'HTMLBlock')
          out.push(
            [node.name, node.node.firstChild?.name].filter(Boolean).join('>'),
          )
      },
    })
    return out
  }
  assert.deepEqual(blocks('![a](x.png)\n\ntext'), [
    'Paragraph>Image',
    'Paragraph',
  ])
  for (const doc of [
    '<img src=x.png>\n\ntext',
    '  <IMG SRC="x.png" alt=\'a b\'>  \n\ntext',
    '<img src=x.png>\r\n\r\ntext',
  ])
    assert.deepEqual(
      blocks(doc),
      ['Paragraph>HTMLImage', 'Paragraph'],
      JSON.stringify(doc),
    )
  assert.deepEqual(blocks('<img src=x.png>'), ['Paragraph>HTMLImage'])
  assert.deepEqual(blocks('> <img src=x.png>\n>\n> t'), [
    'Paragraph>HTMLImage',
    'Paragraph',
  ])
  assert.deepEqual(blocks('> <img src=x.png>\nlazy'), [
    'Paragraph>HTMLImage',
    'Paragraph',
  ])
  assert.deepEqual(blocks('- <img src=x.png>\n- b'), [
    'Paragraph>HTMLImage',
    'Paragraph',
  ])
  // More lines before a blank one make an HTML block, as in CommonMark.
  assert.deepEqual(blocks('<img src=x.png>\nmore\n\ntext'), [
    'HTMLBlock',
    'Paragraph',
  ])
  // After a paragraph's line, the tag is more of that paragraph.
  const paragraph = formatted.parse('para\n<img src=x.png>\n\ntext').topNode
    .firstChild
  assert.deepEqual([paragraph.name, paragraph.to], ['Paragraph', 20])
})

test('an <img> tag in a table cell shows as HTML, as a Markdown image shows as written', (t) => {
  class Element {
    attributes = {}
    children = []
    setAttribute(name, value) {
      this.attributes[name] = value
    }
    append(...children) {
      this.children.push(...children)
    }
  }
  const prior = globalThis.document
  globalThis.document = {
    createElement: () => new Element(),
    createTextNode: (text) => ({ text }),
  }
  t.after(() => {
    if (prior === undefined) delete globalThis.document
    else globalThis.document = prior
  })
  const text = 'cell <img src="https://x/c.png" width=9> <b>b</b> text'
  const state = EditorState.create({
    doc: text,
    extensions: views.map((view) => formattedViews.of(view)),
  })
  const into = new Element()
  renderInline({ state }, text, into)
  const read = (node) =>
    node.text ?? (node.children ?? []).map((child) => read(child)).join('')
  const chips = []
  const collect = (node) => {
    if (node.attributes?.class === 'hibi-lp-code hibi-lp-html')
      chips.push(read(node))
    for (const child of node.children ?? []) collect(child)
  }
  collect(into)
  assert.equal(read(into), text)
  assert.deepEqual(chips, [
    '<img src="https://x/c.png" width=9>',
    '<b>',
    '</b>',
  ])
})
