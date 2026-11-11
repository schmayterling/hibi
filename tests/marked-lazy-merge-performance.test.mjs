import assert from 'node:assert/strict'
import test from 'node:test'
import { Marked, Tokenizer } from 'marked'
import { richText } from '../src/addons/word-count/formatted-text.ts'
import { blockMarkdown } from '../src/shared/marked-blocks.ts'
import { defaultNoteSyntax } from '../src/shared/note-syntax.ts'

const cases = [
  ['list', '- a'],
  ['ordered list', '1. a'],
  ['quoted list', '> - a\n'],
  ['nested list', '- - a'],
  ['quote', '> a\n'],
  ['paragraph', 'a'],
]
for (const [name, prefix] of cases)
  for (const operation of ['export', 'count']) {
    const read = (source) =>
      operation === 'export'
        ? new Marked(blockMarkdown).parse(source)
        : richText(source, defaultNoteSyntax)
    test(`plain lazy ${name} ${operation} bounds raw merge inspections`, (t) => {
      for (const n of [32, 64, 128]) {
        const source = prefix + 'b\nc\n'.repeat(n),
          endsWith = String.prototype.endsWith
        let units = 0
        const probe = t.mock.method(
          String.prototype,
          'endsWith',
          function (suffix, ...args) {
            if (suffix === '\n') units += this.length
            return endsWith.call(this, suffix, ...args)
          },
        )
        let result
        try {
          result = read(source)
        } finally {
          probe.mock.restore()
        }
        const native = new Marked()
        if (operation === 'export') assert.equal(result, native.parse(source))
        else assert.equal(result.replace(/\s/g, ''), 'a' + 'bc'.repeat(n))
        assert.ok(
          units <= source.length * 20,
          `${units} inspected / ${source.length} source units`,
        )
      }
    })
    test(`one MiB plain lazy ${name} ${operation} stays under 20 cpu seconds`, (t) => {
      const source = prefix + 'b\nc\n'.repeat(2 ** 18),
        start = process.cpuUsage()
      const result = read(source)
      assert.equal(
        result.replace(/<[^>]*>/g, '').replace(/\s/g, ''),
        'a' + 'bc'.repeat(2 ** 18),
      )
      const { user, system } = process.cpuUsage(start)
      t.diagnostic(
        JSON.stringify({ cpuMs: (user + system) / 1000, bytes: source.length }),
      )
      assert.ok(
        user + system < 20_000_000,
        `${(user + system) / 1e6} cpu seconds`,
      )
    })
  }

test('plain lazy list merges keep custom raw spelling', () => {
  const custom = {
    tokenizer: {
      text(source) {
        const token = Tokenizer.prototype.text.call(this, source)
        return token && { ...token, raw: '\n' + token.raw }
      },
    },
  }
  const source = '- a\nb\nc\n'
  assert.deepEqual(
    new Marked(blockMarkdown, custom).lexer(source),
    new Marked(custom).lexer(source),
  )
})
