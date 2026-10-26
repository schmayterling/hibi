import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { GFM, parser } from '@lezer/markdown'
import { Marked } from 'marked'
import { contributions } from '../src/addons/text-extras/formatted.ts'
import {
  subscriptSyntax,
  subscriptWork,
  subtextSyntax,
} from '../src/addons/text-extras/formatted-syntax.ts'
import { textExtrasMarkdown } from '../src/addons/text-extras/syntax.ts'

const lezer = parser.configure([GFM, subscriptSyntax, subtextSyntax])
const marked = new Marked({ gfm: true }, textExtrasMarkdown)

/** Subscripts and small-text lines in document order, as the formatted view's tree has them. */
function formattedItems(source) {
  const found = []
  lezer.parse(source).iterate({
    enter(node) {
      if (node.name === 'Subscript')
        found.push(['sub', source.slice(node.from + 1, node.to - 1)])
      if (node.name === 'Subtext')
        found.push(['subtext', source.slice(node.from + 3, node.to)])
    },
  })
  return found
}

/** The same as the rich view's tokenizers read them, and whether they read a strikethrough. */
function richItems(source) {
  const found = []
  let strike = false
  marked.walkTokens(marked.lexer(source), (token) => {
    if (token.type === 'subscript') found.push(['sub', token.text])
    if (token.type === 'subtext') found.push(['subtext', token.text])
    if (token.type === 'del') strike = true
  })
  return { found, strike }
}

const fixtures = [
  'H~2~O',
  '~a b~ and ~ no~ and ~no ~',
  '~~strike~~',
  'x~y',
  '~a\nb~',
  '-# small text',
  'para\n-# small',
  '-# one\n-# two',
  '> -# quoted',
  '- -# listed',
  '  -# indented',
  '-#nospace',
  '-# with ~sub~ inside',
  '~**bold**~',
  '**~a~**',
  '`~a~`',
  '\\~a~',
  '~a~b~',
  'p\n\n-# s\n\np',
  '> a\n> -# b',
  '- a\n  -# b',
  '~~a~ b',
  '~~~a~',
]

test('subscripts and small text are read as the rich view reads them', () => {
  for (const source of fixtures)
    assert.deepEqual(
      formattedItems(source),
      richItems(source).found,
      JSON.stringify(source),
    )
  // Random text over the syntax's characters and the markup around it. The
  // rich view also strikes text between single tildes, which the formatted
  // view's strikethrough does not, so text where it reads one is skipped.
  for (const [seed, alphabet] of [
    [3, '~~ ab\n-#'],
    [5, '~ a\\-#>\n'],
  ]) {
    let state = seed
    const random = () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff
      return state / 0x7fffffff
    }
    for (let run = 0; run < 5000; run++) {
      let source = ''
      for (let index = 2 + Math.floor(random() * 14); index > 0; index--)
        source += alphabet[Math.floor(random() * alphabet.length)]
      const rich = richItems(source)
      if (rich.strike) continue
      assert.deepEqual(
        formattedItems(source),
        rich.found,
        JSON.stringify(source),
      )
    }
  }
})

test('tildes without closers cost each character a bounded number of reads', () => {
  for (const unit of ['~a ', ' ~~a', 'a~~b ', '~a~~ ', '~a b~~c ']) {
    const source = unit.repeat(5000)
    subscriptWork.reads = 0
    lezer.parse(source)
    assert.ok(
      subscriptWork.reads <= 3 * source.length,
      `${subscriptWork.reads} reads for ${source.length} characters of ${JSON.stringify(unit)}`,
    )
  }
})

/** What a contribution's views draw for `source`. */
function drawn(contribution, source) {
  const state = EditorState.create({ doc: source })
  const calls = []
  const out = {
    mark: (from, to, attributes) => calls.push(['mark', from, to, attributes]),
    syntax: (from, to) => calls.push(['syntax', from, to]),
    line: (at, attributes) => calls.push(['line', at, attributes]),
    replace() {},
    widget() {},
  }
  lezer.parse(source).iterate({
    enter(node) {
      const view = contribution.views.find((view) =>
        view.nodes.includes(node.name),
      )
      if (!view) return
      return view.decorate(node, out, {
        state,
        revealed: false,
        visible: { from: 0, to: source.length },
      })
    },
  })
  return calls
}

test("subscripts mark their text and small-text lines take the rich view's class, with their markers as syntax", () => {
  const { subscript, subtext } = contributions
  assert.deepEqual(
    [subscript.feature, subscript.flavor, subtext.feature, subtext.flavor],
    [
      'text-extras.subscript',
      'text-extras.text-extras',
      'text-extras.subtext',
      'text-extras.text-extras',
    ],
  )
  assert.deepEqual(drawn(subscript, 'H~2~O'), [
    ['syntax', 1, 2],
    ['mark', 2, 3, { class: 'hibi-lp-subscript' }],
    ['syntax', 3, 4],
  ])
  assert.deepEqual(drawn(subtext, 'para\n-# small'), [
    ['line', 5, { class: 'markdown-subtext' }],
    ['syntax', 5, 8],
  ])
  // In a quote, the line keeps its quote marker; the class goes on the whole line.
  assert.deepEqual(drawn(subtext, '> -# quoted'), [
    ['line', 0, { class: 'markdown-subtext' }],
    ['syntax', 2, 5],
  ])
})
