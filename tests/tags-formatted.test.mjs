import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { GFM, parser } from '@lezer/markdown'
import { formattedTags } from '../src/addons/tags/formatted.ts'
import { formattedLiteral } from '../src/renderer/src/formatted-contributions.ts'
import { noteTags } from '../src/shared/note-tags.ts'

const markdown = parser.configure(GFM)
// Table cells render their text with inline syntax only, as table-cells.ts does.
const cells = markdown.configure({ remove: [...markdown.blockNames] })
const [view] = formattedTags(() => {}).views

/**
 * Tag marks the formatted view's renderer gives a note, visiting nodes in
 * the visible ranges as the live preview does: syntax that is off is not
 * entered, and each range gets its own pass.
 */
function render(
  doc,
  { ranges = [{ from: 0, to: doc.length }], off = [] } = {},
) {
  const state = EditorState.create({
    doc,
    extensions: off.map((name) => formattedLiteral.of(name)),
  })
  let read = 0
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
  const tree = markdown.parse(doc)
  for (const visible of ranges)
    tree.iterate({
      from: visible.from,
      to: visible.to,
      enter(node) {
        if (off.includes(node.name)) return false
        if (node.name === 'TableCell') {
          const text = doc.slice(node.from, node.to)
          const cell = EditorState.create({ doc: text })
          cells.parse(text).iterate({
            enter(inner) {
              if (view.nodes.includes(inner.name))
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
        if (view.nodes.includes(node.name))
          view.decorate(node, out, { state, visible, revealed: false })
      },
    })
  return { marks, read }
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
