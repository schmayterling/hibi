import assert from 'node:assert/strict'
import test from 'node:test'
import { Lexer, Marked, Tokenizer } from 'marked'
import { micromark } from 'micromark'
import { gfmHtml, gfm as gfmSyntax } from 'micromark-extension-gfm'
import { alertMarkdown } from '../src/addons/markdown/alerts.ts'
import { blockMarkdown, readNativeQuote } from '../src/shared/marked-blocks.ts'
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

test('a tab that comes in during a nested re-read keeps its lines in their quote', () => {
  // Counting those lines by the length of the lines the tab widened ended the
  // outer quote early, and the next quote read the alert's last line again.
  for (const sample of [
    '>>>[!E]\ny\ny\n>>\tq',
    '> > >[!NOTE]\n    y\ny\n>\t>\tq\n>>>```\ny\n',
  ])
    for (const eol of ['\n', '\r\n']) {
      const source = sample.replaceAll('\n', eol)
      const markdown = new Marked(blockMarkdown, alertMarkdown)
      const quotes = markdown
        .lexer(source)
        .filter((token) => token.type === 'blockquote')
      assert.equal(quotes.length, 1, source)
      const words = markdown.parse(source).replace(/<[^>]*>/g, '')
      assert.equal(words.split('q').length - 1, 1, source)
    }
})

test('a tabbed nested re-read leaves its last quote lines where Marked does', () => {
  // A last line that strips to nothing stays in the outer quote; it opens no
  // new quote after the nested one.
  for (const sample of ['>>~\n\t$\n>', '>>>]\ne\n> >\t', '>>.\n\t>\n>>\n>\t'])
    for (const eol of ['\n', '\r\n']) {
      const source = sample.replaceAll('\n', eol)
      assert.equal(
        new Marked(blockMarkdown).parse(source),
        new Marked().parse(source),
        source,
      )
    }
})

test('a nested alert whose list takes a lazy line opens no second quote', () => {
  // Its lines count from the quote it read, not from the alert's longer raw.
  for (const eol of ['\n', '\r\n']) {
    const source = ['> > [!NOTE]', '> > - d', 'more', '> >'].join(eol)
    const tokens = new Marked(blockMarkdown, alertMarkdown).lexer(source)
    assert.equal(tokens.length, 1, source)
  }
})

test('an alert reads the quote Marked reads, short or long', () => {
  const tokenizer = new Tokenizer()
  new Lexer({ gfm: true, tokenizer })
  const lines = '> a\n'.repeat(40)
  for (const source of [
    '> [!NOTE]\n> a\n>\tx\n\nafter\n',
    `> [!NOTE]\n${lines}>\tx\n`,
    `> [!NOTE]\n${lines}>\t\nlazy\n`,
    `> [!NOTE]\n${lines}>\t- x\n\nafter\n`,
  ]) {
    const { raw, text } = tokenizer.blockquote(source)
    const quote = readNativeQuote(source)
    assert.deepEqual(
      { raw: quote.raw, text: quote.text },
      { raw, text },
      source,
    )
  }
})
