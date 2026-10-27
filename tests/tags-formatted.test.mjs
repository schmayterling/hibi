import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { GFM, parser } from '@lezer/markdown'
import { blockMathSyntax } from '../src/addons/math/formatted-syntax.ts'
import { formattedTags } from '../src/addons/tags/formatted.ts'
import { contributions as extras } from '../src/addons/text-extras/formatted.ts'
import { subtextSyntax } from '../src/addons/text-extras/formatted-syntax.ts'
import { renderInline } from '../src/renderer/src/formatted/table-cells.ts'
import {
  formattedLiteral,
  formattedNodeViews,
  formattedOpaque,
  formattedViews,
} from '../src/renderer/src/formatted-contributions.ts'
import { FrontmatterParser } from '../src/shared/frontmatter-parser.ts'
import { Footnotes, GithubAlerts } from '../src/shared/markdown-extra-syntax.ts'
import { noteTags } from '../src/shared/note-tags.ts'

const markdown = parser.configure(GFM)
// Table cells render their text with inline syntax only, as table-cells.ts does.
const cellParsers = new Map()
const cellsOf = (syntax) => {
  let cells = cellParsers.get(syntax)
  if (!cells) {
    cells = syntax.configure({ remove: [...syntax.blockNames] })
    cellParsers.set(syntax, cells)
  }
  return cells
}
const [view] = formattedTags(() => {}).views
/** Whether the view renders nodes of `type`, which it names or names a group of. */
const shows = (type) => view.nodes.some((name) => type.is(name))

/**
 * Tag marks the formatted view's renderer gives a note, visiting nodes in
 * the visible ranges as the live preview does: syntax that is off is not
 * entered, and each range gets its own pass.
 */
