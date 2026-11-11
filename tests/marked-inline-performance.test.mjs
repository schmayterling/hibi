import assert from 'node:assert/strict'
import test from 'node:test'
import { Marked } from 'marked'
import { mathTokens } from '../src/addons/math/syntax.ts'
import { textExtrasMarkdown } from '../src/addons/text-extras/syntax.ts'
import { countText } from '../src/addons/word-count/count.ts'
import { richText } from '../src/addons/word-count/formatted-text.ts'
import { blockMarkdown } from '../src/shared/marked-blocks.ts'
import { markedGithubFootnote } from '../src/shared/marked-footnotes.ts'
import { defaultNoteSyntax } from '../src/shared/note-syntax.ts'

const syntax = {
  ...defaultNoteSyntax,
  alerts: true,
  math: true,
  textExtras: true,
}
const markers = new Set(['[^', '$', '~', '==', '![['])

for (const [name, prefix, unit, suffix] of [
  ['paragraph', '', 'b\n===x\n', ''],
  ['quote', '> a\n', 'b\n===\n', ''],
  ['list', '- a\n', 'b\n===\n', ''],
  [
    'distant candidates',
    '',
    'a == b ',
    'ref[^1] $x$ ~sub~ ==mark== ![[embed]]\n\n[^1]: note',
  ],
]) {
  test(`${name} inline hints inspect bounded source units`, (t) => {
    for (const count of [32, 64, 128]) {
      const source = prefix + unit.repeat(count) + suffix
      const indexOf = String.prototype.indexOf
      let units = 0
      const probe = t.mock.method(
        String.prototype,
        'indexOf',
        function (marker, from = 0) {
          const at = indexOf.call(this, marker, from)
          if (markers.has(marker))
            units += (at < 0 ? this.length : at + marker.length) - from
          return at
        },
      )
      let result
      try {
        result = richText(source, syntax)
      } finally {
        probe.mock.restore()
      }
      if (!suffix)
        assert.equal(
          result.trim(),
          (prefix ? 'a ' : '') +
            unit.repeat(count).trim().replaceAll('\n', ' '),
        )
      else assert.ok(result.endsWith('ref  sub mark \nnote'), result)
      assert.ok(
        units <= source.length * 20,
        `${units} hint units / ${source.length} source units`,
      )
    }
  })

  test(`one MiB ${name} count stays under 20 cpu seconds`, () => {
    const count = Math.ceil(2 ** 20 / unit.length)
    const source = prefix + unit.repeat(count) + suffix
    const start = process.cpuUsage()
    const text = richText(source, syntax)
    const result = countText(text)
    const { user, system } = process.cpuUsage(start)
    if (!suffix)
      assert.equal(
        text.trim(),
        (prefix ? 'a ' : '') + unit.repeat(count).trim().replaceAll('\n', ' '),
      )
    assert.ok(result.words >= count)
    assert.ok(
      user + system < 20_000_000,
      `${(user + system) / 1e6} cpu seconds`,
    )
  })
}

test('exporter inline hints also bound absent footnotes, math and subscript', (t) => {
  const source = '[bad] b\n'.repeat(128)
  const indexOf = String.prototype.indexOf
  let units = 0
  const probe = t.mock.method(
    String.prototype,
    'indexOf',
    function (marker, from = 0) {
      const at = indexOf.call(this, marker, from)
      if (markers.has(marker))
        units += (at < 0 ? this.length : at + marker.length) - from
      return at
    },
  )
  let html
  try {
    html = new Marked(
      blockMarkdown,
      markedGithubFootnote(),
      mathTokens,
      textExtrasMarkdown,
    ).parse(source)
  } finally {
    probe.mock.restore()
  }
  assert.equal(html, `<p>${source.trimEnd()}</p>\n`)
  assert.ok(
    units <= source.length * 20,
    `${units} hint units / ${source.length} source units`,
  )
})

test('inline hints keep separate paragraphs and nested runs independent', () => {
  for (const source of [
    'plain == text **bold $x$** ref[^1] ~sub~\n\n[^1]: note',
    '[a $x$ ~sub~ ==mark==](url) tail $y$ ~end~ ==last==',
    'missing\n\nref[^1] $x$ ~sub~ ==mark==\n\n[^1]: note',
    '**ref[^1] $x$ ~sub~ ==mark==** tail\n\n[^1]: note',
  ]) {
    const result = richText(source, syntax)
    assert.ok(
      !result.includes('$') &&
        !result.includes('~') &&
        !result.includes('[^1]'),
      result,
    )
    assert.match(result, /sub/)
  }
})
