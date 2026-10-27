import assert from 'node:assert/strict'
import test from 'node:test'
import { history, undo } from '@codemirror/commands'
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
import { contribution as entities } from '../src/renderer/src/formatted/entities.ts'
import { renderInline } from '../src/renderer/src/formatted/table-cells.ts'
import { blockBreak } from '../src/renderer/src/formatted-commands.ts'
import {
  contributionExtension,
  formattedTree,
} from '../src/renderer/src/formatted-contributions.ts'

const lezer = parser.configure([GFM, subscriptSyntax, subtextSyntax])
const marked = new Marked({ gfm: true }, textExtrasMarkdown)

/** Subscripts, small-text lines and code spans in document order, as the formatted view's tree has them. */
function formattedItems(source) {
  // CodeMirror and Marked normalize line endings before parsing Markdown.
  source = source.replace(/\r\n?/g, '\n')
  const found = []
  const code = []
  lezer.parse(source).iterate({
    enter(node) {
      if (node.name === 'Subscript')
        found.push(['sub', source.slice(node.from + 1, node.to - 1)])
      if (node.name === 'Subtext')
        found.push(['subtext', source.slice(node.from + 3, node.to)])
      if (node.name === 'InlineCode')
        code.push(source.slice(node.from, node.to))
    },
  })
  return { found, code }
}

/** The same as the rich view's tokenizers read them, and whether they strike through text between single tildes. */
function richItems(source) {
  const found = []
  const code = []
  let single = false
  marked.walkTokens(marked.lexer(source), (token) => {
    if (token.type === 'subscript') found.push(['sub', token.text])
    if (token.type === 'subtext') found.push(['subtext', token.text])
    if (token.type === 'codespan') code.push(token.raw)
    if (token.type === 'del' && !token.raw.startsWith('~~')) single = true
  })
  return { found, code, single }
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
  // The rich view's strikethrough doesn't close at tildes in code spans or
  // escaped ones, and counts `~~` that open after it.
  '~~a~ `~~`',
  '~~a~ ``~~`` b',
  '~~a~ `~~',
  '~~a~ \\~~b',
  '~~a~ \\\\~~',
  '~~a~ ~~b~~',
  '`~~` ~a~ b~~',
  // A `~~` that closes a strikethrough opens no subscript, and a tilde right
  // before it can close one inside the strikethrough.
  '~~#~~-a~',
  '~~a ~b\\~~~',
  // Before punctuation, `~~` opens one only after a space or punctuation,
  // which an emoji isn't for the rich view.
  'a~~.b~ c~~',
  '~~.b~ c~~',
  'x.~~.a~ b~~',
  'x😀~~.a~ b~~',
  '~&amp;~',
  '-# &amp; &#169;',
  '~&#169; `&amp;`~',
  '~a\rb~',
  '~a\r\nb~',
  '  -# indented',
  '\t-# tabbed',
  '>  -# indented quote',
  '-   -# indented item',
  '- item\n   -# indented continuation',
  '-# \r\n-# x',
  '~👩‍💻~',
  '~a\u2028b~',
  '~a\u00a0b~',
]

test('subscripts and small text are read as the rich view reads them', () => {
  for (const source of fixtures)
    assert.deepEqual(
      formattedItems(source).found,
      richItems(source).found,
      JSON.stringify(source),
    )
  // Random text over the syntax's characters and the markup around it. The
  // rich view also strikes through text between single tildes, which the
  // formatted view's strikethrough doesn't, and opens a code span right after
  // an escaped backtick, which its code spans don't; text where they do is
  // skipped. Emphasis and links read text in pieces in the rich view, so the
  // alphabets leave `*`, `_` and `[` out.
  let compared = 0
  for (const [seed, alphabet] of [
    [3, '~~ ab\n-#'],
    [5, '~ a\\-#>\n'],
    [7, '~~ a`\\.'],
    [9, '~ a.,`\\b'],
    [11, '~~&;# a`\n'],
    [13, '~~ a😀`\\'],
  ]) {
    let state = seed
    const random = () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff
      return state / 0x7fffffff
    }
    const characters = [...alphabet]
    for (let run = 0; run < 5000; run++) {
      let source = ''
      for (let index = 2 + Math.floor(random() * 14); index > 0; index--)
        source += characters[Math.floor(random() * characters.length)]
      const rich = richItems(source)
      const formatted = formattedItems(source)
      if (rich.single || formatted.code.join() !== rich.code.join()) continue
      compared++
      assert.deepEqual(formatted.found, rich.found, JSON.stringify(source))
    }
  }
  assert.ok(compared > 25000, `${compared} compared`)
})

