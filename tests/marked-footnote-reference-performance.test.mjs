import assert from 'node:assert/strict'
import test from 'node:test'
import { Marked } from 'marked'
import { markedGithubFootnote as upstream } from 'marked-github-footnote'
import { richText } from '../src/addons/word-count/formatted-text.ts'
import { blockMarkdown } from '../src/shared/marked-blocks.ts'
import { markedGithubFootnote } from '../src/shared/marked-footnotes.ts'
import { defaultNoteSyntax } from '../src/shared/note-syntax.ts'

const parse = (source) =>
  new Marked(blockMarkdown, markedGithubFootnote()).parse(source)
const unit = '[^'
for (const closed of [false, true])
  for (const operation of ['export', 'count']) {
    const sourceFor = (n) =>
      unit.repeat(n) + (closed ? ']' : '') + '\n\n[^ok]: note'
    const read = (source) =>
      operation === 'export'
        ? parse(source)
        : richText(source, defaultNoteSyntax)
    test(`dense footnote openers ${closed ? 'with' : 'without'} closer ${operation} inspect linear source units`, (t) => {
      for (const n of [32, 64, 128]) {
        const source = sourceFor(n),
          exec = RegExp.prototype.exec,
          charCodeAt = String.prototype.charCodeAt,
          lower = String.prototype.toLowerCase
        let units = 0
        const probes = [
          t.mock.method(RegExp.prototype, 'exec', function (text) {
            if (this.source === /^\[\^([^\]\s]+)\]/.source) units += text.length
            return exec.call(this, text)
          }),
          t.mock.method(String.prototype, 'charCodeAt', function (at) {
            units++
            return charCodeAt.call(this, at)
          }),
          t.mock.method(String.prototype, 'toLowerCase', function () {
            units += this.length
            return lower.call(this)
          }),
        ]
        let result
        try {
          result = read(source)
        } finally {
          for (const probe of probes) probe.mock.restore()
        }
        assert.equal(
          result,
          operation === 'export'
            ? `<p>${unit.repeat(n)}${closed ? ']' : ''}</p>\n`
            : '\n' + unit.repeat(n) + (closed ? ']' : '') + '\nnote',
        )
        assert.ok(
          units <= source.length * 20,
          `${units} inspected / ${source.length} source units`,
        )
      }
    })
    test(`one MiB dense footnotes ${closed ? 'with' : 'without'} closer ${operation} stays under 20 cpu seconds`, (t) => {
      const source = sourceFor(Math.ceil(2 ** 20 / unit.length)),
        start = process.cpuUsage()
      const result = read(source)
      assert.ok(result.includes(unit.repeat(32)))
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
test('count keeps references supplied by another source owner', () => {
  assert.equal(
    richText('hi[^ok]', {
      ...defaultNoteSyntax,
      references: { '\u0000footnote:ok': { href: '#footnote' } },
    }),
    '\nhi',
  )
})

test('reference suffixes, unicode casing, nested labels and documents match dependency', () => {
  const bounded = new Marked(blockMarkdown, markedGithubFootnote()),
    original = new Marked(blockMarkdown, upstream())
  for (const source of [
    '[^missing[^ok] [^OK] [^ok]\n\n[^ok]: note',
    '[^missing[^i̇] [^İ]\n\n[^İ]: note',
    '[^ΟΣ] [^ος] [^Ος]\n\n[^ΟΣ]: greek',
    '[^a[^b] [^b]\n\n[^a[^b]: outer\n[^b]: inner',
    '[^a\tb] [^a\u00a0b] [^]\n\n[^ok]: note',
    '**[^ok]** [x[^ok]](url) tail[^ok]\n\n[^ok]: note',
    '[^ok] no definition',
    '[^ok]\n\n[^ok]: new document',
  ])
    assert.equal(bounded.parse(source), original.parse(source), source)
})

test('virtual reference scopes retain their iterator and local definitions', () => {
  const definitions = { '\u0000footnote:ok': { href: '#footnote' } }
  const labels = () => Object.keys(definitions)[Symbol.iterator]()
  const references = new Proxy(Object.create(null), {
    get: (_, key) =>
      key === Symbol.iterator ? labels : Reflect.get(definitions, key),
  })
  assert.equal(
    richText('hi[^ok]', { ...defaultNoteSyntax, references }),
    '\nhi',
  )
  assert.equal(
    richText('hi[^local] hi[^ok]\n\n[^local]: here', {
      ...defaultNoteSyntax,
      references,
    }),
    '\nhi hi\nhere',
  )
})
