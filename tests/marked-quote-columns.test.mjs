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

test('a list re-read in a nested quote keeps every line', () => {
  // Marked cuts the old list's length out of the quote's raw, whose lines hold
  // markers the list's text does not, and pastes the new list over the rest.
  // The enclosing quote's re-read of that raw lost lines, or read a list number
  // from what the cut left.
  for (const sample of [
    '> > - one\n> > - two\n> three\nfour',
    '>\t>\t- one\n>\t>\t- two\n>\tthree\nfour',
    '>\t>\t1. one\n>\t>\t   two\n>\t>\t1. three\n>\t>\t   four\n>\tfive\nsix',
    '>>>\t-\tone\n>\t>  >\t  - two\n> > \t\tthree\n> four',
    '>>[!E]\n>>>one\n>  >\t1. two\n>>three\nfour',
    '>\t- one\ntwo\n  >\t\nthree',
  ])
    for (const eol of ['\n', '\r\n']) {
      const source = sample.replaceAll('\n', eol)
      const html = new Marked(blockMarkdown, alertMarkdown).parse(source)
      const words = html.replace(/<[^>]*>/g, ' ').match(/[a-z]{3,}/g)
      const expected = sample.match(/[a-z]{3,}/g)
      assert.deepEqual(words, expected, source)
    }
  const html = new Marked(blockMarkdown, alertMarkdown).parse(
    '>>[!E]\n>>>]\n>  >\t1. m\n>>=\n"',
  )
  assert.match(html, /<ol>/)
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

test('blank quote bodies cannot admit lazy paragraph lines', () => {
  // CommonMark §§2.2, 5.1: only spaces/tabs make a blank quote body.
  for (const source of [
    '>  \noutside',
    '>\t\noutside',
    '> \t\noutside',
    '  > \t\noutside',
    '> \u00a0\noutside',
  ])
    for (const eol of ['\n', '\r\n']) {
      const text = source.replaceAll('\n', eol)
      assert.equal(
        new Marked(blockMarkdown).parse(text).trimEnd(),
        micromark(text).replaceAll('\r\n', '\n').trimEnd(),
        text,
      )
    }
})

test('restated outer markers keep lazy nested quotes in one container', () => {
  // Marked #4175; CommonMark §5.1 keeps the restated outer container.
  for (const tail of ['c', '# heading', '---', '- item']) {
    const source = '> > a\nb\n>\n> ' + tail
    assert.equal(
      new Marked(blockMarkdown).parse(source).trimEnd(),
      micromark(source).replaceAll('<hr />', '<hr>').trimEnd(),
      source,
    )
  }
})

test('a gfm table ends lazy quote continuation', () => {
  // Marked #4161: laziness continues paragraphs, never a table.
  for (const source of [
    '> | a | b |\n> | - | - |\n> | x | y |\noutside',
    '> a | b\n> --- | ---\n> x | y\noutside',
    '> > | a | b |\n> > | - | - |\n> > | x | y |\noutside',
  ]) {
    const html = micromark(source, {
      extensions: [gfmSyntax()],
      htmlExtensions: [gfmHtml()],
    })
    const compact = (html) => html.replace(/>\n(?=<)/g, '>').trimEnd()
    assert.equal(
      compact(new Marked(blockMarkdown).parse(source)),
      compact(html),
      source,
    )
  }
})

test('native alert reads preserve literal code tabs, short or long', () => {
  // Marked #4110 expands body tabs too; CommonMark §§2.2, 4.5 preserve them.
  for (const padding of [0, 40]) {
    const source =
      '> [!NOTE]\n' + '> a\n'.repeat(padding) + '> ```\n> \tx\n> ```'
    assert.equal(
      readNativeQuote(source).text,
      '[!NOTE]\n' + 'a\n'.repeat(padding) + '```\n\tx\n```',
      source,
    )
    assert.deepEqual(
      code(new Marked(blockMarkdown, alertMarkdown).parse(source)),
      oracle(source),
      source,
    )
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
