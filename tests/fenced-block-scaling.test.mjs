import assert from 'node:assert/strict'
import test from 'node:test'
import { Lexer, Marked } from 'marked'
import { fencedBlock, fenceSource } from '../src/addons/_shared/fenced-block.ts'

test('fenced tokenization never lexes unrelated document tails', () => {
  const original = Lexer.prototype.lex
  let calls = 0,
    units = 0
  Lexer.prototype.lex = function (source) {
    calls++
    units += source.length
    return original.call(this, source)
  }
  try {
    const parse = fencedBlock('mermaid', 'mermaidBlock')
    const block = '\x60\x60\x60mermaid\ngraph TD; A-->B\n\x60\x60\x60\n'
    const tail = 'ordinary paragraph\n\n'.repeat(10000)
    assert.deepEqual(parse(block + tail), {
      type: 'mermaidBlock',
      raw: block,
      source: 'graph TD; A-->B',
    })
    assert.equal(calls, 0, String(units))
  } finally {
    Lexer.prototype.lex = original
  }
})

test('native fence grammar and first-block spelling stay compatible', () => {
  const parse = fencedBlock('mermaid', 'mermaidBlock')
  for (const source of [
    '\x60\x60\x60mermaid\ngraph TD\n\x60\x60\x60\n\nrest',
    '   \x60\x60\x60\x60MERMAID\n   graph TD\n   \x60\x60\x60\x60\x60\n',
    '~~~mermaid\na\n~~~~\ntail',
    '\x60\x60\x60mermaid\nunclosed',
    '\x60\x60\x60javascript\nx\n\x60\x60\x60\n',
    '\x60\x60\x60mermaid extra\na\n\x60\x60\x60\n',
    '\x60\x60\x60mermaid\n\n\x60\x60\x60',
    '    \x60\x60\x60mermaid\nindented',
    'ordinary text\n\x60\x60\x60mermaid\na\n\x60\x60\x60',
  ]) {
    const token = /^ {0,3}(?:\x60{3,}|~{3,})/.test(source)
      ? new Marked().lexer(source)[0]
      : undefined
    const expected =
      token?.type === 'code' && token.lang?.toLowerCase() === 'mermaid'
        ? { type: 'mermaidBlock', raw: token.raw, source: token.text }
        : undefined
    assert.deepEqual(parse(source), expected, source)
  }
})

test('large fence content chooses delimiters without an argument-count ceiling', () => {
  const content = '\x60 '.repeat(200000) + '\x60\x60\x60\x60'
  const source = fenceSource('mermaid', content)
  assert.equal(
    source,
    '\x60\x60\x60\x60\x60mermaid\n' + content + '\n\x60\x60\x60\x60\x60',
  )
})
