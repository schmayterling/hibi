import assert from 'node:assert/strict'
import test from 'node:test'
import { Marked } from 'marked'
import { micromark } from 'micromark'
import { gfmHtml, gfm as gfmSyntax } from 'micromark-extension-gfm'
import { blockMarkdown } from '../src/shared/marked-blocks.ts'
import { markedGithubFootnote } from '../src/shared/marked-footnotes.ts'

const code = (html) =>
  (html.match(/<pre><code[^>]*>[\s\S]*?<\/code><\/pre>/g) ?? []).map((block) =>
    block.replace(/^<pre><code[^>]*>/, '').replace(/<\/code><\/pre>$/, ''),
  )
const oracle = (source) =>
  code(
    micromark(source, {
      extensions: [gfmSyntax()],
      htmlExtensions: [gfmHtml()],
    }).replaceAll('\r\n', '\n'),
  )
// Each tab to its next four-column stop.
const expand = (source) =>
  source
    .split('\n')
    .map((line) => {
      let text = ''
      for (const char of line)
        text += char === '\t' ? ' '.repeat(4 - (text.length % 4)) : char
      return text
    })
    .join('\n')

test('a footnote bounding probe inside a tabbed quote keeps the quote rows', () => {
  // A footnote definition bounds its body with a separate lexer that shares
  // the parser's options. Its reads are no rows of the quote around it.
  for (const sample of [
    '>\t[^1]: note\n>\n> para\n>\n>\t\t\tcode\n>\n> \tz',
    '>\t> [^1]: note\n>\t>\n>\t> para\n>\t>\n>\t>\t\t\tcode\n>\t>\n>\t> x\n>\t>  \tz',
  ])
    for (const eol of ['\n', '\r\n']) {
      const source = sample.replaceAll('\n', eol)
      const markdown = new Marked(
        { gfm: true },
        blockMarkdown,
        markedGithubFootnote(),
      )
      assert.deepEqual(code(markdown.parse(source)), oracle(source), source)
    }
})

test('a list re-read in a tabbed nested quote keeps the quote markers', () => {
  // Marked splices a re-read list into the quote's raw by the list's length.
  // Counted with a widened tab's spaces, the cut took the nested quote's own
  // marker, and the enclosing quote's re-read of that raw found no quote.
  for (const sample of ['>> >\t*\n>>1\nh', '>>>-\n>> >\t|\n>>~\nl'])
    for (const eol of ['\n', '\r\n']) {
      const source = sample.replaceAll('\n', eol)
      const markdown = new Marked({ gfm: true }, blockMarkdown)
      assert.equal(
        markdown.parse(source),
        markdown.parse(expand(source)),
        source,
      )
    }
})

test('fence bodies remove the opening indentation by column', () => {
  // Marked removes it by character, so a tab that starts inside it vanished
  // whole, and a tab after a short run of spaces stayed whole.
  for (const fence of ['```', '~~~'])
    for (const indent of [1, 2, 3])
      for (const line of [
        '\tx',
        ' \tx',
        '  \tx',
        '   \tx',
        '\t\tx',
        ' \t x',
        'x\ty',
      ])
        for (const eol of ['\n', '\r\n']) {
          const open = ' '.repeat(indent) + fence
          const source = [open, line, open].join(eol)
          const markdown = new Marked({ gfm: true }, blockMarkdown)
          assert.deepEqual(code(markdown.parse(source)), oracle(source), source)
        }
})

test('reference definitions take tabs between their parts', () => {
  // CommonMark separates a definition's label, destination and title with
  // spaces or tabs; Marked's rule took spaces only.
  for (const definition of [
    '[a]:\t/u',
    '[a]: /u\t"t"',
    '[a]:\t/u\t"t"\t',
    '[a]: /u\t',
    '[a]:\n\t/u\n\t"t"',
  ])
    for (const prefix of ['', '> '])
      for (const eol of ['\n', '\r\n']) {
        const source = `${definition
          .split('\n')
          .map((line) => prefix + line)
          .join(eol)}${eol}${eol}[a]`
        const link = /<a href="([^"]*)"(?: title="([^"]*)")?>a<\/a>/.exec(
          micromark(source, {
            extensions: [gfmSyntax()],
            htmlExtensions: [gfmHtml()],
          }),
        )
        const { links } = new Marked({ gfm: true }, blockMarkdown).lexer(source)
        assert.equal(links.a?.href ?? null, link?.[1] ?? null, source)
        assert.equal(links.a?.title || null, link?.[2] ?? null, source)
      }
})
