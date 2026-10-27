import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { GFM, parser } from '@lezer/markdown'
import { Marked } from 'marked'
import { contribution } from '../src/addons/markdown/formatted-obsidian.ts'
import {
  obsidianSyntax,
  obsidianWork,
  wikiText,
} from '../src/addons/markdown/formatted-syntax.ts'
import { obsidianMarkdown } from '../src/addons/markdown/obsidian.ts'

const lezer = parser.configure([GFM, obsidianSyntax])
const marked = new Marked({ gfm: true }, obsidianMarkdown)

/** Wikilinks, embeds and highlights in document order, as the formatted view's tree has them. */
function formattedItems(source) {
  const found = []
  lezer.parse(source).iterate({
    enter(node) {
      if (node.name === 'WikiLink' || node.name === 'WikiEmbed') {
        // The text the parse kept, which must be what the label's span shows.
        const text = (name) => {
          const part = node.node.getChild(name)
          if (!part) return undefined
          const kept = part.tree.prop(wikiText)
          assert.equal(kept, source.slice(part.from, part.to), name)
          return kept
        }
        const target = text('WikiTarget')
        found.push([
          node.name === 'WikiEmbed' ? 'embed' : 'link',
          target,
          text('WikiAlias') ?? target,
        ])
        return false
      }
      if (node.name === 'Highlight') {
        found.push(['highlight', source.slice(node.from + 2, node.to - 2)])
        return false
      }
    },
  })
  return found
}

/** The same, as the rich view's tokenizers read them. */
function richItems(source) {
  const found = []
  marked.walkTokens(marked.lexer(source), (token) => {
    if (token.type === 'obsidianWikiLink')
      found.push(['link', token.target, token.text])
    if (token.type === 'obsidianEmbed')
      found.push(['embed', token.target, token.text])
    if (token.type === 'obsidianHighlight')
      found.push(['highlight', token.text])
  })
  return found
}

const fixtures = [
  'see [[Note]] here',
  '[[Note|Alias]] and [[ spaced | label ]]',
  '[[a|b|c]]',
  '[[a|]]',
  '[[ |x]]',
  '![[img.png]]',
  '![[img.png|200]]',
  '![[note#Head|Shown]]',
  'x ![[ ]] y',
  '==mark== and == no== and ==no ==',
  '===a===',
  '**==bold mark==**',
  '==a [[b]] c==',
  '[[a]]]',
  '[[[a]]',
  '\\[[a]]',
  '`[[a]]`',
  '[x]([[y]])',
  '[[a\nb]]',
  '==a\nb==',
  '| h |\n| - |\n| [[a|b]] |',
  'a ==b== c ==d==',
  '==a==b== and ==c==',
  '[[a]][[b]]',
  '![[a]]![[b.png]]',
  'text == spaced == done',
  '[[é]] ==ü==',
  '[link [[inner]]](url)',
  '*[[a]]*',
  '<span>[[a]]</span>',
  '[[a]] [ref]\n\n[ref]: /x',
  '==a ==',
  '> quoted [[a]]\n- listed ==b==\n# heading ![[c.png]]',
]

test('wikilinks, embeds and highlights are read as the rich view reads them', () => {
  for (const source of fixtures)
    assert.deepEqual(
      formattedItems(source),
      richItems(source),
      JSON.stringify(source),
    )
  // Random text over the syntax's characters and the markup around it. Emphasis
  // that crosses a wikilink or highlight edge differs: the rich view's wins.
  for (const [seed, alphabet] of [
    [1, '[[]]==!| ab\n'],
    [7, '[[]]==!| a`\\#>-\n('],
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
      assert.deepEqual(
        formattedItems(source),
        richItems(source),
        JSON.stringify(source),
      )
    }
  }
})

test('openers without closers cost each character a bounded number of reads', () => {
  // Openers whose target is empty share one far closer; checking each must not reread the rest.
  const reads = []
  for (const count of [4000, 8000]) {
    const source = `${'[[|'.repeat(count)}]]`
    obsidianWork.reads = 0
    lezer.parse(source)
    reads.push(obsidianWork.reads)
    assert.ok(
      obsidianWork.reads <= 2 * source.length,
      `${obsidianWork.reads} reads for ${source.length} characters of empty targets`,
    )
  }
  assert.ok(reads[1] <= 2.2 * reads[0], JSON.stringify(reads))
  for (const unit of ['[[a ', '![[a ', '==a ', '==a == ', '[[a|b ==c ']) {
    const source = unit.repeat(20000)
    obsidianWork.reads = 0
    lezer.parse(source)
    assert.ok(
      obsidianWork.reads <= 2 * source.length,
      `${obsidianWork.reads} reads for ${source.length} characters of ${JSON.stringify(unit)}`,
    )
  }
})

