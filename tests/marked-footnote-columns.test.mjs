import assert from 'node:assert/strict'
import test from 'node:test'
import { Marked } from 'marked'
import { micromark } from 'micromark'
import { gfm, gfmHtml } from 'micromark-extension-gfm'
import {
  blockMarkdown,
  quoteColumnCounters,
} from '../src/shared/marked-blocks.ts'
import { markedGithubFootnote } from '../src/shared/marked-footnotes.ts'

const exported = (source) =>
  new Marked(blockMarkdown, markedGithubFootnote()).parse(source)
const oracle = (source) =>
  micromark(source, { extensions: [gfm()], htmlExtensions: [gfmHtml()] })
// Document shape without ids, links or whitespace at paragraph edges; code
// blocks keep their text exactly.
const shape = (html) =>
  html
    .replace(/<a [^>]*data-footnote-backref[^>]*>[\s\S]*?<\/a>/g, '')
    .replace(/<sup>[\s\S]*?<\/sup>/g, '^')
    .replace(/<h2[^>]*>Footnotes<\/h2>/, '')
    .replace(/<(\/?\w+)[^>]*>/g, '<$1>')
    .replace(
      /<p>([\s\S]*?)<\/p>/g,
      (_, text) => `<p>${text.replace(/\s+/g, ' ').trim()}</p>`,
    )
    .replace(/>\s+</g, '><')
    .trim()

test('footnote definitions in quotes read tabs at their columns in the note', () => {
  for (const source of [
    // A tab after `> ` reaches column 4 from column 2: two columns of indent.
    '> [^1]: \n> \tb\n\nx[^1]',
    '> [^1]: a\n> \tb\n\nx[^1]',
    // A tab right after `>` gives one column to the marker.
    '>\t[^1]: \n>\t\t\tx\n\nx[^1]',
    '>\t[^1]: a\n>\t\t\tb\n\nx[^1]',
    '>\t[^1]: a\n>\n>\t\t\tcode\n\nx[^1]',
    '> > [^1]: a\n> > \t\tcode\n\nx[^1]',
  ])
    assert.equal(shape(exported(source)), shape(oracle(source)), source)
})

test('footnote definitions in quotes keep their source extent', () => {
  for (const source of [
    '>\t[^1]: a\n>\t    b\n>\n> after\n\nx[^1]',
    '> [^1]: a\n> \tb\n>\n> after\n\nx[^1]',
    '> [^1]: a\n> \tb\n> # h\n\nx[^1]',
  ]) {
    const [quote] = new Marked(blockMarkdown, markedGithubFootnote()).lexer(
      source,
    )
    assert.equal(quote.raw, source.slice(0, source.indexOf('\n\n')), source)
    assert.equal(shape(exported(source)), shape(oracle(source)), source)
  }
})

test('footnote definitions in quotes keep their written text as raw', () => {
  const [quote] = new Marked(blockMarkdown, markedGithubFootnote()).lexer(
    '> [^1]: a\n> \tb\n> # h\n\nx[^1]',
  )
  assert.deepEqual(
    quote.tokens.map((token) => [token.type, token.raw]),
    [
      ['footnoteDef', '[^1]: a\n\tb\n'],
      ['heading', '# h'],
    ],
  )
})

test('footnote quote columns read only definition sources', () => {
  for (const count of [500, 4000]) {
    const source = '> # h\n> \tb\n'.repeat(count) + '> [^1]: a\n> \tb\n'
    quoteColumnCounters.units = 0
    new Marked(blockMarkdown, markedGithubFootnote()).lexer(source)
    assert.ok(
      quoteColumnCounters.units <= 64,
      `${quoteColumnCounters.units} units for ${source.length}`,
    )
  }
})

test('footnote quote columns read each definition once when one quote holds many', () => {
  const shapes = [
    (i) => `> para ${i} words\n>\n> [^${i}]: f${i}\n>\tg${i}\n>\n`,
    (i) => `> [^${i}]: f${i} words\n>\tg${i} more\n`,
  ]
  for (const unit of shapes)
    for (const count of [1000, 2000]) {
      const source = Array.from({ length: count }, (_, i) => unit(i)).join('')
      quoteColumnCounters.units = 0
      new Marked(blockMarkdown, markedGithubFootnote()).lexer(source)
      assert.ok(
        quoteColumnCounters.units <= source.length,
        `${quoteColumnCounters.units} units for ${source.length}`,
      )
    }
})
