import assert from 'node:assert/strict'
import test from 'node:test'
import { Marked } from 'marked'
import { micromark } from 'micromark'
import { gfm, gfmHtml } from 'micromark-extension-gfm'
import { countText } from '../src/addons/word-count/count.ts'
import { richText } from '../src/addons/word-count/formatted-text.ts'
import { blockMarkdown } from '../src/shared/marked-blocks.ts'
import { markedGithubFootnote } from '../src/shared/marked-footnotes.ts'
import { defaultNoteSyntax } from '../src/shared/note-syntax.ts'

const exported = (source) =>
  new Marked(blockMarkdown, markedGithubFootnote()).parse(source)
const oracle = (source) =>
  micromark(source, { extensions: [gfm()], htmlExtensions: [gfmHtml()] })
// Section bodies and the document before the section, without ids and links.
const shape = (html) =>
  html
    .replace(/<a [^>]*data-footnote-backref[^>]*>[\s\S]*?<\/a>/g, '')
    .replace(/<sup>[\s\S]*?<\/sup>/g, '^')
    .replace(/<h2[^>]*>Footnotes<\/h2>/, '')
    .replace(/<(\/?\w+)[^>]*>/g, '<$1>')
    .replace(/\s+/g, '')

test('footnote definitions in quotes continue through lazy lines', () => {
  for (const source of [
    '> [^1]: f\ng\n\nx[^1]',
    '> [^1]: f\n===\n\nx[^1]',
    '> [^1]: *f*\ng\nh\n\nx[^1]',
    '> - [^1]: f\ng\n\nx[^1]',
    '> > [^1]: f\ng\n\nx[^1]',
    // Text after an empty definition in a tight item stays tight.
    '- [^1]:\n  b\n\nx[^1]',
    '- [^1]:\n- b\n\nx[^1]',
  ])
    assert.equal(shape(exported(source)), shape(oracle(source)), source)
})

test('footnote definitions with an empty first line take no lazy lines', () => {
  for (const source of [
    '[^1]:\nx\n\ny[^1]',
    '[^1]:\n  x\n\ny[^1]',
    '[^1]:\n    x\n\ny[^1]',
    '[^1]:\n\n    x\n\ny[^1]',
    '- [^1]:\n    x\n\ny[^1]',
    '> - [^1]:\n    x\n\ny[^1]',
    '- b\n> - [^1]:\n    x[^1] y[^2]\n- [^1]:\n\nx[^1] y[^2] z[^A] w[^a]',
  ]) {
    const section = (html) => shape(/<section[\s\S]*/.exec(html)?.[0] ?? '')
    assert.equal(section(exported(source)), section(oracle(source)), source)
  }
})

test('footnote export agrees with word count on lazy definition lines', () => {
  const words = (html) =>
    countText(
      html
        .replace(/<a [^>]*data-footnote-backref[^>]*>[\s\S]*?<\/a>/g, ' ')
        .replace(/<sup>[\s\S]*?<\/sup>/g, ' ')
        .replace(/<h2[^>]*>Footnotes<\/h2>/, ' ')
        .replace(/<[^>]+>/g, ' '),
    ).words
  for (const source of [
    '> [^1]: f\ng\n\nx[^1]',
    '> - b\n>   ===\n> [^2]: *g*\n[^3]: z\n\nx[^2] y[^3]',
    '[^1]:\n  x\n\ny[^1]',
    '- b\n> - [^1]:\n    x y\n- [^2]:\n\nx[^1] y[^2]',
  ])
    assert.equal(
      words(exported(source)),
      countText(richText(source, { ...defaultNoteSyntax, gfm: true }).slice(1))
        .words,
      source,
    )
})