function render(
  doc,
  {
    ranges = [{ from: 0, to: doc.length }],
    off = [],
    syntax = markdown,
    prefix = 0,
  } = {},
) {
  const state = EditorState.create({
    doc,
    extensions: [
      off.map((name) => formattedLiteral.of(name)),
      // GitHub tables are opaque: their cells render on their own.
      formattedOpaque.of('Table'),
    ],
  })
  let read = 0,
    visits = 0
  const wrap = (node) =>
    node &&
    new Proxy(node, {
      get(target, key) {
        if (
          ['prevSibling', 'nextSibling', 'firstChild', 'lastChild'].includes(
            key,
          )
        )
          visits++
        const value = Reflect.get(target, key, target)
        if (
          [
            'prevSibling',
            'nextSibling',
            'firstChild',
            'lastChild',
            'parent',
          ].includes(key)
        )
          return wrap(value)
        if (key === 'childAfter') return (at) => wrap(value.call(target, at))
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  const sliceDoc = state.sliceDoc
  state.sliceDoc = (from, to) => {
    read += to - from
    return sliceDoc.call(state, from, to)
  }
  const marks = []
  const out = {
    mark: (from, to, attributes) => marks.push({ from, to, ...attributes }),
    syntax() {},
    line() {},
    widget() {},
    replace() {},
  }
  const tree = prefix
    ? new FrontmatterParser(syntax, prefix).parse(doc)
    : syntax.parse(doc)
  for (const visible of ranges)
    tree.iterate({
      from: visible.from,
      to: visible.to,
      enter(node) {
        if (off.includes(node.name)) return false
        if (node.name === 'TableCell') {
          const text = doc.slice(node.from, node.to)
          const cell = EditorState.create({ doc: text })
          cellsOf(syntax)
            .parse(text)
            .iterate({
              enter(inner) {
                if (shows(inner.type))
                  view.decorate(
                    inner,
                    {
                      ...out,
                      mark: (from, to, attributes) =>
                        out.mark(node.from + from, node.from + to, attributes),
                    },
                    {
                      state: cell,
                      visible: { from: 0, to: text.length },
                      revealed: false,
                    },
                  )
              },
            })
        }
        if (shows(node.type))
          view.decorate(
            {
              name: node.name,
              type: node.type,
              from: node.from,
              to: node.to,
              node: wrap(node.node),
            },
            out,
            { state, visible, revealed: false },
          )
      },
    })
  return { marks, read, visits }
}

const tags = (doc, options) =>
  [
    ...new Set(render(doc, options).marks.map((mark) => mark['data-tag'])),
  ].sort()

test('tags in text, headings, quotes, lists and tasks match the workspace index', () => {
  for (const doc of [
    '#a plain #b',
    '**#bold** *#em* ~~#strike~~ ***#both***',
    'foo#no (#paren) [#bracket] {#brace} x,#comma',
    '## Heading #h ##\n\nTitle #setext\n===',
    '> quoted #q\n>#lazy\n> > deep #d',
    '- item #i\n  continued #c\n- [ ] #task\n- [x] done #done\n1. one #o',
    '`#code` [#link](https://example.com) <b>#html</b> ![#image](x.png)',
    '<https://example.com/#auto> https://example.com/#bare www.example.com/#w',
    'a \\#escaped \\*#after-escape #foo\\_bar &amp;#entity',
    '```\n#fenced\n```\n\n    #indented\n\n<div>\n#block-html\n</div>',
    '#123 #_under #ü #日本 #a/b/c #trailing/ #-dash #tag. #tag,',
    'a  \n#after-break and\\\n#after-backslash',
    '**#a**#b `x`#c [x](u)#d',
    '[x #in-label](u) [#ref][r] [#empty]() ![#shortcut-image]',
    '| head #c |\n| --- |\n| #cell |',
    '#Upper #MiXeD',
  ])
    assert.deepEqual(tags(doc), noteTags(doc), JSON.stringify(doc))
})

/** A contributed block with inline text, which the tags addon does not know by name. */
const futureBlock = {
  defineNodes: [{ name: 'FutureBlock', block: true }, 'FutureMark'],
  parseBlock: [
    {
      name: 'FutureBlock',
      before: 'HorizontalRule',
      parse(cx, line) {
        if (line.next !== 64 || line.text.charCodeAt(line.pos + 1) !== 32)
          return false
        const from = cx.lineStart + line.pos
        const text = line.text.slice(line.pos + 2)
        cx.nextLine()
        cx.addElement(
          cx.elt('FutureBlock', from, from + 2 + text.length, [
            cx.elt('FutureMark', from, from + 2),
            ...cx.parser.parseInline(text, from + 2),
          ]),
        )
        return true
      },
    },
  ],
}
const contributed = parser.configure([
  GFM,
  Footnotes,
  GithubAlerts,
  subtextSyntax,
  blockMathSyntax,
  futureBlock,
])
const found = (doc, options) =>
  render(doc, { syntax: contributed, ...options }).marks.map(
    (mark) => mark['data-tag'],
  )

test('every leaf block with inline text holds its tags once, whichever syntax adds it', () => {
  for (const [doc, expected] of [
    ['-# small #small text', ['small']],
    ['- -# listed #listed\n- item #item', ['listed', 'item']],
    ['> -# quoted #quoted\n> after #after', ['quoted', 'after']],
    [
      '@ future #future\n\n- @ listed #listed\n\n> @ quoted #quoted',
      ['future', 'listed', 'quoted'],
    ],
    ['> - [ ] task #task\n>   - nested #nested', ['task', 'nested']],
    ['| head #head |\n| - |\n| #cell |', ['head', 'cell']],
  ]) {
    assert.deepEqual(found(doc), expected, JSON.stringify(doc))
    assert.deepEqual(noteTags(doc), [...expected].sort(), JSON.stringify(doc))
  }
  // A footnote's text is a paragraph inside its definition.
  assert.deepEqual(found('note[^1] #ref\n\n[^1]: defined #defined'), [
    'ref',
    'defined',
  ])
  // Without the small text syntax, the line is a paragraph with the same tag.
  assert.deepEqual(
    render('-# small #small').marks.map((mark) => mark['data-tag']),
    ['small'],
  )
  // A long small-text line reads only the text near its visible range.
  const long = `-# ${'words #tag and **#bold** with &amp; more text '.repeat(30_000)}`
  const from = Math.floor(long.length / 2),
    to = from + 4096
  const { marks, read } = render(long, {
    syntax: contributed,
    ranges: [{ from, to }],
  })
  assert.ok(marks.length > 100, `${marks.length} tags`)
  assert.ok(read < 2 * (to - from), `${read} characters read`)
})

test('code, HTML, comments, link definitions, frontmatter, alert titles, block math and rules hold no tags', () => {
  const doc = [
    '```\n#fenced\n```',
    '    #indented',
    '<div>\n#html\n</div>',
    '<!-- #comment -->',
    '<?pi #pi ?>',
    '[ref]: /url "#linkref"',
    '$$\n#math\n$$',
    '> [!NOTE] Title #title\n> body #body',
    'after #after',
  ].join('\n\n')
  assert.deepEqual(found(doc), ['body', 'after'])
  // The rich view shows alert titles and formulas apart from the text, and
  // so does the formatted view; the workspace index reads them as text.
  assert.deepEqual(noteTags(doc), ['after', 'body', 'math', 'title'])
  const prefix = '---\ntags: #front\n---\n'
  assert.deepEqual(found(`${prefix}\nbody #body`, { prefix: prefix.length }), [
    'body',
  ])
  // A rule has no text, so a long one in view reads none.
  const rule = render('-'.repeat(100_000), {
    ranges: [{ from: 50_000, to: 50_064 }],
  })
  assert.deepEqual(rule.marks, [])
  assert.equal(rule.read, 0)
})

test('contributed node views apply by node name or Lezer group, once each', () => {
  const leaf = { nodes: ['LeafBlock'] },
    both = { nodes: ['Paragraph', 'LeafBlock'] },
    named = { nodes: ['Emphasis'] }
  const state = EditorState.create({
    extensions: [leaf, both, named].map((entry) => formattedViews.of(entry)),
  })
  const views = formattedNodeViews(state)
  const type = (name) =>
    contributed.nodeSet.types.find((entry) => entry.name === name)
  // Views naming the node come first.
  assert.deepEqual(views(type('Paragraph')), {
    views: [both, leaf],
    grouped: [leaf],
  })
  for (const name of ['FencedCode', 'Subtext', 'FutureBlock'])
    assert.deepEqual(
      views(type(name)),
      { views: [leaf, both], grouped: [leaf, both] },
      name,
    )
  assert.deepEqual(views(type('Emphasis')), { views: [named], grouped: [] })
  assert.deepEqual(views(type('Blockquote')), { views: [], grouped: [] })
  // Each type resolves once per set of views.
  assert.equal(
    formattedNodeViews(state)(type('Paragraph')),
    views(type('Paragraph')),
  )
})

test('small text holds its tags through a group view whichever contribution registers first', () => {
  // Small text beside a list bullet marks its text, which may be only a tag.
  // The formatted view draws group views' marks from a source of higher
  // precedence, so the tag sits inside the small text.
  const subtext = contributed.nodeSet.types.find(
    (type) => type.name === 'Subtext',
  )
  for (const order of [
    [...extras.subtext.views, view],
    [view, ...extras.subtext.views],
  ])
    assert.deepEqual(
      formattedNodeViews(
        EditorState.create({
          extensions: order.map((entry) => formattedViews.of(entry)),
        }),
      )(subtext),
      { views: [...extras.subtext.views, view], grouped: [view] },
      order.map((entry) => entry.nodes.join()).join(' then '),
    )
})

test('the formatted view shows reference links and entities as written, so their tags follow the text', () => {
  // A reference link with a definition is a link in the rich view and the
  // index; the formatted view shows reference links as written for now.
  assert.deepEqual(tags('[#x]: https://example.com\n\n[#x] more'), ['x'])
  assert.deepEqual(noteTags('[#x]: https://example.com\n\n[#x] more'), [])
  // Lezer reads a bracket in link text as a reference link that ends the
  // outer one, so the formatted view shows all of it as written.
  assert.deepEqual(tags('[x [#nested] y](u)'), ['nested'])
  assert.deepEqual(noteTags('[x [#nested] y](u)'), [])
  // Marked decodes numeric references in text; the formatted view shows
  // entities as written.
  assert.deepEqual(tags('&#35;h &nbsp;#n'), [])
  assert.deepEqual(noteTags('&#35;h &nbsp;#n'), ['h'])
})

test('tags mark their source with the rich view attributes', () => {
  const doc = 'see #work/project and **#ideas**'
  assert.deepEqual(render(doc).marks, [
    {
      from: 4,
      to: 17,
      class: 'hibi-tag',
      'data-tag': 'work/project',
      'data-tooltip': 'Shift-click to browse #work/project',
    },
    {
      from: 24,
      to: 30,
      class: 'hibi-tag',
      'data-tag': 'ideas',
      'data-tooltip': 'Shift-click to browse #ideas',
    },
  ])
  assert.equal(render('#ÜBER').marks[0]['data-tag'], 'über')
})

test('syntax that is off shows as written and holds no tags', () => {
  const doc = '**#bold** #plain\n\n## #heading'
  assert.deepEqual(tags(doc), ['bold', 'heading', 'plain'])
  assert.deepEqual(tags(doc, { off: ['StrongEmphasis'] }), ['heading', 'plain'])
  assert.deepEqual(tags(doc, { off: ['ATXHeading2'] }), ['bold', 'plain'])
})

test('entity siblings outside the viewport do not add traversal work', (t) => {
  for (const count of [2000, 8000, 32000]) {
    const doc = 'prefix #visible ' + '&amp; '.repeat(count) + ' end'
    const result = render(doc, { ranges: [{ from: 0, to: 32 }] })
    assert.deepEqual(
      result.marks.map((mark) => mark['data-tag']),
      ['visible'],
    )
    assert.ok(
      result.visits < 64,
      `${count} entities: ${result.visits} node visits`,
    )
    const link = render(
      '[label ' + '&amp; '.repeat(count) + '](target) #after',
      { ranges: [{ from: 0, to: 32 }] },
    )
    assert.deepEqual(link.marks, [])
    assert.ok(
      link.visits < 64,
      `${count} linked entities: ${link.visits} node visits`,
    )
    t.diagnostic(
      JSON.stringify({ count, visits: result.visits, linkVisits: link.visits }),
    )
  }
})

test('long tag names do not materialize beyond the viewport on the input path', (t) => {
  for (const count of [2000, 8000, 32000]) {
    const doc = 'prefix #' + 'a'.repeat(count) + ' suffix'
    const from = Math.floor(doc.length / 2)
    const result = render(doc, { ranges: [{ from, to: from + 32 }] })
    assert.ok(result.read < 1200, `${count} name units: ${result.read} read`)
    t.diagnostic(JSON.stringify({ count, inputRead: result.read }))
  }
})

test('viewport endpoints inside astral letters retain the whole tag identity', () => {
  for (const doc of ['#𐐀abc', '#abc𐐀def']) {
    const whole = render(doc).marks
    for (let from = 0; from < doc.length; from++) {
      const to = from + 1
      const expected = whole.flatMap((mark) => {
        const left = Math.max(from, mark.from),
          right = Math.min(to, mark.to)
        return right > left ? [{ ...mark, from: left, to: right }] : []
      })
      assert.deepEqual(
        render(doc, { ranges: [{ from, to }] }).marks,
        expected,
        `${doc}: ${from}`,
      )
    }
  }
})

test('static table cells inherit disabled inline syntax', (t) => {
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
  for (const disabled of [false, true]) {
    const state = EditorState.create({
      extensions: [
        formattedViews.of(view),
        disabled ? formattedLiteral.of('StrongEmphasis') : [],
      ],
    })
    const into = new Element()
    renderInline({ state }, '**#hidden** #plain', into)
    const found = []
    const collect = (node) => {
      if (node.attributes?.['data-tag']) found.push(node.attributes['data-tag'])
      for (const child of node.children ?? []) collect(child)
    }
    collect(into)
    assert.deepEqual(found, disabled ? ['plain'] : ['hidden', 'plain'])
  }
})

/** Small deterministic generator, so failures reproduce. */
function random(seed) {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
}

test('any split into visible ranges marks each visible tag once, as one range does', () => {
  const pieces = [
    '#tag',
    '#long/nested-tag_name',
    'word',
    ' ',
    ' ',
    '\n',
    '\n\n',
    '**#bold**',
    '`#code`',
    '[#link](u)',
    '#日本語',
    '(#paren)',
    'x#no',
    '- ',
    '> ',
  ]
  for (let seed = 1; seed <= 200; seed++) {
    const next = random(seed)
    let doc = ''
    while (doc.length < 300) doc += pieces[Math.floor(next() * pieces.length)]
    const whole = render(doc).marks
    // Visible ranges with hidden gaps between them, like replaced line breaks and line gaps.
    const ranges = []
    let at = 0
    while (at < doc.length) {
      const to = Math.min(doc.length, at + 1 + Math.floor(next() * 40))
      ranges.push({ from: at, to })
      at = to + Math.floor(next() * 3)
    }
    const split = render(doc, { ranges }).marks
    const expected = ranges.flatMap((range) =>
      whole.flatMap((mark) => {
        const from = Math.max(mark.from, range.from),
          to = Math.min(mark.to, range.to)
        return to > from ? [{ ...mark, from, to }] : []
      }),
    )
    const order = (a, b) => a.from - b.from
    assert.deepEqual(
      split.sort(order),
      expected.sort(order),
      `seed ${seed}: ${JSON.stringify(doc)}`,
    )
  }
})

test('a long paragraph reads only the text near its visible range', () => {
  // 30,000 tags and emphasis in one paragraph: one node the visible range cuts.
  const unit = 'words #tag and **#bold** with &amp; more text '
  const doc = unit.repeat(30_000)
  const from = Math.floor(doc.length / 2),
    to = from + 4096
  const { marks, read } = render(doc, { ranges: [{ from, to }] })
  assert.ok(doc.length > 1_000_000)
  assert.ok(marks.length > 100, `${marks.length}`)
  assert.ok(
    marks.every((mark) => mark.from >= from && mark.to <= to),
    'marks stay in the visible range',
  )
  // The visible text, the characters before and after each text run that
  // decide its tags, and the link brackets checked: never the paragraph.
  assert.ok(read < 2 * (to - from), `${read} characters read`)
  // A tag cut by the start of the range is found from its #.
  const cut = doc.indexOf('#tag', from) + 2
  const tail = render(doc, { ranges: [{ from: cut, to: cut + 10 }] }).marks
  assert.equal(tail[0].from, cut)
  assert.equal(tail[0]['data-tag'], 'tag')
})
