import assert from 'node:assert/strict'
import test from 'node:test'
import { Marked } from 'marked'
import { alertMarkdown } from '../src/addons/markdown/alerts.ts'
import { richText } from '../src/addons/word-count/formatted-text.ts'
import { blockMarkdown } from '../src/shared/marked-blocks.ts'
import { defaultNoteSyntax } from '../src/shared/note-syntax.ts'

const words = (text) => text.replace(/<[^>]*>/g, ' ').match(/\bw\d+w\b/g) ?? []
test('a native EOF newline keeps alert body word identities', () => {
  const source = '>[!NOTE]\n>>>>1. w1w\n>> > \tw2w\n> \tw3w\n>>   >\tw4w\nw5w'
  const parser = new Marked(blockMarkdown, alertMarkdown)
  assert.deepEqual(words(parser.parse(source)), words(source))
  assert.deepEqual(
    words(richText(source, { ...defaultNoteSyntax, alerts: true })),
    words(source),
  )
})

const samples = [
  '> - w1w\nw2w',
  '> - w1w\nw2w\n> - w3w\nw4w',
  '> - w1w\nw2w\n> - w3w\nw4w\n> # w5w\nw6w',
  '> - w1w\nw2w\n> - w3w\nw4w\n> - w5w\nw6w\n> # w7w\n\nw8w',
  '> >  *\n>w1w\nw2w',
  '> - w1w\nw2w\n> - w3w\nw4w\n> w5w\nw6w\n\nw7w',
]

for (const alerts of [false, true])
  test(`list re-reads consume each source word once, alerts ${alerts}`, () => {
    const parser = new Marked(blockMarkdown, ...(alerts ? [alertMarkdown] : []))
    const syntax = { ...defaultNoteSyntax, alerts }
    for (const sample of samples)
      for (const prefix of alerts ? ['> [!NOTE]\n', '> [!TIP]-\n'] : [''])
        for (const eol of ['\n', '\r\n']) {
          const source = (prefix + sample).replaceAll('\n', eol)
          const expected = words(source)
          assert.deepEqual(words(parser.parse(source)), expected, source)
          assert.deepEqual(words(richText(source, syntax)), expected, source)
          let rest = source.replaceAll('\r\n', '\n')
          for (const token of parser.lexer(source)) {
            assert.ok(
              rest.startsWith(token.raw),
              JSON.stringify({ source, raw: token.raw, rest }),
            )
            rest = rest.slice(token.raw.length)
          }
          assert.equal(rest, '', source)
        }
  })
