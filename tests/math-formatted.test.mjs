import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { TreeFragment } from '@lezer/common'
import { GFM, parser } from '@lezer/markdown'
import { Marked } from 'marked'
import {
  blockMathSyntax,
  inlineMathEnd,
  inlineMathSyntax,
  inlineMathWork,
} from '../src/addons/math/formatted-syntax.ts'
import { containerPrefix, mathInsertion } from '../src/addons/math/insert.ts'
import { inlineMath, mathTokens } from '../src/addons/math/syntax.ts'
import { ChunkedMarkdownParser } from '../src/renderer/src/chunked-markdown.ts'
import { outlineMathParser } from '../src/renderer/src/source-outline-math.ts'

const formatted = parser.configure([GFM, inlineMathSyntax, blockMathSyntax])
const marked = new Marked(mathTokens)

/** Math in document order, as the formatted view's syntax tree has it. */
function lezerMath(source) {
  const tree = formatted.parse(source)
  const found = []
  tree.iterate({
    enter(node) {
      if (node.name === 'InlineMath') {
        found.push(['inline', source.slice(node.from + 1, node.to - 1)])
        return false
      }
      if (node.name === 'BlockMath') {
        const text = node.node
          .getChildren('MathText')
          .map((part) => source.slice(part.from, part.to))
          .join('')
        const marks = node.node.getChildren('MathMark')
        assert.equal(
          marks.length,
          2,
          `closed block in ${JSON.stringify(source)}`,
        )
        found.push(['block', text.trim()])
        return false
      }
    },
  })
  return found
}

/** Math in document order, as the rich view's Marked tokenizers find it. */
function markedMath(source) {
  const found = []
  marked.walkTokens(marked.lexer(source), (token) => {
    if (token.type === 'inlineMath') found.push(['inline', token.latex])
    if (token.type === 'blockMath') found.push(['block', token.latex])
  })
  return found
}

const blockFixtures = [
  '$$x$$',
  'text $$x$$',
  'text $$x$$ more',
  'x$$x$$',
  'text $$x$$\nmore',
  '$$x$$ more',
  'text\n$$x$$ more',
  'text\n   $$x$$ more',
  'text\n$$x$$ more\n$$y$$',
  'text\n$$x$$',
  '$$\nx\n$$',
  ' $$x$$',
  '  $$x$$',
  '   $$x$$',
  'text\n   $$x$$',
  '   $$\nx\n   $$',
  '    $$x$$',
  '\t$$x$$',
  'text\n    $$x$$',
  '- item\n\n  $$x$$',
  '- text\n  $$x$$',
  '- text $$x$$',
  '- text $$x$$ more',
  '- item\n\n  $$\n  x\n  $$',
  '> $$x$$',
  '> text\n> $$x$$',
  '> $$\n> x\n> $$',
  '> text $$x$$',
  '> text $$x$$ more',
  '$5 and $$10',
  '\\$$',
  '\\$$x$$',
  'text \\$$x$$ more',
  '`$$x$$`',
  '```tex\n$$x$$\n```',
]

const fixtures = [
  ...blockFixtures,
  // Display blocks: bodies across lines, escapes, blank lines, limits.
  '$$\na\n\nb\n$$',
  '$$\n# inside math\n$$\n\n# real',
  '$$\nx\n- y\n+ z\n$$',
  '$$x\ny$$',
  '$$x\ny$$ tail',
  '$$\\$$x$$',
  '$$x\\$$',
  '$$x\\\\$$',
  '$$\n$$',
  '$$$$',
  '$$ $$',
  '$$\n\n$$',
  '$$\nx\n$$  \nafter',
  '$$\nunclosed',
  '$$\nunclosed\n\n# heading\n\nmore',
  `$$\n${'x'.repeat(10_000)}\n$$`,
  `$$\n${'x'.repeat(9_998)}\n$$`,
  `$$${'x'.repeat(10_000)}$$`,
  `$$${'x'.repeat(10_001)}$$`,
  'para\n$$\nx\n$$\nafter',
  'para\n$$\nx\n$$ tail\nafter',
  '1. $$\n   x\n   $$',
  '- a\n  - $$\n    x\n    $$',
  '> - $$\n>   x\n>   $$',
  '- > $$\n  > x\n  > $$',
  '> > $$\n> > x\n> > $$',
  '> $$\n> x\n\n> $$',
  '- $$\n  x\n- $$',
  // Inline math: escapes, code spans, currency, adjacency, backslashes.
  '$x$',
  'a $x$ b $y$ c',
  '$a$$b$',
  '$x$$',
  '$$x$',
  '$x$ $y$',
  '$x$,$y$',
  '\\$x$',
  '$x\\$',
  '$a\\$x$',
  '$a\\$',
  '$a\\\\$',
  '$\\$$',
  '$ x$',
  '$x $',
  '$5 and $10',
  '$5 and $$10',
  '$x$ and \\$x$',
  '\\$x$ and $x$',
  '$x$\\$',
  '\\$$x$',
  '\\$5 or \\$y$ total',
  '\\$$$x$',
  'a \\$5 then \\$x$ more',
  '$x$ and $5 and $10',
  '$x+y$ and $$z$$',
  '`$x$`',
  '`$x$` and \\$x$',
  '`a$` $b$',
  '$a`b$ `c`',
  '| \\$x$ | `$y$` |\n| --- | --- |\n| $z$ | $5 and $10 |',
  '# $x$ heading',
  '- $x$ item',
  '> $x$ quote',
  '**$x$**',
  '[$x$](https://example.com/)',
  '[link](https://example.com/$y$)',
  '<https://example.com/$x$>',
  'line one $x\nline two$',
  `$${'x'.repeat(10_000)}$`,
  `$${'x'.repeat(10_001)}$`,
]

