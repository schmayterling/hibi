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
