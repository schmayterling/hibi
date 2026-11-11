import assert from 'node:assert/strict'
import test from 'node:test'
import { Lexer, Marked } from 'marked'
import { micromark } from 'micromark'
import { gfm, gfmHtml } from 'micromark-extension-gfm'
import {
  BlockTokenizer,
  blockMarkdown,
  continuationTokens,
} from '../src/shared/marked-blocks.ts'
import { markedGithubFootnote } from '../src/shared/marked-footnotes.ts'

const parser = () => new Marked(blockMarkdown, markedGithubFootnote())
const oracle = (source) =>
  micromark(source, { extensions: [gfm()], htmlExtensions: [gfmHtml()] })
const body = (html) =>
  html
    .match(
      /<ol>\s*<li id="(?:user-content-)?fn-(?:1|2|a)">\s*([\s\S]*)\n<\/li>\s*<\/ol>/,
    )?.[1]
    .replace(/\s*<a [^>]*data-footnote-backref[^>]*>[\s\S]*?<\/a>/g, '')
    .replaceAll('user-content-fn-', 'fn-')
    .replace(/>\s+</g, '><')
    .replace(/\s+/g, ' ')
    .trim()

test('empty first lines and later definitions retain independent lazy ownership', () => {
  for (const definition of [
    '[^1]:\n    f\n===',
    '[^1]: f\n===\n\n[^2]: g\n    ===',
  ]) {
    const source = 'x[^1] y[^2]\n\n' + definition
    assert.equal(body(parser().parse(source)), body(oracle(source)), source)
  }
})

for (const prefix of ['', '- a\n\n']) {
  for (const continuation of [
    '===',
    ' ===',
    '   ===',
    '===\nlazy',
    'lazy\n===',
    '    ===',
    '\t===',
    '---',
    '    ---',
    '# outside',
    '    # inside',
    '2. lazy',
    '1. outside',
    '    - nested\n      ===',
    '```\nx\n```',
    '\n    second\n===',
    '\n===',
  ]) {
    const definition = '[^1]: f\n' + continuation
    const source = 'x[^1]\n\n' + prefix + definition
    test(`footnote lazy continuation ${JSON.stringify(prefix + definition)} matches micromark`, () => {
      const html = parser().parse(source)
      const expected = oracle(source)
      assert.ok(body(expected), expected)
      assert.equal(body(html), body(expected), source)
      assert.equal(
        (html.match(/<h1>/g) ?? []).length,
        (expected.match(/<h1>/g) ?? []).length,
        source,
      )
      assert.equal(
        (html.match(/<hr>/g) ?? []).length,
        (expected.match(/<hr\s*\/?>/g) ?? []).length,
        source,
      )
    })
  }
}

for (const prefix of [
  '- a\n  ===\n',
  '- a\n    ===\n',
  '- a\n    ---\n',
  '1. a\n    ===\n',
])
  for (const text of [
    'g\nlazy\n    ===',
    'g\n\t===',
    'g\n    h\n\t===',
    'g\nlazy\n\t===',
  ]) {
    const source = prefix + '[^2]: ' + text + '\n\nx[^2]'
    test(`footnote after setext list ${JSON.stringify(prefix + text)} keeps its heading`, () => {
      const expected = body(oracle(source))
      assert.match(expected, /^<h1>/)
      assert.equal(body(parser().parse(source)), expected, source)
    })
  }

test('a separating blank keeps footnote ownership independent', () => {
  for (const prefix of ['', '- a\n    ===\n\n'])
    for (const text of [
      'g\nlazy\n    ===',
      'g\n\t===',
      'g\n    h\n\t===',
      'g\nlazy\n\t===',
    ]) {
      const source = prefix + '[^2]: ' + text + '\n\nx[^2]'
      assert.equal(body(parser().parse(source)), body(oracle(source)), source)
    }
})

test('throwing continuation reads restore lexer state and block reader', () => {
  const lexer = new Lexer({ tokenizer: new BlockTokenizer() })
  const read = lexer.blockTokens
  lexer.state.top = false
  assert.throws(
    () =>
      continuationTokens(lexer, '[^1]: f\n===', 'f\n===', () => {
        throw new Error('stopped body')
      }),
    /stopped body/,
  )
  assert.equal(lexer.state.top, false)
  assert.equal(lexer.blockTokens, read)
  assert.equal(lexer.lex('fresh\n===')[0].type, 'heading')
})

test('footnotes after list headings keep indented and lazy columns distinct', () => {
  for (const indent of ['', ' ', '  ', '   ', '    ', '\t']) {
    const source =
      '- a\n  ===\n[^2]: g\nlazy\n' +
      indent +
      '===\n[^3]: next\n    ===\n\nx[^2] y[^3]'
    assert.equal(body(parser().parse(source)), body(oracle(source)), source)
  }
})

for (const prefix of [
  '- a\n  - b\n    ===\n',
  '- a\n  1. b\n     ===\n',
  '- a\n  - b\n    - c\n      ===\n',
  '- a\n  > - b\n  >   ===\n',
  '- a\n  > - b\n  >   - c\n  >     ===\n',
  '- a\n  > > - b\n  > >   ===\n',
  '- a\n  > - b\n  >   > - c\n  >   >   ===\n',
  '- a\n  > q\n',
  '- a\n  > > q\n',
  '- a\n  > - b\n  >   > q\n',
])
  for (const text of ['g\nlazy\n    ===', 'g\n\t===', 'g\n    h\n \t===']) {
    test('nested footnote columns ' + JSON.stringify(prefix + text), () => {
      const source = prefix + '[^2]: ' + text + '\n\nx[^2]'
      assert.equal(body(parser().parse(source)), body(oracle(source)), source)
    })
  }

test('duplicate footnote markers keep their physical quote ownership', () => {
  const source = '- a\n  > - b\n  >   ===\n[^2]: g\n    ===\n\nx[^2]'
  assert.equal(body(parser().parse(source)), body(oracle(source)), source)
  const duplicate =
    '- a\n  > - b\n  >   ===\n  > [^2]: g\n  >     ===\n[^2]: g\n===\n\nx[^2]'
  // Main also loses inline text in this duplicate case; guard column ownership.
  const heading = (html) => body(html)?.match(/^<h[12]>/)?.[0]
  assert.equal(
    heading(parser().parse(duplicate)),
    heading(oracle(duplicate)),
    duplicate,
  )
})
