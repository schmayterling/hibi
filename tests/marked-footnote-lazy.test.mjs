import assert from 'node:assert/strict'
import test from 'node:test'
import { Marked } from 'marked'
import { micromark } from 'micromark'
import { gfm, gfmHtml } from 'micromark-extension-gfm'
import { blockMarkdown } from '../src/shared/marked-blocks.ts'
import { markedGithubFootnote } from '../src/shared/marked-footnotes.ts'

const parser = () => new Marked(blockMarkdown, markedGithubFootnote())
const oracle = (source) =>
  micromark(source, { extensions: [gfm()], htmlExtensions: [gfmHtml()] })
const body = (html) =>
  html
    .match(
      /<ol>\s*<li id="(?:user-content-)?fn-(?:1|a)">\s*([\s\S]*)\n<\/li>\s*<\/ol>/,
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
