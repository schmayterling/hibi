import assert from 'node:assert/strict'
import test from 'node:test'
import { Lexer, Marked } from 'marked'
import { alertMarkdown } from '../src/addons/markdown/alerts.ts'
import { mathTokens } from '../src/addons/math/syntax.ts'
import { textExtrasMarkdown } from '../src/addons/text-extras/syntax.ts'
import { typstTokens } from '../src/addons/typst/syntax.ts'
import { countText } from '../src/addons/word-count/count.ts'
import { richText } from '../src/addons/word-count/formatted-text.ts'
import {
  blockMarkdown,
  blockScanCounters,
} from '../src/shared/marked-blocks.ts'
import { markedGithubFootnote } from '../src/shared/marked-footnotes.ts'
import { defaultNoteSyntax } from '../src/shared/note-syntax.ts'

const parser = () => {
  const parser = new Marked(
    blockMarkdown,
    mathTokens,
    textExtrasMarkdown,
    alertMarkdown,
    markedGithubFootnote(),
    typstTokens,
  )
  parser.use({
    extensions: [
      { name: 'blockMath', renderer: (token) => `<m>${token.latex}</m>` },
    ],
  })
  return parser
}

const syntax = {
  ...defaultNoteSyntax,
  gfm: true,
  math: true,
  textExtras: true,
  alerts: true,
  typst: true,
  mermaid: true,
  disabledFeatures: [],
}

const giant = '> a\n> $$\n> x\n> $$\n> -# s\n'
const lazy = '> # h\n> p\nlazy\n'
const paragraph = '> p\nlazy\n'
const code = '> p\n    lazy\n'
const list = '> - a\nlazy\n'
// Quotes that end before the native quote rule's extent does: a lazy line
// after a heading or fenced code, and a nested quote that ends first.
const heading = '> # h\nlazy\n'
const fence = '> ```\n> c\n> ```\nlazy\n'
const nested = '> > b\nc\n>\n> d\n'
// The same under tab columns: each nested quote's extensions read the quote's
// extent widened at its tabs, here with tabs after and away from the marker.
const tabbed = '> > # h\t\n> lazy\n'
const widened = '> >\t# h\n> lazy\n'

test('quotes that stop early leave the rest of the extent unscanned', () => {
  // Every quote line check, in any scan, uses Marked's shared quote start rule.
  const start = new Lexer().tokenizer.rules.other.blockquoteStart
  let checks = 0
  start.test = function (text) {
    checks++
    return RegExp.prototype.test.call(this, text)
  }
  const shape = (tokens) =>
    tokens
      .filter((token) => token.type !== 'space')
      .map((token) => [token.type, token.raw, shape(token.tokens ?? [])])
  try {
    for (const unit of [heading, fence, nested, tabbed, widened]) {
      const source = unit.repeat(2000)
      checks = 0
      const tokens = parser().lexer(source)
      const counted = checks
      assert.deepEqual(shape(tokens), shape(new Marked().lexer(source)), unit)
      // Scanning the whole extent again at every quote call checks the lines
      // of every unit after it: millions of lines here.
      assert.ok(counted < 2000 * 100, `${JSON.stringify(unit)}: ${counted}`)
    }
  } finally {
    delete start.test
  }
})

test('empty quote markers retain native lazy-line boundaries', () => {
  for (const first of ['>', '> ', '>  ', ' >', '  > ', '> p']) {
    for (const next of [
      'plain',
      '\nplain',
      '# heading',
      '> next',
      '- item',
      '===',
    ]) {
      const source = `${first}\n${next}\n`
      assert.equal(
        new Marked(blockMarkdown).parse(source),
        new Marked().parse(source),
        source,
      )
    }
  }
})

test('quote matching avoids the native recursive regex on whole notes', () => {
  const source = giant.repeat(2000)
  const exec = RegExp.prototype.exec
  const pattern = Lexer.rules.block.normal.blockquote.source
  let largest = 0
  RegExp.prototype.exec = function (text) {
    if (this.source === pattern) largest = Math.max(largest, text.length)
    return exec.call(this, text)
  }
  try {
    parser().lexer(source)
  } finally {
    RegExp.prototype.exec = exec
  }
  assert.ok(largest < 256, String(largest))
})

test('one giant quote scans setext candidates once per parse frame', () => {
  const source = giant.repeat(2000)
  blockScanCounters.units = 0
  const [quote] = parser().lexer(source)
  assert.equal(quote.type, 'blockquote')
  assert.equal(
    quote.tokens.filter((token) => token.type === 'subtext').length,
    2000,
  )
  assert.ok(
    blockScanCounters.units < source.length * 4,
    String(blockScanCounters.units),
  )
})

test('rejected setext prefixes do not rescan earlier separators', () => {
  const source = '> a\u2028b\n> -# s\n'.repeat(2000) + '> ===\n'
  blockScanCounters.units = 0
  parser().lexer(source)
  assert.ok(
    blockScanCounters.units < source.length * 4,
    String(blockScanCounters.units),
  )
})

test('lazy quote chains do not copy each remaining line array', () => {
  const source = lazy.repeat(2000)
  const slice = Array.prototype.slice
  blockScanCounters.quoteLines = 0
  let visits = 0
  Array.prototype.slice = function (from = 0, to = this.length) {
    if (['> # h', '> p', 'lazy'].includes(this[0]))
      visits += Math.max(0, Math.min(to, this.length) - from)
    return slice.call(this, from, to)
  }
  let tokens
  try {
    tokens = parser().lexer(source)
  } finally {
    Array.prototype.slice = slice
  }
  assert.equal(
    tokens[0].tokens.filter((token) => token.type === 'heading').length,
    2000,
  )
  assert.ok(visits < 2000 * 4, String(visits))
  assert.ok(blockScanCounters.quoteLines < 2000 * 5)
})

