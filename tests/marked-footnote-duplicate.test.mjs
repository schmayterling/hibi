import assert from 'node:assert/strict'
import test from 'node:test'
import { Marked } from 'marked'
import { micromark } from 'micromark'
import { gfm, gfmHtml } from 'micromark-extension-gfm'
import { blockMarkdown } from '../src/shared/marked-blocks.ts'
import { markedGithubFootnote } from '../src/shared/marked-footnotes.ts'

const body = (html) =>
  /<li id="(?:user-content-)?fn-[^"]+">([\s\S]*?)\s*<a href/
    .exec(html)?.[1]
    .replace(/\n/g, '')
const oracle = (source) =>
  body(micromark(source, { extensions: [gfm()], htmlExtensions: [gfmHtml()] }))

// A quote re-reads its lazy lines, so the first definition is read twice.
const reread = [
  '> - b\n>   ===\n> [^2]: *g*\n[^2]: z\n\nx[^2]',
  '- a\n  > - b\n  >   ===\n  > [^2]: g\n  >     ===\n[^2]: g\n===\n\nx[^2]',
  '> - b\n>   ===\n> [^A]: *g*\n[^a]: z\n\nx[^a]',
  '> - b\n>   ===\n> [^2]: g\n>     ===\n[^2]: z\n\nx[^2]',
]

test('footnote definitions read again by a quote keep their body', () => {
  const markdown = new Marked(blockMarkdown, markedGithubFootnote())
  for (const source of [...reread, ...reread]) {
    const expected = oracle(source)
    assert.ok(expected, source)
    assert.equal(body(markdown.parse(source)), expected, source)
  }
})

test('footnote duplicates outside re-read containers keep the first body', () => {
  for (const source of [
    '[^2]: h\n[^2]: g\n\nx[^2]',
    '[^2]: *h*\n\n> [^2]: g\n\nx[^2]',
    '> [^2]: h\n\n[^2]: g\n===\n\nx[^2]',
  ])
    assert.equal(
      body(new Marked(blockMarkdown, markedGithubFootnote()).parse(source)),
      oracle(source),
      source,
    )
})

test('footnote definitions nested under their own label keep the nested body and an acyclic tree', () => {
  for (const source of [
    '[^1]: f\n\n    [^1]: g\n\nx[^1]',
    '> [^1]: f\n>\n>     [^1]: g\n\nx[^1]',
  ]) {
    let tokens
    const capture = {
      hooks: {
        processAllTokens(list) {
          tokens = list
          return list
        },
      },
    }
    const html = new Marked(
      blockMarkdown,
      markedGithubFootnote(),
      capture,
    ).parse(source)
    assert.equal(body(html), oracle(source), source)
    assert.doesNotThrow(() => JSON.stringify(tokens), source)
  }
})
