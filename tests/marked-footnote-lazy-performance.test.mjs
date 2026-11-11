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
