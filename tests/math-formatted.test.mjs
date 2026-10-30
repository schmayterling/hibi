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
  precedenceWork,
} from '../src/addons/math/formatted-syntax.ts'
import {
  inlineDisplayMath,
  inlineMathWork,
} from '../src/addons/math/inline-display.ts'
import { containerPrefix, mathInsertion } from '../src/addons/math/insert.ts'
import { inlineMath, mathTokens } from '../src/addons/math/syntax.ts'
import { ChunkedMarkdownParser } from '../src/renderer/src/chunked-markdown.ts'
import { SourceOutlineModel } from '../src/renderer/src/source-outline.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'

const formatted = parser.configure([GFM, inlineMathSyntax, blockMathSyntax])
const marked = new Marked(mathTokens)

/** Display formulas compare apart from the spaces around their line breaks. */
const lines = (latex) => latex.replace(/[ \t]*\n[ \t]*/g, '\n')

/** Math in document order, as the formatted view's syntax tree has it. */
function lezerMath(source) {
  const tree = formatted.parse(source)
  const found = []
  tree.iterate({
    enter(node) {
      if (node.name === 'InlineMath' || node.name === 'InlineMathLines') {
        const mark = node.node.firstChild.to - node.from
        // Later lines' quote markers are no part of the formula.
        let latex = '',
          at = node.from + mark
        for (let child = node.node.firstChild; child; child = child.nextSibling)
          if (child.name !== 'MathMark') {
            latex += source.slice(at, child.from)
            at = child.to
          }
        latex += source.slice(at, node.to - mark)
        assert.equal(
          node.name === 'InlineMathLines',
          latex.includes('\n'),
          `node for ${JSON.stringify(source)}`,
        )
        found.push(
          mark === 1
            ? ['inline', lines(latex)]
            : ['display', lines(latex.trim())],
        )
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

/** Math in document order, as the math addon's Marked tokenizers find it. */
function markedMath(source) {
  const found = []
  marked.walkTokens(marked.lexer(source), (token) => {
    if (token.type === 'inlineMath')
      found.push(
        token.display
          ? ['display', lines(token.latex)]
          : ['inline', lines(token.latex)],
      )
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
  // Display math inside a line, as Obsidian draws `$$…$$` there.
  '# If $$ f(x,y)\\in C^{k+1} $$ at each point',
  'a $$x$$ b $$y$$ c',
  'a $$x$$$ b',
  'a $$ $$ b',
  'a $$x\ny$$ b',
  // As in Obsidian, across lines of a paragraph, blank, or holding `$`.
  'a $$x$y$$ b',
  'a $$$$ b',
  'a $$ \n $$ b',
  'a $$$x$$ b',
  'a $$x\\\n+y$$ b',
  '> a $$x\n> +y$$ b',
  '> > a $$x\n> > +y$$ b',
  '- a $$x\n  +y$$ b',
  '- > a $$x\n  > +y$$ b',
  '> - a $$x\n>   +y$$ b',
  '> [!note]\n> a $$x\n> +y$$ b',
  'Setext $$p\n+q$$ title\n===',
  'a \\$$x\n+y$$ b',
  '`a $$x\n+y$$` b',
  'a $$x\n\n+y$$ b',
  'a $$x\n# heading\ny$$ b',
  '$5 and\n$10',
  '$5 and $$\n$10',
  `a $$x\n${'y'.repeat(9_998)}$$`,
  `a $$x\n${'y'.repeat(9_999)}$$`,
  'a $$x\\$$ b$$ c',
  'cost $$5 and $$10',
  '**$$x$$** and [$$y$$](https://example.com/)',
  '| $$x$$ | y |\n| --- | --- |\n| z | $$w$$ |',
  `a $$${'x'.repeat(10_000)}$$`,
  `a $$${'x'.repeat(10_001)}$$`,
]

test('formatted math matches the math tokenizers on the math fixtures', () => {
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

test('formatted and source outlines agree around nested and mid-line math', () => {
  for (const fixture of fixtures) {
    const source = `${fixture}\n\n# after`
    const store = new SourceStore(source, {
      tabId: 'math-outline',
      revision: 0,
    })
    const model = new SourceOutlineModel(store.snapshot(), {
      gfm: true,
      frontmatter: false,
      math: true,
    })
    try {
      const work = model.read()
      let step
      do {
        step = work.next(null)
      } while (!step.done)
      const expected = []
      formatted.parse(source).iterate({
        enter(node) {
          if (/^(ATX|Setext)Heading/.test(node.name)) expected.push(node.from)
        },
      })
      assert.deepEqual(
        step.value.headings.map((_, index) => step.value.position(index)),
        expected,
        JSON.stringify(source),
      )
    } finally {
      model.dispose()
    }
  }
})

/**
 * The inline branch of Obsidian 1.13.7's inline math tokenizer in its
 * app.js, for text starting with one `$`: where the closing `$` ends, or -1.
 */
function obsidianInlineEnd(text) {
  let next = text.charCodeAt(1)
  if (next === 36 || next === 32 || next === 9) return -1
  for (let at = 1; at < text.length; at++) {
    const code = next
    next = text.charCodeAt(at + 1)
    if (code === 36) {
      const before = text.charCodeAt(at - 1)
      if (before !== 32 && before !== 9 && !(next >= 48 && next <= 57))
        return at + 1
    } else if (code === 92) next = text.charCodeAt(++at + 1)
  }
  return -1
}

test('inline math ends where Obsidian ends it, in linear time', () => {
  const alphabet = ['$', '\\', 'a', ' ', '\t', '\n', '5', '$$']
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
    const expected = obsidianInlineEnd(text)
    assert.equal(inlineMathEnd(text, 0), expected, JSON.stringify(text))
    // The tokenizer reads a `$$` as display math.
    assert.equal(
      inlineMath(text)?.raw.length ?? -1,
      text[1] === '$' ? obsidianDisplayEnd(text) : expected,
      JSON.stringify(text),
    )
  }
  assert.equal(inlineMathEnd(`$${'\\'.repeat(200_000)}x`, 0), -1)
  for (const count of [5_000, 5_001]) {
    const closed = `$${'\\'.repeat(count)}x$`
    assert.equal(inlineMathEnd(closed, 0), obsidianInlineEnd(closed))
  }
  // Openers without a closer, as in currency, share one search for it.
  for (const make of [
    (count) => `x ${'$5 and '.repeat(count)}`,
    (count) => `x ${'a$5 b\n'.repeat(count)}`,
    (count) => `x ${'$a \\$ '.repeat(count)}`,
  ]) {
    const work = []
    for (const count of [1000, 2000, 4000, 8000]) {
      const text = make(count)
      inlineMathWork.positions = 0
      formatted.parse(text)
      work.push(inlineMathWork.positions / text.length)
      inlineMathWork.positions = 0
      marked.lexer(text)
      work.push(inlineMathWork.positions / text.length)
    }
    for (const perUnit of work) assert.ok(perUnit <= 1, JSON.stringify(work))
  }
})

test('single-dollar math reads as Obsidian reads it, after an escaped dollar too', () => {
  for (const [source, expected] of [
    // `\$` is a dollar sign; the formula after it closes right before `$`.
    ['\\$$x$$', [['inline', 'x']]],
    ['a \\$$x\ny$$ b', [['inline', 'x\ny']]],
    ['cost $5 and $$\n10$$', [['inline', '5 and $']]],
    ['$x$$', [['inline', 'x']]],
    // A `$` after a space or before a digit does not close.
    ['$a $b$', [['inline', 'a $b']]],
    ['$a$1 b$', [['inline', 'a$1 b']]],
    ['$x\ny$ z', [['inline', 'x\ny']]],
    ['> a $x\n> y$ b', [['inline', 'x\ny']]],
    ['$5 and $10', []],
    ['$ x$', []],
    ['$x $', []],
    ['\\$x$', []],
    ['\\$\\$x$$', []],
  ]) {
    assert.deepEqual(lezerMath(source), expected, source)
    assert.deepEqual(markedMath(source), expected, source)
  }
})

/**
 * The display branch of Obsidian 1.13.7's inline math tokenizer in its
 * app.js, for text starting with `$$`: where the closing `$$` ends, or -1.
 * Obsidian then also takes the spaces up to a line break after it, which
 * read the same as part of the paragraph.
 */
function obsidianDisplayEnd(text) {
  let next = text.charCodeAt(2)
  for (let at = 2; at < text.length; at++) {
    const code = next
    next = text.charCodeAt(at + 1)
    if (code === 36 && next === 36) return at + 2
    if (code === 92) next = text.charCodeAt(++at + 1)
  }
  return -1
}

test('display math inside a line ends where Obsidian ends it, in linear time', () => {
  const alphabet = ['$', '\\', 'a', ' ', '\n', '\r', '$$']
  let seed = 11
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  for (let run = 0; run < 20_000; run++) {
    let text = '$$'
    const length = 1 + Math.floor(random() * 14)
    for (let i = 0; i < length; i++)
      text += alphabet[Math.floor(random() * alphabet.length)]
    assert.equal(
      inlineDisplayMath(text)?.raw.length ?? -1,
      obsidianDisplayEnd(text),
      JSON.stringify(text),
    )
  }
  // Each opener reads to the next double dollar or the formula limit. Two
  // openers overlap at most, as in `$$$`, and the dollar after them reads
  // to the next dollar, so each unit is read a bounded number of times.
  for (const [make, bound] of [
    [(count) => `x ${'$$ aaaa $ '.repeat(count)}`, 1],
    [(count) => `x ${'$$ a\nb $ '.repeat(count)}`, 1],
    [(count) => `x ${`$$$${'a'.repeat(10_001)}`.repeat(count / 1000)}`, 3.5],
  ]) {
    const work = []
    for (const count of [1000, 2000, 4000, 8000]) {
      const line = make(count)
      inlineMathWork.positions = 0
      formatted.parse(line)
      work.push(inlineMathWork.positions / line.length)
      inlineMathWork.positions = 0
      marked.lexer(line)
      work.push(inlineMathWork.positions / line.length)
    }
    for (const perUnit of work)
      assert.ok(perUnit <= bound, JSON.stringify(work))
  }
})

test('display math inside a paragraph spans lines, may be blank and may hold dollars, as in Obsidian', () => {
  for (const [source, expected] of [
    ['a $$x\n+y$$ b', [['display', 'x\n+y']]],
    ['a $$ $$ b', [['display', '']]],
    ['a $$x$y$$ b', [['display', 'x$y']]],
    ['a $$$$ b', [['display', '']]],
    ['a $$x\\\n+y$$ b', [['display', 'x\\\n+y']]],
    ['> a $$x\n> +y$$ b', [['display', 'x\n+y']]],
    ['- a $$x\n  +y$$ b', [['display', 'x\n+y']]],
    ['Setext $$p\n+q$$ title\n===', [['display', 'p\n+q']]],
    ['| $$x$y$$ | b |\n| --- | --- |', [['display', 'x$y']]],
    // After an escaped dollar, `$x\n+y$` is inline math; code spans,
    // paragraph ends and currency stay text.
    ['a \\$$x\n+y$$ b', [['inline', 'x\n+y']]],
    ['`a $$x\n+y$$` b', []],
    ['a $$x\n\n+y$$ b', []],
    ['a $$x\n# heading\ny$$ b', []],
    ['costs $5 and\n$10', []],
  ]) {
    assert.deepEqual(lezerMath(source), expected, source)
    assert.deepEqual(markedMath(source), expected, source)
  }
})

test('emphasis, strikethrough or a link that opened first wins over math, as in Obsidian and exports', () => {
  for (const [source, expected] of [
    ['a *$$x* +y$$', []],
    ['a **$$x** y$$', []],
    ['a ~~$$x~~ y$$', []],
    ['a _$$x_ y$$', []],
    ['a [$$x](u) y$$', []],
    ['a *b $$x* y$$ c*', []],
    ['a *x $$y\nz* w$$', []],
    ['a *$x* y$', []],
    ['a ![$$x](u) y$$', []],
    ['a *b* *c $$x* y$$', []],
    // Math inside them, or syntax that closed before it, stays math.
    ['a *$$x$$* b', [['display', 'x']]],
    ['a $$x *y$$ z*', [['display', 'x *y']]],
    ['*a* $$x *b* y$$', [['display', 'x *b* y']]],
    ['a [x $$y [z] w$$ v](u)', [['display', 'y [z] w']]],
    // A link that finished around math leaves emphasis before it open.
    ['[a $x$ b](u) *c $y* d$', [['inline', 'x']]],
    ['*a [b $x$](u) $y* z$', [['inline', 'x']]],
    ['[ ![i](j) $x$ z', [['inline', 'x']]],
  ]) {
    assert.deepEqual(lezerMath(source), expected, source)
    assert.deepEqual(markedMath(source), expected, source)
  }
})

test('math after emphasis, links and open brackets reads its paragraph in linear time', () => {
  for (const make of [
    (count) => `x ${'*a* $b$ '.repeat(count)}`,
    (count) => `*x ${'**a** $b$ '.repeat(count)}`,
    (count) => `[ ${'![a](b) $c$ '.repeat(count)}`,
    (count) => `x ${'*a* [b $c$ d](e) '.repeat(count)}`,
  ]) {
    const work = []
    for (const count of [1000, 2000, 4000, 8000]) {
      const text = make(count)
      precedenceWork.reads = 0
      formatted.parse(text)
      work.push(precedenceWork.reads / text.length)
    }
    // Reading every delimiter before each formula was quadratic.
    for (const perUnit of work) assert.ok(perUnit <= 2, JSON.stringify(work))
  }
})

test('a pair over the formula limit stays text, so its closing dollars open nothing', () => {
  const long = 'x'.repeat(10_001)
  for (const [source, expected] of [
    [`a $$${long}$$ b $$c$$ d`, [['display', 'c']]],
    [`a $$x\n${long}$$ b $$c$$ d`, [['display', 'c']]],
    [`$$\n${long}\n$$ b $$c$$`, [['display', 'c']]],
    [`a $${long}$b$ c`, []],
    [`a $${long}$ $b$ c`, [['inline', 'b']]],
  ]) {
    const label = JSON.stringify(source.slice(0, 12))
    assert.deepEqual(lezerMath(source), expected, label)
    assert.deepEqual(markedMath(source), expected, label)
  }
})

test('display math can touch currency or another inline formula', () => {
  for (const [source, expected] of [
    ['before $$x$$$5 after', [['display', 'x']]],
    [
      '$$a+b$$$c+d$',
      [
        ['display', 'a+b'],
        ['inline', 'c+d'],
      ],
    ],
  ]) {
    assert.deepEqual(lezerMath(source), expected, source)
    assert.deepEqual(markedMath(source), expected, source)
  }
})

test('double dollars respect literal contexts and table cells', () => {
  for (const source of [
    'costs $5 and $10',
    'costs $5.00 or $10.00',
    String.raw`escaped \$\$x$$ and \$5`,
    '`$$x$$` and ``code ` $$y$$``',
    '```tex\n$$x$$\n```',
    '[link](https://example.test/$$x$$)',
    '| `$$x$$` | \\$\\$y$$ |\n| --- | --- |',
  ]) {
    assert.deepEqual(lezerMath(source), [], source)
    assert.deepEqual(markedMath(source), [], source)
  }
  // As in Obsidian, an escaped first dollar leaves `$y$` before the last one.
  for (const source of [
    String.raw`escaped \$$y$$ and \$5`,
    '| `$$x$$` | \\$$y$$ |\n| --- | --- |',
  ]) {
    assert.deepEqual(lezerMath(source), [['inline', 'y']], source)
    assert.deepEqual(markedMath(source), [['inline', 'y']], source)
  }
  const source = '| before $$x+1$$ after | `$5` |\n| --- | --- |'
  assert.deepEqual(lezerMath(source), [['display', 'x+1']])
  assert.deepEqual(markedMath(source), [['display', 'x+1']])
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

/** A paragraph over 64 KiB, which the formatted view parses in windows. */
function giantParagraph(length, seed) {
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const units = [
    (i) => `w${i} words $$x_${i}`,
    (i) => `+y_${i}$$ more words`,
    (i) => `see \`$$\` and \`a$\` code ${i}`,
    (i) => `cost \\$$ and \\$5 here ${i}`,
    (i) => `inline $a_${i}$ and $$b$$ then`,
    (i) => `code \`\`spans ${i}`,
    () => `across\`\` lines $c$`,
  ]
  const lines = []
  for (let i = 0, size = 0; size < length; i++) {
    const line =
      i === 900
        ? `long $$q\n${'q'.repeat(4_000)}\n${'q'.repeat(4_000)}$$ end`
        : i === 1800
          ? `over $$${'z'.repeat(10_500)}$$ after`
          : units[Math.floor(random() * units.length)](i)
    lines.push(line)
    size += line.length + 1
  }
  return `# T\n\n${lines.join('\n')}\n\n## after\n`
}

/** Code spans and math fully inside `from`-`to`. */
function pairsIn(tree, from, to) {
  const found = []
  tree.iterate({
    from,
    to,
    enter(node) {
      if (
        /^(InlineMath|InlineMathLines|InlineCode)$/.test(node.name) &&
        node.from >= from &&
        node.to <= to
      )
        found.push(`${node.name}:${node.from}-${node.to}`)
    },
  })
  return found
}

const stringInput = (text) => ({
  length: text.length,
  lineChunks: false,
  chunk: (from) => text.slice(from),
  read: (from, to) => text.slice(from, to),
})

function chunkedParse(text, demand, options = {}, fragments = []) {
  const probe = { scannedUnits: 0, parsedUnits: 0, reusedNodes: 0 }
  const parse = new ChunkedMarkdownParser(formatted, formatted, {
    ...options,
    probe,
  }).startChunkedParse(stringInput(text), fragments, demand)
  let tree = null
  while (!tree) tree = parse.advance()
  return { tree, probe }
}

test('giant paragraphs pair math and code spans across window seams as the whole paragraph does', () => {
  let text = giantParagraph(150_000, 41)
  const exact = formatted.parse(text)
  for (const options of [{}, { chunkSize: 64, groupSize: 4, giantBlock: 1024 }])
    for (let k = 1; k < 25; k++) {
      const at = Math.floor((text.length * k) / 25)
      const demand = { from: at, to: Math.min(text.length, at + 3000) }
      const { tree } = chunkedParse(text, demand, options)
      assert.deepEqual(
        pairsIn(tree, demand.from, demand.to),
        pairsIn(exact, demand.from, demand.to),
        `${JSON.stringify(options)} at ${at}`,
      )
    }
  // Edits keep the pairing: in the viewport, and far above it, where a new
  // `$$` flips every pair after it.
  const at = Math.floor(text.length / 2)
  const demand = { from: at, to: at + 3000 }
  let { tree } = chunkedParse(text, demand)
  for (const [pos, insert] of [
    [at + 1500, 'x'],
    [at + 1500, '$$'],
    [at + 1600, '`'],
    [at + 1700, '\\'],
    [20, '$$'],
    [20, '`'],
  ]) {
    text = text.slice(0, pos) + insert + text.slice(pos)
    const fragments = TreeFragment.applyChanges(TreeFragment.addTree(tree), [
      { fromA: pos, toA: pos, fromB: pos, toB: pos + insert.length },
    ])
    ;({ tree } = chunkedParse(text, demand, {}, fragments))
    assert.deepEqual(
      pairsIn(tree, demand.from, demand.to),
      pairsIn(formatted.parse(text), demand.from, demand.to),
      `after ${JSON.stringify(insert)} at ${pos}`,
    )
  }
})

test('an edit above a seam checkpoint pairs the giant paragraph after it again', () => {
  // Prose decides no pairs, yet each checkpoint rests on every line before it.
  const lines = Array.from(
    { length: 400 },
    (_, i) => `plain words on line ${i} here`,
  )
  lines[240] = 'close$$ here'
  const text = `# T\n\n${lines.join('\n')}\n\n## after\n`
  const options = { chunkSize: 64, groupSize: 4, giantBlock: 1024 }
  const close = text.indexOf('close$$') + 5
  const { tree } = chunkedParse(
    text,
    { from: close - 100, to: close + 200 },
    options,
  )
  // The pair a new `$$` opens reaches into the viewport from above it.
  const demand = { from: close - 98, to: close + 202 }
  const pairs = (tree) => {
    const found = []
    tree.iterate({
      ...demand,
      enter(node) {
        if (/^(InlineMath|InlineMathLines|InlineCode)$/.test(node.name))
          found.push(`${node.name}:${node.from}-${node.to}`)
      },
    })
    return found
  }
  for (let pos = close - 900; pos < close - 50; pos += 7) {
    const edited = `${text.slice(0, pos)}$$${text.slice(pos)}`
    const fragments = TreeFragment.applyChanges(TreeFragment.addTree(tree), [
      { fromA: pos, toA: pos, fromB: pos, toB: pos + 2 },
    ])
    assert.deepEqual(
      pairs(chunkedParse(edited, demand, options, fragments).tree),
      pairs(formatted.parse(edited)),
      `$$ at ${pos}`,
    )
  }
})

test('typing in a giant paragraph reads its seams in bounded work, whatever its length', () => {
  const work = []
  for (const length of [1 << 20, 4 << 20]) {
    let text = giantParagraph(length, 7)
    const at = Math.floor(text.length * 0.6)
    const demand = { from: at, to: at + 3000 }
    let { tree } = chunkedParse(text, demand)
    for (const insert of ['x', '$$', 'y']) {
      const pos = at + 1500
      text = text.slice(0, pos) + insert + text.slice(pos)
      const fragments = TreeFragment.applyChanges(TreeFragment.addTree(tree), [
        { fromA: pos, toA: pos, fromB: pos, toB: pos + insert.length },
      ])
      let probe
      ;({ tree, probe } = chunkedParse(text, demand, {}, fragments))
      work.push(probe.seamUnits)
    }
  }
  // About a viewport's window and one pair limit of reading ahead, not the paragraph.
  for (const units of work) assert.ok(units <= 4 * 65_536, JSON.stringify(work))
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
