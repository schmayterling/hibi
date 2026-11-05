import assert from 'node:assert/strict'
import test from 'node:test'
import { Lexer, Marked } from 'marked'
import { alertMarkdown } from '../src/addons/markdown/alerts.ts'
import { richText } from '../src/addons/word-count/formatted-text.ts'
import { blockMarkdown, readNativeQuote } from '../src/shared/marked-blocks.ts'
import { defaultNoteSyntax } from '../src/shared/note-syntax.ts'

const words = (text) => text.replace(/<[^>]*>/g, ' ').match(/\bw\d+w\b/g) ?? []
const samples = [
  '> [!NOTE]\n> > - a\n> > - b\n> c\nlazy',
  '> [!NOTE]\n> > b\nlazy',
  '> [!NOTE]\n> > w1w\n> > w2w\nw3w',
  '> >[!TIP]-\n>  > >+ w1w\n>> w2w\nw3w w4w w5w',
  ' > > [!IMPORTANT]\n    w1w w2w   \n> >\t\nw3w w4w w5w w6w ',
  '> > [!CAUTION]\n  w1w w2w w3w\n>\t> >  > \tw4w w5w w6w \n  w7w w8w w9w w10w   ',
  '> [!NOTE]\n> > - w1w\n> > - w2w\n> w3w\nw4w',
  ' >  > [!IMPORTANT]\n > > > - [ ] w1w w2w\n>> w3w w4w w5w\n>  >  > [ref4]: /x  \nw6w w7w w8w w9w',
]

for (const long of [false, true])
  test(`quote bodies keep one source quote level, ${long ? 'long' : 'short'} read`, () => {
    for (const sample of samples) {
      const source = long
        ? sample.replace('\n', `\n${'> padding\n'.repeat(40)}`)
        : sample
      for (const ending of ['', '\n']) {
        const input = source + ending
        const quote = readNativeQuote(input)
        assert.equal(
          quote.text,
          quote.raw.replace(/^ {0,3}>[ \t]?/gm, ''),
          input,
        )
      }
    }
  })

test('nested alert and callout bodies export and count each word in source order', () => {
  const parser = new Marked(blockMarkdown, alertMarkdown)
  for (const sample of samples)
    for (const fold of ['', '+', '-'])
      for (const eol of ['\n', '\r\n']) {
        const source = sample
          .replace('[!NOTE]', `[!NOTE]${fold}`)
          .replaceAll('\n', eol)
        assert.deepEqual(words(parser.parse(source)), words(source), source)
        assert.deepEqual(
          words(richText(source, { ...defaultNoteSyntax, alerts: true })),
          words(source),
          source,
        )
      }
})

test('nested alerts keep every level without repeating boundary reads', () => {
  const read = Lexer.prototype.blockTokens
  let calls = 0
  Lexer.prototype.blockTokens = function (...args) {
    calls++
    return Reflect.apply(read, this, args)
  }
  try {
    for (const lazy of [false, true])
      for (const depth of [8, 16, 32]) {
        let source = ''
        for (let level = 1; level <= depth; level++) {
          const prefix = '> '.repeat(level)
          source += `${prefix}[!NOTE]\n${prefix}w${level}w\n`
          if (lazy) source += `w${depth + level}w\n`
        }
        calls = 0
        const html = new Marked(blockMarkdown, alertMarkdown).parse(source)
        assert.deepEqual(words(html), words(source), source)
        assert.equal(html.match(/class="github-alert"/g)?.length, depth)
        assert.ok(
          calls <= (lazy ? 12 : 3) * depth,
          `${depth} levels: ${calls} block reads`,
        )
      }
  } finally {
    Lexer.prototype.blockTokens = read
  }
})

test('equal-sized alert siblings and later notes retain their own words', () => {
  const parser = new Marked(blockMarkdown, alertMarkdown)
  const source =
    '> [!NOTE]\n> > [!TIP]\n> > w1w\n\n> [!NOTE]\n> > [!TIP]\n> > w2w'
  for (const input of [source, source.replace('w1w', 'w3w'), source])
    assert.deepEqual(words(parser.parse(input)), words(input), input)
})

test('cached alert boundaries cannot inherit a known reference definition', () => {
  const source =
    '> [!NOTE]\n>\n> [r]: /x\n> > [!TIP]\n> >\n> >      - w1w\n> > [r]: /x  \n> w2w\n> w3w'
  const html = new Marked(blockMarkdown, alertMarkdown).parse(source)
  const innerEnd = html.indexOf('</div></blockquote>')
  assert.deepEqual(words(html.slice(0, innerEnd)), ['w1w', 'w2w', 'w3w'])
  assert.deepEqual(words(html), words(source))
})

test('a nested quote body retains its physical tab columns', () => {
  const source = '>\t> \tw1w\n> >\tw2w\nw3w'
  const [quote] = new Marked(blockMarkdown).lexer(source)
  assert.equal(quote.text, '  > \tw1w\n>\tw2w\nw3w')
  assert.equal(quote.tokens[0].text, '\tw1w\nw2w\nw3w')
})

test('a repeated reference definition after code cannot swallow a quote row', () => {
  const parser = new Marked(blockMarkdown)
  for (const eol of ['\n', '\r\n']) {
    const source = '>>      - w1w\n>  > [r]: /x  \n> w2w\nw3w'.replaceAll(
      '\n',
      eol,
    )
    assert.deepEqual(words(parser.parse(source)), words(source), source)
    assert.deepEqual(
      words(richText(source, defaultNoteSyntax)),
      words(source),
      source,
    )
  }
})
