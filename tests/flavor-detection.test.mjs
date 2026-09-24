import assert from 'node:assert/strict'
import test from 'node:test'
import { Lexer, Marked } from 'marked'
import { alertMarker, alertStart } from '../src/addons/markdown/alerts.ts'
import { flavorInfo as github } from '../src/addons/markdown/github-flavor-info.ts'
import { mathFlavor, mathTokens } from '../src/addons/math/syntax.ts'
import {
  detectTextExtras,
  subtextStart,
  textExtrasMarkdown,
} from '../src/addons/text-extras/syntax.ts'
import { typstFlavor, typstTokens } from '../src/addons/typst/syntax.ts'

const detect = (parser, matches) => (source) => {
  let found = false
  parser.walkTokens(parser.lexer(source), (token) => {
    if (matches(token)) found = true
  })
  return found
}
const pairs = [
  [
    github.detect,
    detect(
      new Marked({ gfm: true }),
      (token) =>
        token.type === 'table' ||
        token.type === 'del' ||
        (token.type === 'blockquote' && alertMarker(token.text)) ||
        (token.type === 'list_item' && token.task) ||
        (token.type === 'link' && !token.raw.startsWith('[')),
    ),
  ],
  [
    mathFlavor.detect,
    detect(new Marked(mathTokens), (token) =>
      ['inlineMath', 'blockMath'].includes(token.type),
    ),
  ],
  [
    detectTextExtras,
    detect(new Marked(textExtrasMarkdown), (token) =>
      ['subscript', 'subtext'].includes(token.type),
    ),
  ],
  [
    typstFlavor.detect,
    detect(new Marked(typstTokens), (token) => token.type === 'typstBlock'),
  ],
]

test('block extension starts skip absent markers and retain native boundaries', (t) => {
  const alertPattern = /^ {0,3}>[ \t]*\[![a-z][a-z0-9-]*\]/im
  const subtextPattern = /^-# /m
  for (const prefix of [
    '',
    'text\n',
    'text\r',
    'text\u2028',
    'text\u2029',
    'text ',
  ]) {
    for (const marker of [
      '-# small',
      ' -# small',
      '> [!NOTE]\nbody',
      '   > [!tip]\nbody',
      '    > [!NOTE]',
      '> [!invalid]',
      '> [!NOTE] trailing',
    ]) {
      const source = `${prefix}${marker}\n\nending`
      assert.equal(alertStart(source), source.search(alertPattern))
      assert.equal(subtextStart(source), source.search(subtextPattern))
    }
  }
  t.mock.method(String.prototype, 'search', () =>
    assert.fail('absent markers must skip regex scanning'),
  )
  const prose = 'ordinary words\n\n'.repeat(5000)
  assert.equal(alertStart(prose), -1)
  assert.equal(subtextStart(prose), -1)
})

test('flavor detector guards preserve contextual parsing and delimiter edge cases', () => {
  const examples = [
    '',
    'ordinary prose. commas, numbers 12 and punctuation!',
    '# heading\n\ntext',
    'header\n---\nbody',
    'header\n:---\nbody',
    'a | b\n--- | ---\nc | d',
    '- [ ] task',
    '- [X] task',
    '> [!NOTE]\n> body',
    '~~deleted~~',
    '~deleted~',
    'https://example.test',
    'FTP://example.test',
    'www.example.test',
    'WWW.example.test',
    'one@example.test',
    '<custom:thing>',
    '<one@example.test>',
    '[link](https://example.test)',
    '$x$',
    '$$\nx\n$$',
    '$2+2$',
    'costs $5 and $10',
    '$ incomplete',
    '\\$x$',
    'H~2~O',
    '-# small',
    '-#\tsmall',
    '\\~escaped~',
    '~ incomplete',
    '```typst\n= title\n```',
    '~~~TyPsT\n= title\n~~~',
    '`````typst\n= title\n`````',
    '```typst\nnot closed',
    '  ```typst\n  = title\n  ```',
  ]
  const contexts = [
    (value) => value,
    (value) => `before\n\n${value}\n\nafter`,
    (value) => `> ${value.replaceAll('\n', '\n> ')}`,
    (value) => `- ${value.replaceAll('\n', '\n  ')}`,
    (value) => `    ${value.replaceAll('\n', '\n    ')}`,
    (value) => `\`\`\`\`\`\`markdown\n${value}\n\`\`\`\`\`\``,
    (value) => `\`${value.replaceAll('\n', ' ')}\``,
    (value) => value.replaceAll('\n', '\r\n'),
  ]
  for (const [index, [guarded, original]] of pairs.entries())
    for (const example of examples)
      for (const context of contexts) {
        const source = context(example)
        assert.equal(
          guarded(source),
          original(source),
          `detector ${index}: ${JSON.stringify(source)}`,
        )
      }
  assert.equal(
    github.detect('header\n:---\nbody'),
    true,
    'single-column aligned tables need no pipe',
  )
})

test('ordinary prose never enters a built-in flavor lexer', (t) => {
  t.mock.method(Lexer.prototype, 'lex', () => {
    assert.fail('marker-free prose must not enter a flavor lexer')
  })
  const source =
    'ordinary words, punctuation. still no special syntax!\n\n'.repeat(1000)
  for (const [guarded] of pairs) assert.equal(guarded(source), false)
})
