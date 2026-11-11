import assert from 'node:assert/strict'
import test from 'node:test'
import { Marked } from 'marked'
import { obsidianMarkdown } from '../src/addons/markdown/obsidian-markdown.ts'
import { mathTokens } from '../src/addons/math/syntax.ts'
import { textExtrasMarkdown } from '../src/addons/text-extras/syntax.ts'
import { richText } from '../src/addons/word-count/formatted-text.ts'
import { blockMarkdown } from '../src/shared/marked-blocks.ts'
import { markedGithubFootnote } from '../src/shared/marked-footnotes.ts'
import { defaultNoteSyntax, noteLexer } from '../src/shared/note-syntax.ts'

const syntax = { ...defaultNoteSyntax, math: true, textExtras: true }
const markers = new Set(['==', '![[', '[[', '$', '~', '[^'])
const exporter = () =>
  new Marked(
    blockMarkdown,
    obsidianMarkdown,
    mathTokens,
    textExtrasMarkdown,
    markedGithubFootnote(),
  )
function read(source, operation) {
  if (operation === 'count') return richText(source, syntax)
  return exporter().parse(source)
}
const cases = [
  ['lone dollars', 'a $ b '],
  ['currency', 'a $5 and $6 '],
  ['missing wiki closer', '![[a '],
  ['missing highlight closer', '==a '],
]
for (const [name, unit] of cases)
  for (const operation of ['count', 'export']) {
    test(`${name} ${operation} inspects linear inline source units`, (t) => {
      for (const n of [32, 64, 128]) {
        const source = unit.repeat(n)
        const indexOf = String.prototype.indexOf,
          exec = RegExp.prototype.exec,
          charCodeAt = String.prototype.charCodeAt
        let units = 0
        const probes = [
          t.mock.method(
            String.prototype,
            'indexOf',
            function (marker, from = 0) {
              const at = indexOf.call(this, marker, from)
              if (markers.has(marker))
                units += (at < 0 ? this.length : at + marker.length) - from
              return at
            },
          ),
          t.mock.method(String.prototype, 'charCodeAt', function (at) {
            units++
            return charCodeAt.call(this, at)
          }),
          t.mock.method(RegExp.prototype, 'exec', function (text) {
            // These unbounded Obsidian regexes preceded the shared forward readers.
            if (
              this.source === '^(!?)\\[\\[([^\\]\\r\\n]+)\\]\\]' ||
              this.source === '^==(\\S(?:[^\\r\\n]*?\\S)?)=='
            )
              units += text.length
            return exec.call(this, text)
          }),
        ]
        let result
        try {
          result = read(source, operation)
        } finally {
          for (const probe of probes) probe.mock.restore()
        }
        assert.equal(
          result,
          operation === 'count' ? '\n' + source : `<p>${source}</p>\n`,
        )
        assert.ok(
          units <= source.length * 40,
          `${units} inspected / ${source.length} source units`,
        )
      }
    })
    test(`one MiB ${name} ${operation} stays under 20 cpu seconds`, (t) => {
      const source = unit.repeat(Math.ceil(2 ** 20 / unit.length))
      const start = process.cpuUsage()
      assert.equal(
        read(source, operation),
        operation === 'count' ? '\n' + source : `<p>${source}</p>\n`,
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

test('Obsidian candidates survive consumed, absent, nested and consecutive runs', () => {
  for (const source of [
    'first **==mark== ![[file|label]]** tail ==last== [[next]]',
    'none\n\n==mark== ![[file]]',
    '[==mark==](url) ==last== ![[file]]',
  ]) {
    assert.match(read(source, 'export'), /<mark>/)
    assert.match(read(source, 'count'), /mark/)
    assert.ok(noteLexer(source).tokens.length > 0)
  }
})
