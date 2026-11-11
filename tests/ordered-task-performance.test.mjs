import assert from 'node:assert/strict'
import test from 'node:test'
import { countText } from '../src/addons/word-count/count.ts'
import { richText } from '../src/addons/word-count/formatted-text.ts'
import { defaultNoteSyntax } from '../src/shared/note-syntax.ts'

for (const loose of [false, true]) {
  const unit = `1. [x] done\n${loose ? '\n' : ''}`
  test(`${loose ? 'loose' : 'tight'} ordered task projection text work follows item text`, (t) => {
    for (const count of [32, 64, 128]) {
      const source = unit.repeat(count)
      const trim = String.prototype.trimStart
      let units = 0
      const probe = t.mock.method(String.prototype, 'trimStart', function () {
        units += this.length
        return trim.call(this)
      })
      let text
      try {
        text = richText(source, defaultNoteSyntax)
      } finally {
        probe.mock.restore()
      }
      assert.equal(countText(text).words, count)
      assert.equal(text.replaceAll('\n', ''), 'done'.repeat(count))
      assert.ok(
        units < source.length * 4,
        `${units} text units / ${source.length} source units`,
      )
    }
  })
  test(`one MiB ${loose ? 'loose' : 'tight'} task paragraphs stay under 20 cpu seconds`, () => {
    // ponytail: long bodies isolate projection work; dense tiny tasks hit Marked's
    // quadratic inlineQueue scan. Add a dense budget when that scan is bounded.
    const body = 'done '.repeat(1024).trimEnd()
    const paragraph = `1. [x] ${body}\n${loose ? '\n' : ''}`
    const count = Math.ceil(2 ** 20 / paragraph.length)
    const source = paragraph.repeat(count)
    const start = process.cpuUsage()
    const text = richText(source, defaultNoteSyntax)
    const result = countText(text)
    const { user, system } = process.cpuUsage(start)
    assert.equal(result.words, count * 1024)
    assert.equal(text.replaceAll('\n', ''), body.repeat(count))
    assert.ok(
      user + system < 20_000_000,
      `${(user + system) / 1e6} cpu seconds`,
    )
  })
}