test('formatted math matches the rich view tokenizers on the math fixtures', () => {
  for (const fixture of fixtures)
    for (const eol of ['\n', '\r\n'])
      for (const ending of ['', '\n']) {
        const raw = (fixture + ending).replaceAll('\n', eol)
        // CodeMirror documents use LF; Marked normalizes CRLF itself.
        const normalized = raw.replaceAll('\r\n', '\n')
        assert.deepEqual(
          lezerMath(normalized),
          markedMath(raw),
          JSON.stringify(raw),
        )
      }
})

test('formatted display math matches the source outline on top-level math', () => {
  const outline = (source) =>
    parser
      .configure([
        GFM,
        outlineMathParser(
          (from, to) => source.slice(from, to),
          () => source.length,
        ),
      ])
      .parse(source)
  for (const fixture of fixtures) {
    // The outline reads containers as unavailable and `$$` only at a line start.
    if (/^[ \t]*(?:[->]|\d\.)|^[ \t]+\$\$/m.test(fixture)) continue
    const source = `${fixture}\n\n# after`
    const a = [],
      b = []
    let tree
    try {
      tree = outline(source)
    } catch {
      continue
    }
    tree.iterate({
      enter(node) {
        if (node.name === 'HibiMathBlock') a.push(node.from)
        if (/Heading/.test(node.name)) a.push(`h${node.from}`)
      },
    })
    formatted.parse(source).iterate({
      enter(node) {
        if (node.name === 'BlockMath') b.push(node.from)
        if (/Heading/.test(node.name)) b.push(`h${node.from}`)
      },
    })
    assert.deepEqual(b, a, JSON.stringify(source))
  }
})

test('inline math ends where the tokenizer expression ends, in linear time', {
  timeout: 60_000,
}, () => {
  const alphabet = ['$', '\\', 'a', ' ', '\n', '\r', '$$']
  let seed = 7
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  for (let run = 0; run < 20_000; run++) {
    let text = '$'
    const length = 1 + Math.floor(random() * 14)
    for (let i = 0; i < length; i++)
      text += alphabet[Math.floor(random() * alphabet.length)]
    assert.equal(
      inlineMathEnd(text, 0),
      inlineMath(text)?.raw.length ?? -1,
      JSON.stringify(text),
    )
  }
  // The expression backtracks exponentially over an unclosed backslash run
  // (its time doubles every two backslashes); the scan solves each position once.
  assert.equal(inlineMathEnd(`$${'\\'.repeat(200_000)}x`, 0), -1)
  for (const count of [5_000, 5_001]) {
    const closed = `$${'\\'.repeat(count)}x$`
    assert.equal(inlineMathEnd(closed, 0), inlineMath(closed).raw.length)
  }
})

test('many short formulas on one line cost work linear in its length', () => {
  const work = []
  for (const count of [1000, 2000, 4000, 8000]) {
    // `$x\\$` closes right away and the next `\\` is an escape, so every
    // other `$` opens a formula; scanning to the line end per opener was quadratic.
    const line = `${'$x\\\\'.repeat(count)}$`
    inlineMathWork.positions = 0
    let formulas = 0
    formatted.parse(line).iterate({
      enter(node) {
        if (node.name === 'InlineMath') formulas++
      },
    })
    assert.equal(formulas, count / 2)
    work.push(inlineMathWork.positions / line.length)
  }
  for (const perUnit of work) assert.ok(perUnit <= 1, JSON.stringify(work))
})