/** What the contribution's views draw for `source`. */
function drawn(source, revealed = false) {
  const state = EditorState.create({ doc: source })
  const calls = []
  const out = {
    mark: (from, to, attributes) => calls.push(['mark', from, to, attributes]),
    link: (from, to, attributes) => calls.push(['link', from, to, attributes]),
    syntax: (from, to) => calls.push(['syntax', from, to]),
    replace: (from, to, widget) =>
      calls.push([
        'replace',
        from,
        to,
        widget.text
          ? [widget.text, widget.attributes.class]
          : { target: widget.target, label: widget.label },
      ]),
    line() {},
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
        revealed,
        visible: { from: 0, to: source.length },
      })
    },
  })
  return calls
}

test('labels read as links, brackets and aliased targets are syntax, embeds become widgets until revealed', () => {
  assert.equal(contribution.flavor, 'markdown.obsidian')
  assert.deepEqual(drawn('[[Note]]'), [
    ['syntax', 0, 2],
    ['link', 2, 6, { 'data-wiki-link': 'Note', 'data-wiki-alias': 'false' }],
    ['syntax', 6, 8],
  ])
  assert.deepEqual(drawn('[[Note|]]'), [
    ['syntax', 0, 2],
    ['link', 2, 6, { 'data-wiki-link': 'Note', 'data-wiki-alias': 'true' }],
    ['syntax', 6, 9],
  ])
  assert.deepEqual(drawn('[[Note|   ]]'), [
    ['syntax', 0, 2],
    ['link', 2, 6, { 'data-wiki-link': 'Note', 'data-wiki-alias': 'true' }],
    ['syntax', 6, 12],
  ])
  assert.deepEqual(drawn('[[Note   ]]'), [
    ['syntax', 0, 2],
    ['link', 2, 6, { 'data-wiki-link': 'Note', 'data-wiki-alias': 'false' }],
    ['syntax', 6, 11],
  ])
  assert.deepEqual(drawn('[[ Note#Part | Shown ]]'), [
    ['syntax', 0, 15],
    [
      'link',
      15,
      20,
      { 'data-wiki-link': 'Note#Part', 'data-wiki-alias': 'true' },
    ],
    ['syntax', 20, 23],
  ])
  assert.deepEqual(drawn('==mark=='), [
    ['syntax', 0, 2],
    ['mark', 2, 6, { class: 'hibi-lp-highlight' }],
    ['syntax', 6, 8],
  ])
  assert.deepEqual(drawn('![[a.png|200]]'), [
    ['replace', 0, 14, { target: 'a.png', label: '200' }],
  ])
  assert.deepEqual(drawn('![[a.png|200]]', true), [
    ['syntax', 0, 3],
    ['syntax', 12, 14],
  ])
})

test('decoded glyphs pass mouse events through to the editor', () => {
  for (const source of ['[[Note|&amp;]]', '==&#x1f600;==']) {
    const state = EditorState.create({ doc: source })
    const widgets = []
    lezer.parse(source).iterate({
      enter(node) {
        const view = contribution.views.find((entry) =>
          entry.nodes.includes(node.name),
        )
        return view?.decorate(
          node,
          {
            syntax() {},
            mark() {},
            link() {},
            replace: (_from, _to, widget) => widgets.push(widget),
          },
          { state, revealed: false, visible: { from: 0, to: source.length } },
        )
      },
    })
    assert.equal(widgets.length, 1)
    assert.equal(widgets[0].ignoreEvent(new Event('mousedown')), false, source)
    assert.equal(widgets[0].ignoreEvent(new Event('click')), false, source)
  }
})

test('entities in labels and highlights show their characters, as in the rich view, until the caret reveals them', () => {
  assert.deepEqual(drawn('[[Note|&amp;]]'), [
    ['syntax', 0, 7],
    ['link', 7, 12, { 'data-wiki-link': 'Note', 'data-wiki-alias': 'true' }],
    ['replace', 7, 12, ['&', 'hibi-lp-link']],
    ['syntax', 12, 14],
  ])
  assert.deepEqual(drawn('==&lt;tag&gt; &#x41;&nosuch;=='), [
    ['syntax', 0, 2],
    ['mark', 2, 28, { class: 'hibi-lp-highlight' }],
    ['replace', 2, 6, ['<', 'hibi-lp-highlight']],
    ['replace', 9, 13, ['>', 'hibi-lp-highlight']],
    ['replace', 14, 20, ['A', 'hibi-lp-highlight']],
    ['syntax', 28, 30],
  ])
  assert.deepEqual(drawn('==&lt;==', true), [
    ['syntax', 0, 2],
    ['mark', 2, 6, { class: 'hibi-lp-highlight' }],
    ['syntax', 6, 8],
  ])
})
