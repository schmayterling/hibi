import assert from 'node:assert/strict'
import test from 'node:test'
import { Marked } from 'marked'
import { alertMarkdown } from '../src/addons/markdown/alerts.ts'
import { mathTokens } from '../src/addons/math/syntax.ts'
import { textExtrasMarkdown } from '../src/addons/text-extras/syntax.ts'
import { typstTokens } from '../src/addons/typst/syntax.ts'
import { countText } from '../src/addons/word-count/count.ts'
import { richText } from '../src/addons/word-count/formatted-text.ts'
import { blockMarkdown } from '../src/shared/marked-blocks.ts'
import { markedGithubFootnote } from '../src/shared/marked-footnotes.ts'
import { defaultNoteSyntax } from '../src/shared/note-syntax.ts'

const unit = '> [!NOTE]\n> a\n'
const syntax = {
  ...defaultNoteSyntax,
  alerts: true,
  math: true,
  textExtras: true,
  typst: true,
  mermaid: true,
}
const read = (source, operation) => {
  if (operation === 'export')
    return new Marked(
      blockMarkdown,
      mathTokens,
      textExtrasMarkdown,
      alertMarkdown,
      markedGithubFootnote(),
      typstTokens,
    ).parse(source)
  const text = richText(source, syntax)
  return { text, words: countText(text).words }
}
function check(result, operation, count) {
  if (operation === 'export') {
    assert.equal((result.match(/<blockquote/g) ?? []).length, 1)
    assert.equal((result.match(/<p>/g) ?? []).length, 1)
    assert.equal((result.match(/\[!NOTE\]/g) ?? []).length, count - 1)
    assert.equal((result.match(/\ba\b/g) ?? []).length, count)
  } else {
    assert.equal(result.text.trim(), 'a [!NOTE] '.repeat(count - 1) + 'a')
    assert.equal(result.words, count * 2 - 1)
  }
}
for (const operation of ['export', 'count']) {
  test(`long alert ${operation} bounds absent inline candidate scans`, (t) => {
    for (const count of [32, 64, 128]) {
      const source = unit.repeat(count)
      const indexOf = String.prototype.indexOf
      let units = 0
      const probe = t.mock.method(
        String.prototype,
        'indexOf',
        function (marker, from = 0) {
          const at = indexOf.call(this, marker, from)
          if (marker === '[^' || marker === '$' || marker === '~')
            units += (at < 0 ? this.length : at + marker.length) - from
          return at
        },
      )
      let result
      try {
        result = read(source, operation)
      } finally {
        probe.mock.restore()
      }
      check(result, operation, count)
      assert.ok(
        units <= source.length * 20,
        `${units} hint units / ${source.length} source units`,
      )
    }
  })
  test(`one MiB long alert ${operation} stays under 20 cpu seconds`, (t) => {
    const count = Math.ceil(2 ** 20 / unit.length)
    const source = unit.repeat(count)
    const start = process.cpuUsage()
    const result = read(source, operation)
    const { user, system } = process.cpuUsage(start)
    check(result, operation, count)
    t.diagnostic(
      JSON.stringify({ cpuMs: (user + system) / 1000, bytes: source.length }),
    )
    assert.ok(
      user + system < 20_000_000,
      `${(user + system) / 1e6} cpu seconds`,
    )
  })
}
