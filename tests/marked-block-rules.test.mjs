import assert from 'node:assert/strict'
import test from 'node:test'
import { Lexer, Marked } from 'marked'
import { blockMarkdown } from '../src/shared/marked-blocks.ts'

// Keep this check small: an unrecognised native rule otherwise reaches the
// recursive fallback before the large quote performance cases can finish.
for (const gfm of [false, true])
  test(`native ${gfm ? 'gfm' : 'normal'} quote rules use the incremental reader`, (t) => {
    const rule = Lexer.rules.block[gfm ? 'gfm' : 'normal'].blockquote
    const exec = RegExp.prototype.exec
    let fallback = 0
    t.mock.method(rule, 'exec', function (source) {
      fallback++
      return exec.call(this, source)
    })
    const source = '> a\n> b\nlazy\n\nend\n'
    const tokens = new Marked({ gfm }, blockMarkdown).lexer(source)
    assert.equal(tokens[0].raw, '> a\n> b\nlazy')
    assert.equal(
      fallback,
      0,
      'native quote rule was not recognised; whole-extent fallback ran',
    )
  })