test('inserted display math stays in the quote or list item around the caret', () => {
  for (const [doc, caret, containers] of [
    ['before after', 'before', []],
    ['> before after', '> before', ['Blockquote']],
    ['- before after', '- before', ['BulletList', 'ListItem']],
    ['1. before after', '1. before', ['OrderedList', 'ListItem']],
    [
      '> - before after',
      '> - before',
      ['Blockquote', 'BulletList', 'ListItem'],
    ],
    [
      '- > before after',
      '- > before',
      ['BulletList', 'ListItem', 'Blockquote'],
    ],
    // Lazy continuation lines lack the markers but stay in the container.
    ['> intro\nbefore after', '> intro\nbefore', ['Blockquote']],
    ['- intro\nbefore after', '- intro\nbefore', ['BulletList', 'ListItem']],
    [
      '> - intro\nbefore after',
      '> - intro\nbefore',
      ['Blockquote', 'BulletList', 'ListItem'],
    ],
    [
      '- first\n\n  second\nbefore after',
      '- first\n\n  second\nbefore',
      ['BulletList', 'ListItem'],
    ],
  ]) {
    const at = caret.length
    const state = EditorState.create({ doc })
    const prefix = containerPrefix(state.doc, formatted.parse(doc), at)
    const source =
      doc.slice(0, at) + mathInsertion(prefix, 'x^2', true) + doc.slice(at)
    // The formula and the text after it keep the containers around the caret.
    const tree = formatted.parse(source)
    const around = (pos) => {
      const names = []
      for (let node = tree.resolve(pos, 1); node; node = node.parent)
        if (node.type.is('Block') && node.name !== 'Paragraph')
          names.unshift(node.name)
      return names.filter((name) => name !== 'Document')
    }
    const formula = source.indexOf('$$')
    assert.deepEqual(around(formula), [...containers, 'BlockMath'], source)
    assert.deepEqual(around(source.indexOf('after')), containers, source)
    assert.deepEqual(markedMath(source), [['block', 'x^2']], source)
  }
  assert.equal(mathInsertion('> ', 'y', false), '$y$')
})

test('a display block decides by its closing line and keeps quote markers inside it', () => {
  const source = '> $$\n> a\n>\n> b\n> $$\n\nafter'
  const tree = formatted.parse(source)
  const block = []
  tree.iterate({
    enter(node) {
      if (node.name === 'BlockMath') {
        block.push(source.slice(node.from, node.to))
        for (let child = node.node.firstChild; child; child = child.nextSibling)
          block.push(`${child.name}:${source.slice(child.from, child.to)}`)
      }
    },
  })
  assert.deepEqual(block, [
    '$$\n> a\n>\n> b\n> $$',
    'MathMark:$$',
    'QuoteMark:>',
    'MathText:a\n',
    'QuoteMark:>',
    'MathText:\n',
    'QuoteMark:>',
    'MathText:b\n',
    'QuoteMark:>',
    'MathMark:$$',
  ])
})

test('chunked parses with math match whole-document trees', () => {
  const snippets = [
    '$$\nx^2\n$$',
    '$$x$$',
    'text $y$ and $$z$$ end',
    'para\n$$\na\n\nb\n$$',
    '$$\nunclosed',
    '> $$\n> q\n> $$',
    '- $$\n  w\n  $$',
    '# heading $h$',
    'plain words here',
    '```\n$$\ncode\n$$\n```',
    '\\$$no$$',
    '$5 and $10',
    '- item\n- item two',
    '> quote',
    '---',
  ]
  const nodes = (tree) => {
    const out = []
    tree.iterate({
      enter: (node) => {
        out.push(`${node.name}:${node.from}-${node.to}`)
      },
    })
    return out
  }
  let seed = 3
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  for (let run = 0; run < 300; run++) {
    let text = ''
    for (let i = 0; i < 20; i++)
      text +=
        (i ? (random() < 0.2 ? '\n' : '\n\n') : '') +
        snippets[Math.floor(random() * snippets.length)]
    // Tiny chunks put scan windows and chunk ends inside display blocks.
    const chunked = new ChunkedMarkdownParser(formatted, formatted, {
      chunkSize: 16,
      groupSize: 3,
    })
    assert.deepEqual(
      nodes(chunked.parse(text)),
      nodes(formatted.parse(text)),
      JSON.stringify(text),
    )
  }
})

