import assert from 'node:assert/strict'
import test from 'node:test'
import { Marked } from 'marked'
import {
  blockMarkdown,
  blockScanCounters,
} from '../src/shared/marked-blocks.ts'
import { markedGithubFootnote } from '../src/shared/marked-footnotes.ts'

const read = (source) =>
  new Marked(blockMarkdown, markedGithubFootnote()).lexer(source)
for (const prefix of ['', '- a\n', '> ']) {
  test(`lazy footnote after ${JSON.stringify(prefix)} retains paragraph underlines`, () => {
    for (const continuation of ['===', ' ===', '===\nlazy', 'lazy\n===']) {
      const written = '[^1]: f\n' + continuation
      const source =
        prefix + (prefix === '> ' ? written.replaceAll('\n', '\n> ') : written)
      const parser = new Marked(blockMarkdown, markedGithubFootnote())
      let definition
      parser.walkTokens(parser.lexer(source), (token) => {
        if (token.type === 'footnoteDef') definition = token
      })
      assert.ok(definition)
      assert.equal(definition.tokens.length, 1)
      assert.equal(definition.tokens[0].type, 'paragraph')
      assert.equal(
        definition.tokens[0].text.replace(/\s+/g, ' '),
        ('f ' + continuation).replace(/\s+/g, ' '),
      )
    }
  })
}

test('lazy footnote underline scans and raw merges are bounded', (t) => {
  for (const count of [32, 64, 128]) {
    const source = '[^1]: f\n' + 'b\n===\n'.repeat(count)
    blockScanCounters.calls = blockScanCounters.units = 0
    const endsWith = String.prototype.endsWith
    let units = 0
    const probe = t.mock.method(
      String.prototype,
      'endsWith',
      function (suffix, ...args) {
        if (suffix === '\n') units += this.length
        return endsWith.call(this, suffix, ...args)
      },
    )
    let tokens
    try {
      tokens = read(source)
    } finally {
      probe.mock.restore()
    }
    assert.equal(tokens[0].tokens.length, 1)
    assert.equal(tokens[0].tokens[0].type, 'paragraph')
    assert.ok(
      blockScanCounters.units < source.length * 8,
      JSON.stringify(blockScanCounters),
    )
    assert.ok(
      units < source.length * 8,
      `${units} raw units / ${source.length} source units`,
    )
  }
})

test('indented footnote paragraphs share their next heading scan', () => {
  for (const count of [32, 64, 128]) {
    const source =
      '[^1]: f\n' + '\n    p\n    text\n'.repeat(count) + '    ===\n'
    blockScanCounters.calls = blockScanCounters.units = 0
    const tokens = read(source)
    assert.equal(tokens[0].tokens.at(-1).type, 'heading')
    assert.ok(
      blockScanCounters.units < source.length * 8,
      JSON.stringify(blockScanCounters),
    )
  }
})

test('one MiB lazy footnote stays under 20 cpu seconds', () => {
  const source = '[^1]: f\n' + 'b\n===\n'.repeat(Math.ceil(2 ** 20 / 6))
  const start = process.cpuUsage()
  const tokens = read(source)
  const { user, system } = process.cpuUsage(start)
  assert.equal(tokens[0].tokens.length, 1)
  assert.equal(tokens[0].tokens[0].type, 'paragraph')
  assert.equal(tokens[0].tokens[0].text, source.slice(6).trimEnd())
  assert.ok(user + system < 20_000_000, `${(user + system) / 1e6} cpu seconds`)
})

test('nested footnote physical line indexes scan bounded source units', (t) => {
  for (const count of [32, 64, 128, 256]) {
    const source =
      '- a\n  - b\n    ===\n' +
      Array.from(
        { length: count },
        (_, i) => '[^' + i + ']: f\n    ===\n',
      ).join('')
    const indexOf = String.prototype.indexOf
    let units = 0
    const probe = t.mock.method(
      String.prototype,
      'indexOf',
      function (marker, from = 0) {
        const at = indexOf.call(this, marker, from)
        if (marker === '\n')
          units += Math.max(0, (at < 0 ? this.length : at + 1) - from)
        return at
      },
    )
    const parser = new Marked(blockMarkdown, markedGithubFootnote())
    let tokens
    try {
      tokens = parser.lexer(source)
    } finally {
      probe.mock.restore()
    }
    let definitions = 0
    parser.walkTokens(tokens, (token) => {
      if (token.type === 'footnoteDef') {
        definitions++
        assert.equal(token.tokens[0].type, 'heading')
      }
    })
    assert.equal(definitions, count)
    assert.ok(
      units <= source.length * 80,
      units + ' physical units / ' + source.length,
    )
  }
})

test('one MiB nested footnote preserves genuine headings under 20 cpu seconds', (t) => {
  const unit = 'b\n    ===\n',
    count = Math.ceil(2 ** 20 / unit.length)
  const source = '- a\n  - b\n    ===\n[^2]: g\n' + unit.repeat(count)
  const start = process.cpuUsage()
  const parser = new Marked(blockMarkdown, markedGithubFootnote())
  let definition
  parser.walkTokens(parser.lexer(source), (token) => {
    if (token.type === 'footnoteDef') definition = token
  })
  assert.equal(definition.tokens.length, count)
  assert.ok(definition.tokens.every((token) => token.type === 'heading'))
  const { user, system } = process.cpuUsage(start)
  t.diagnostic(
    JSON.stringify({ cpuMs: (user + system) / 1000, bytes: source.length }),
  )
  assert.ok(user + system < 20_000_000, (user + system) / 1e6 + ' cpu seconds')
})