test('one lazy paragraph does not repeatedly inspect its growing raw text', () => {
  const source = '> p\nlazy\n'.repeat(2000)
  const endsWith = String.prototype.endsWith
  let units = 0
  String.prototype.endsWith = function (suffix, ...args) {
    if (suffix === '\n') units += this.length
    return endsWith.call(this, suffix, ...args)
  }
  try {
    const [quote] = parser().lexer(source)
    assert.equal(quote.tokens.length, 1)
    assert.equal(quote.tokens[0].text, 'p\nlazy\n'.repeat(2000).trimEnd())
  } finally {
    String.prototype.endsWith = endsWith
  }
  assert.ok(units < source.length * 10, String(units))
})

test('block extensions observe original tokens during lazy merges', () => {
  const source = '> p\n    lazy\n> next\n[ref]: /x\n> more\ntext\n'
  const run = (blocks) => {
    const seen = []
    const inspect = {
      extensions: [
        {
          name: 'inspect',
          level: 'block',
          tokenizer(source, tokens) {
            const last = tokens.at(-1)
            seen.push([source, last?.type, last?.raw, last?.text])
          },
        },
      ],
    }
    const parser = new Marked(...(blocks ? [blockMarkdown] : []), inspect)
    const html = parser.parse(source)
    return { html, seen }
  }
  assert.deepEqual(run(true), run(false))
})

test('custom paragraph raw spelling keeps native merge behavior', () => {
  const source = '> @p\nlazy\n> next\nlazy'
  const read = (blocks) => {
    const extension = {
      extensions: [
        {
          name: 'rewrittenParagraph',
          level: 'block',
          tokenizer(source) {
            if (!source.startsWith('@p')) return
            return {
              type: 'paragraph',
              raw: '@\n',
              text: 'p',
              tokens: this.lexer.inline('p'),
            }
          },
        },
      ],
    }
    const parser = new Marked(...(blocks ? [blockMarkdown] : []), extension)
    return JSON.parse(JSON.stringify(parser.lexer(source)))
  }
  assert.deepEqual(read(true), read(false))
})

test('lazy quoted lists do not copy the document tail or accumulated prefix', () => {
  const source = '> - a\nlazy\n'.repeat(2000)
  const slice = Array.prototype.slice
  const join = Array.prototype.join
  let work = 0
  const count = (lines) => {
    if (
      typeof lines[0] === 'string' &&
      (lines[0].includes('- a') || lines[0] === 'lazy' || lines[1] === '> - a')
    )
      work += lines.length
  }
  Array.prototype.slice = function (...args) {
    count(this)
    return slice.apply(this, args)
  }
  Array.prototype.join = function (...args) {
    count(this)
    return join.apply(this, args)
  }
  let tokens
  try {
    tokens = parser().lexer(source)
  } finally {
    Array.prototype.slice = slice
    Array.prototype.join = join
  }
  assert.equal(
    tokens[0].tokens.filter((token) => token.type === 'list').length,
    2000,
  )
  assert.ok(work < 2000 * 100, String(work))
})

test('code and definition continuations bound paragraph merge work', () => {
  for (const unit of ['> p\n    lazy\n', '> p\n[ref]: /x\n']) {
    const source = unit.repeat(2000)
    const endsWith = String.prototype.endsWith
    let units = 0
    String.prototype.endsWith = function (suffix, ...args) {
      if (suffix === '\n') units += this.length
      return endsWith.call(this, suffix, ...args)
    }
    let tokens
    try {
      tokens = parser().lexer(source)
    } finally {
      String.prototype.endsWith = endsWith
    }
    assert.equal(tokens[0].tokens.length, 1)
    assert.ok(units < source.length * 10, `${JSON.stringify(unit)}: ${units}`)
  }
})

for (const [shape, unit] of Object.entries({
  giant,
  lazy,
  paragraph,
  code,
  list,
  heading,
  fence,
  nested,
})) {
  const source = unit.repeat(Math.ceil((1024 * 1024) / unit.length))
  for (const operation of ['export', 'count']) {
    test(`one MiB ${shape} quote ${operation} stays under 20 seconds`, () => {
      const start = performance.now()
      const result =
        operation === 'export'
          ? parser().parse(source, { async: false })
          : countText(richText(source, syntax))
      const elapsed = performance.now() - start
      const units = source.length / unit.length
      if (operation === 'export') {
        const pattern =
          shape === 'giant'
            ? /<m>/g
            : shape === 'lazy' || shape === 'heading'
              ? /<h1>/g
              : shape === 'list'
                ? /<ul>/g
                : shape === 'fence'
                  ? /<pre>/g
                  : shape === 'nested'
                    ? /<blockquote>/g
                    : /<p>/g
        assert.equal(
          (result.match(pattern) ?? []).length,
          shape === 'paragraph' || shape === 'code'
            ? 1
            : shape === 'nested'
              ? 2 * units + 1
              : units,
        )
      } else
        assert.equal(
          result.words,
          units * (shape === 'lazy' || shape === 'nested' ? 3 : 2),
        )
      assert.ok(elapsed < 20000, `${operation}: ${elapsed.toFixed(0)}ms`)
    })
  }
}
