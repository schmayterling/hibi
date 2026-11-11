import assert from 'node:assert/strict'
import test from 'node:test'
import { Marked } from 'marked'
import {
  blockMarkdown,
  blockScanCounters,
} from '../src/shared/marked-blocks.ts'

for (const underline of ['===', '=']) {
  test(`lazy list ${underline} candidates have bounded scan work`, () => {
    for (const count of [32, 64, 128]) {
      const source = '- a\n' + `b\n${underline}\n`.repeat(count)
      blockScanCounters.calls = blockScanCounters.units = 0
      const tokens = new Marked(blockMarkdown).lexer(source)
      assert.equal(tokens.length, 1)
      assert.equal(tokens[0].items[0].tokens.length, 1)
      assert.equal(tokens[0].items[0].tokens[0].type, 'text')
      assert.ok(
        blockScanCounters.units <= source.length * 2,
        `${blockScanCounters.units} scan units / ${source.length} source units`,
      )
    }
  })

  test(`lazy list ${underline} merges inspect bounded raw text`, (t) => {
    for (const count of [32, 64, 128]) {
      const source = '- a\n' + `b\n${underline}\n`.repeat(count)
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
      try {
        const [list] = new Marked(blockMarkdown).lexer(source)
        assert.equal(list.items[0].text, source.slice(2).trimEnd())
        assert.equal(list.items[0].tokens[0].text, source.slice(2).trimEnd())
        assert.equal(list.items[0].tokens[0].raw, list.items[0].text)
      } finally {
        probe.mock.restore()
      }
      assert.ok(
        units <= source.length * 4,
        `${units} raw units / ${source.length} source units`,
      )
    }
  })

  test(`one MiB lazy list ${underline} stays under 20 cpu seconds`, () => {
    const unit = `b\n${underline}\n`
    const source = '- a\n' + unit.repeat(Math.ceil(2 ** 20 / unit.length))
    const start = process.cpuUsage()
    const tokens = new Marked(blockMarkdown).lexer(source)
    const { user, system } = process.cpuUsage(start)
    assert.equal(tokens.length, 1)
    assert.equal(tokens[0].raw, source)
    assert.equal(tokens[0].items[0].tokens.length, 1)
    assert.equal(tokens[0].items[0].tokens[0].type, 'text')
    assert.ok(
      user + system < 20_000_000,
      `${(user + system) / 1e6} cpu seconds`,
    )
  })
}
