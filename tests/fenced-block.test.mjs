import assert from 'node:assert/strict'
import test from 'node:test'
import { Lexer, Marked } from 'marked'
import {
  fencedBlock,
  fencedBlockStart,
} from '../src/addons/_shared/fenced-block.ts'

const tokenize = fencedBlock('mermaid', 'mermaidBlock')
const mermaid = {
  extensions: [
    {
      name: 'mermaidBlock',
      level: 'block',
      start: fencedBlockStart,
      tokenizer(source) {
        const token = tokenize(source)
        if (token) return { ...token, tokens: [] }
      },
    },
  ],
}
// Marked's own tokens, with a mermaid code block standing for the addon block.
function expected(tokens) {
  return tokens.map((token) =>
    token.type === 'code' && token.lang?.toLowerCase() === 'mermaid'
      ? { type: 'mermaidBlock', raw: token.raw, source: token.text, tokens: [] }
      : nested(token, expected),
  )
}
function nested(token, map) {
  const copy = { ...token }
  if (copy.tokens) copy.tokens = map(copy.tokens)
  if (copy.items)
    copy.items = copy.items.map((item) => ({
      ...item,
      tokens: map(item.tokens),
    }))
  return copy
}
const strip = (tokens) => tokens.map((token) => nested(token, strip))
// Quoted fences are left out: Marked ends a quote's lazy lines only after its
// own code tokens, so text right after a quoted diagram stays in the quote.
const lines = [
  '```mermaid',
  '~~~mermaid',
  '```Mermaid ',
  '````mermaid',
  '   ```mermaid',
  '    ```mermaid',
  'x```mermaid',
  'a ```mermaid',
  '```mermaid ```',
  '```js',
  '```',
  '~~~',
  '````',
  'graph TD',
  'A-->B',
  '# heading',
  'heading',
  '===',
  '- item',
  '1. item',
  '> quote',
  'a | b',
  ':---:',
  '***',
  '<div>',
  '',
  '',
  'words here',
]

test('mermaid blocks keep marked block boundaries', () => {
  let seed = 7
  const random = (count) => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed % count
  }
  for (const gfm of [true, false]) {
    const plain = new Marked({ gfm })
    const withMermaid = new Marked({ gfm }).use(mermaid)
    for (let index = 0; index < 3000; index++) {
      const source =
        Array.from(
          { length: 1 + random(12) },
          () => lines[random(lines.length)],
        ).join('\n') + (random(2) ? '\n' : '')
      assert.deepEqual(
        strip(withMermaid.lexer(source)),
        strip(expected(plain.lexer(source))),
        JSON.stringify({ gfm, source }),
      )
    }
  }
  const lexed = (source) =>
    new Marked()
      .use(mermaid)
      .lexer(source)
      .map((token) => token.type)
  // A fence after a paragraph's first character stays paragraph text.
  assert.deepEqual(lexed('x```mermaid\n# real\n```'), [
    'paragraph',
    'heading',
    'code',
  ])
  assert.deepEqual(lexed('text\n```mermaid\nA\n```\n# real'), [
    'paragraph',
    'mermaidBlock',
    'heading',
  ])
})

test('mermaid blocks read only their own fence', () => {
  const source = Array.from(
    { length: 2000 },
    (_, index) =>
      `paragraph ${index}\n\n\`\`\`${index % 2 ? 'mermaid' : 'js'}\nA-->B\n\`\`\``,
  ).join('\n\n')
  const blockTokens = Lexer.prototype.blockTokens
  let units = 0
  Lexer.prototype.blockTokens = function (source, ...rest) {
    units += source.length
    return blockTokens.call(this, source, ...rest)
  }
  try {
    new Marked().lexer(source)
    const plain = units
    units = 0
    const tokens = new Marked().use(mermaid).lexer(source)
    assert.equal(
      tokens.filter((token) => token.type === 'mermaidBlock').length,
      1000,
    )
    assert.equal(units, plain)
  } finally {
    Lexer.prototype.blockTokens = blockTokens
  }
})