test('tildes, backticks and escapes cost each character a bounded number of reads', () => {
  // A section with a `~~` is scanned once for every strikethrough's closer,
  // in three passes that read each character and the runs in it again; a
  // subscript's scan ends at the next tilde. Without the scan's cache, `~~a `
  // costs millions of reads.
  for (const unit of [
    '~a ',
    ' ~~a',
    'a~~b ',
    '~a~~ ',
    '~a b~~c ',
    '~~a `',
    '\\~~a ',
    '~~a~ ~~b~~ ',
    '~~a~ `~~` ',
    '~~.~ ',
  ]) {
    const reads = []
    for (const count of [2500, 5000]) {
      const source = unit.repeat(count)
      subscriptWork.reads = 0
      lezer.parse(source)
      reads.push(subscriptWork.reads)
      assert.ok(
        subscriptWork.reads <= 5 * source.length,
        `${subscriptWork.reads} reads for ${source.length} characters of ${JSON.stringify(unit)}`,
      )
    }
    assert.ok(reads[1] <= 2.1 * reads[0], JSON.stringify([unit, reads]))
  }
})

/** What a contribution's views draw for `source`, with the selection at `caret` if revealed. */
function drawn(contribution, source, caret, wrap = (node) => node) {
  const state = EditorState.create({
    doc: source,
    selection: { anchor: caret ?? 0 },
  })
  const calls = []
  const out = {
    mark: (from, to, attributes) => calls.push(['mark', from, to, attributes]),
    syntax: (from, to) => calls.push(['syntax', from, to]),
    line: (at, attributes) => calls.push(['line', at, attributes]),
    replace: (from, to, widget) =>
      calls.push(['replace', from, to, widget.text, widget.attributes]),
    widget() {},
  }
  lezer.parse(source).iterate({
    enter(node) {
      const view = contribution.views.find((view) =>
        view.nodes.includes(node.name),
      )
      if (!view) return
      return view.decorate({ ...node, node: wrap(node.node) }, out, {
        state,
        revealed: caret !== undefined,
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

test('references in subscripts and small text show their characters, as in the rich view, until the caret touches them', () => {
  const { subscript, subtext } = contributions
  const sub = { class: 'hibi-lp-subscript' }
  // Before, `&amp;` showed as written in both.
  assert.deepEqual(drawn(subscript, '~&amp;~'), [
    ['syntax', 0, 1],
    ['replace', 1, 6, '&', sub],
    ['syntax', 6, 7],
  ])
  // The mark leaves each reference out; the code span keeps its text.
  assert.deepEqual(drawn(subscript, '~a&#169;b `&amp;` &nosuch;~'), [
    ['syntax', 0, 1],
    ['mark', 1, 2, sub],
    ['replace', 2, 8, '©', sub],
    ['mark', 8, 26, sub],
    ['syntax', 26, 27],
  ])
  assert.deepEqual(drawn(subtext, '-# &amp; &#169;'), [
    ['line', 0, { class: 'markdown-subtext' }],
    ['replace', 3, 8, '&', {}],
    ['replace', 9, 15, '©', {}],
    ['syntax', 0, 3],
  ])
  // Beside a list bullet the text's mark takes the class, and so do the
  // characters; the subscript inside shows its own.
  assert.deepEqual(drawn(subtext, '- -# &lt; ~&gt;~'), [
    ['replace', 5, 9, '<', { class: 'markdown-subtext' }],
    ['mark', 9, 16, { class: 'markdown-subtext' }],
    ['syntax', 2, 5],
  ])
  // Under the caret a reference shows its source; the others keep their characters.
  assert.deepEqual(drawn(subtext, '-# &amp; &#169;', 4), [
    ['line', 0, { class: 'markdown-subtext' }],
    ['replace', 9, 15, '©', {}],
    ['syntax', 0, 3],
  ])
  assert.deepEqual(drawn(subscript, '~&amp;~', 6), [
    ['syntax', 0, 1],
    ['mark', 1, 6, sub],
    ['syntax', 6, 7],
  ])
})

test('decoded glyphs keep the style of a surrounding inline link', () => {
  for (const [contribution, source, classes] of [
    [
      contributions.subscript,
      '~[&amp;](Other.md)~',
      'hibi-lp-subscript hibi-lp-link',
    ],
    [contributions.subtext, '-# [&#169;](Other.md)', 'hibi-lp-link'],
    [
      contributions.subscript,
      '~[a &amp; b](Other.md)~',
      'hibi-lp-subscript hibi-lp-link',
    ],
    [contributions.subscript, '~[&amp;]()~', 'hibi-lp-subscript hibi-lp-link'],
    [
      contributions.subscript,
      '~[&amp;](Other.md "title")~',
      'hibi-lp-subscript hibi-lp-link',
    ],
  ]) {
    const glyph = drawn(contribution, source).find(
      ([kind]) => kind === 'replace',
    )
    assert.equal(glyph[4].class, classes, source)
  }
  // Unresolved reference links stay literal, as in the core renderer.
  const glyph = drawn(contributions.subscript, '~[&amp;][missing]~').find(
    ([kind]) => kind === 'replace',
  )
  assert.equal(glyph[4].class, 'hibi-lp-subscript')
})

test('table cells keep one contextual glyph when core entities and subscripts coexist', (t) => {
  class Element {
    attributes = {}
    children = []
    classList = {
      add: (name) => {
        this.className = [this.className, name].filter(Boolean).join(' ')
      },
    }
    set className(value) {
      this.attributes.class = value
    }
    get className() {
      return this.attributes.class ?? ''
    }
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
  const state = EditorState.create({
    doc: '~[&amp;](target)~ **~&#169;~**',
    extensions: [
      contributionExtension(entities),
      contributionExtension(contributions.subscript),
    ],
  })
  const into = new Element()
  renderInline({ state }, '~[&amp;](target)~ **~&#169;~**', into)
  const glyphs = []
  const collect = (node) => {
    if (node.className?.includes('hibi-lp-entity'))
      glyphs.push([node.textContent, node.className])
    for (const child of node.children ?? []) collect(child)
  }
  collect(into)
  assert.deepEqual(glyphs, [
    ['&', 'hibi-lp-subscript hibi-lp-link hibi-lp-entity'],
    ['©', 'hibi-lp-subscript hibi-lp-entity'],
  ])
})

test('links around many subscripts do not scan their siblings for each glyph', () => {
  for (const count of [64, 128, 256]) {
    let siblings = 0
    const wrapped = new WeakMap()
    const wrap = (node) => {
      if (!node) return node
      if (wrapped.has(node)) return wrapped.get(node)
      const proxy = new Proxy(node, {
        get(target, key) {
          if (
            ['parent', 'firstChild', 'lastChild', 'nextSibling'].includes(key)
          )
            return wrap(Reflect.get(target, key, target))
          if (key === 'getChildren')
            return (...args) => target.getChildren.apply(proxy, args)
          if (key === 'cursor')
            return (...args) => {
              const cursor = target.cursor(...args)
              return new Proxy(cursor, {
                get(target, key) {
                  if (key === 'nextSibling')
                    return (...args) => {
                      siblings++
                      return target.nextSibling(...args)
                    }
                  const value = Reflect.get(target, key, target)
                  return typeof value === 'function'
                    ? value.bind(target)
                    : value
                },
              })
            }
          const value = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      wrapped.set(node, proxy)
      return proxy
    }
    const glyphs = drawn(
      contributions.subscript,
      `[${'~&amp;~ '.repeat(count)}](Other.md)`,
      undefined,
      wrap,
    ).filter(([kind]) => kind === 'replace')
    assert.equal(glyphs.length, count)
    assert.ok(glyphs.every((glyph) => glyph[4].class.includes('hibi-lp-link')))
    assert.ok(siblings === 0, `${siblings} sibling visits for ${count} glyphs`)
  }
})

/** Enter at `|` (from `^` when selecting) in a formatted view with subscripts. */
function enter(doc) {
  const anchor = doc.indexOf('^')
  const text = doc.replace('^', '')
  const head = text.indexOf('|')
  const source = text.replace('|', '')
  const state = EditorState.create({
    doc: source,
    selection: { anchor: anchor < 0 ? head : anchor, head },
    extensions: [history(), contributionExtension(contributions.subscript)],
  })
  const next = state.update(blockBreak(state, lezer.parse(source))).state
  let undone = next
  undo({
    state: next,
    dispatch: (transaction) => {
      undone = transaction.state
    },
  })
  assert.equal(undone.doc.toString(), source, `undo after ${doc}`)
  const { from, to } = next.selection.main
  assert.equal(from, to)
  return `${next.doc.sliceString(0, from)}|${next.doc.sliceString(from)}`
}

test('enter inside a subscript closes it before the break and opens it again after', () => {
  // Before, `~ab|cd~` became `~ab` and `cd~`, and both lost the subscript.
  assert.equal(enter('~ab|cd~'), '~ab~\n\n~|cd~')
  assert.equal(enter('H~2|0~O'), 'H~2~\n\n~|0~O')
  // At either end of its text the break moves outside it.
  assert.equal(enter('~|abcd~'), '\n\n|~abcd~')
  assert.equal(enter('~abcd|~'), '~abcd~\n\n|')
  // A selection inside it keeps the text around it subscript; one that ends
  // outside it closes it before the break.
  assert.equal(enter('~a^bc|d~'), '~a~\n\n~|d~')
  assert.equal(enter('~a^bcd~ x|y'), '~a~\n\n|y')
  assert.equal(enter('x^y ~ab|cd~'), 'x\n\n~|cd~')
  // In a list item the new item opens it again too.
  assert.equal(enter('- ~ab|cd~'), '- ~ab~\n- ~|cd~')
})

test('backspace joins small text as paragraphs and keeps its marker when lifting', () => {
  for (const [input, expected] of [
    ['-# |abcd', '-# |abcd'],
    ['before\n\n-# |abcd', 'before|abcd'],
    ['-# before\n\n-# |abcd', '-# before|abcd'],
    ['> -# |abcd', '-# |abcd'],
    ['- -# |abcd', '-# |abcd'],
  ]) {
    const source = input.replace('|', '')
    let state = EditorState.create({
      doc: source,
      selection: { anchor: input.indexOf('|') },
      extensions: [
        history(),
        contributionExtension(contributions.subtext),
        formattedTree.of((state) => lezer.parse(state.doc.toString())),
      ],
    })
    assert.equal(
      contributions.subtext.keys[0].run({
        get state() {
          return state
        },
        dispatch(spec) {
          state = state.update(spec).state
        },
      }),
      true,
    )
    const { head } = state.selection.main
    assert.equal(
      `${state.doc.sliceString(0, head)}|${state.doc.sliceString(head)}`,
      expected,
      input,
    )
    if (state.doc.toString() !== source) {
      undo({
        state,
        dispatch: (transaction) => {
          state = transaction.state
        },
      })
      assert.equal(state.doc.toString(), source, 'undo: ' + input)
    }
  }
})