test('random notes of quotes, lists and math agree with the rich view tokenizers', () => {
  // Lines keep their container's prefix: lazy continuation lines are where
  // Marked and CommonMark containers differ, not math.
  const containers = [
    ['', ''],
    ['> ', '> '],
    ['- ', '  '],
    ['1. ', '   '],
    ['> > ', '> > '],
    ['- > ', '  > '],
    ['> - ', '>   '],
  ]
  const bodies = [
    '$$',
    '$$x$$',
    'x',
    '$x$',
    'a $b$ c',
    '\\$y$',
    '$$ ',
    'z$$',
    '```',
    '$5 and $10',
    '$a$$b$',
    'q \\\\$r$',
    '$$\\$$',
    '`$c$`',
    '',
  ]
  let seed = 5
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const pick = (list) => list[Math.floor(random() * list.length)]
  for (let run = 0; run < 5000; run++) {
    const blocks = []
    for (let count = 1 + Math.floor(random() * 3); count > 0; count--) {
      const [first, rest] = pick(containers)
      const lines = []
      for (let i = 1 + Math.floor(random() * 5); i > 0; i--)
        lines.push(
          (lines.length ? rest : first) +
            (pick(bodies) || (lines.length ? '' : 'x')),
        )
      blocks.push(lines.join('\n'))
    }
    const source = blocks.join('\n\n')
    assert.deepEqual(
      lezerMath(source),
      markedMath(source),
      JSON.stringify(source),
    )
  }
})

test('display math decided by a distant closing follows edits to it incrementally', () => {
  const blocks = (tree) => {
    const found = []
    tree.iterate({
      enter(node) {
        if (node.name === 'BlockMath') found.push([node.from, node.to])
      },
    })
    return found
  }
  const edit = (tree, text, from, to, insert) => {
    const next = text.slice(0, from) + insert + text.slice(to)
    const fragments = TreeFragment.applyChanges(TreeFragment.addTree(tree), [
      { fromA: from, toA: to, fromB: from, toB: from + insert.length },
    ])
    return {
      text: next,
      tree: new ChunkedMarkdownParser(formatted, formatted).parse(
        next,
        fragments,
      ),
    }
  }
  // The opener is three chunks above the edit that closes it.
  const open = `$$\nx\n\n${'padding\n\n'.repeat(600)}`
  let tree = new ChunkedMarkdownParser(formatted, formatted).parse(open)
  assert.deepEqual(blocks(tree), [])
  const closed = edit(tree, open, open.length, open.length, '$$')
  assert.deepEqual(blocks(closed.tree), [[0, closed.text.length]])
  assert.deepEqual(blocks(closed.tree), blocks(formatted.parse(closed.text)))
  // Breaking the closing line makes the opener text again.
  const reopened = edit(
    closed.tree,
    closed.text,
    closed.text.length,
    closed.text.length,
    ' tail',
  )
  assert.deepEqual(blocks(reopened.tree), [])
  // Random edits keep chunked trees equal to whole-document trees.
  const snippets = [
    '$$\nx^2\n$$',
    '$$x$$',
    'text $y$ and $$z$$ end',
    'para\n$$\na\n\nb\n$$',
    '$$\nunclosed',
    '> $$\n> q\n> $$',
    '- $$\n  w\n  $$',
    '# heading $h$',
    'plain words here',
    '\\$$no$$',
    '- item\n- item two',
  ]
  const inserts = ['$', '$$', '\n', '\n\n', 'x', '\\', '$$\n', '> ', '- ']
  const nodes = (tree) => {
    const out = []
    tree.iterate({
      enter: (node) => {
        out.push(`${node.name}:${node.from}-${node.to}`)
      },
    })
    return out
  }
  let seed = 17
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const pick = (list) => list[Math.floor(random() * list.length)]
  for (let run = 0; run < 150; run++) {
    let text = ''
    for (let i = 0; i < 24; i++)
      text += (i ? (random() < 0.2 ? '\n' : '\n\n') : '') + pick(snippets)
    const tiny = () =>
      new ChunkedMarkdownParser(formatted, formatted, {
        chunkSize: 16,
        groupSize: 3,
      })
    tree = tiny().parse(text)
    for (let step = 0; step < 6; step++) {
      const from = Math.floor(random() * (text.length + 1))
      const to = Math.min(
        text.length,
        from + (random() < 0.4 ? Math.floor(random() * 12) : 0),
      )
      const insert = random() < 0.2 ? '' : pick(inserts)
      const next = text.slice(0, from) + insert + text.slice(to)
      tree = tiny().parse(
        next,
        TreeFragment.applyChanges(TreeFragment.addTree(tree), [
          { fromA: from, toA: to, fromB: from, toB: from + insert.length },
        ]),
      )
      text = next
      assert.deepEqual(
        nodes(tree),
        nodes(formatted.parse(text)),
        JSON.stringify({ run, step, insert, from, to }),
      )
    }
  }
})
