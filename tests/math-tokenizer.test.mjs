import assert from 'node:assert/strict'
import test from 'node:test'
import { Marked } from 'marked'
import {
  blockMath,
  inlineMath,
  mathFlavor,
  mathTokens,
  mathTokensWith,
} from '../src/addons/math/syntax.ts'
import { markdownSourceParser } from '../src/shared/markdown-source-references.ts'
import { blockMarkdown } from '../src/shared/marked-blocks.ts'

// As in Obsidian, a `$$` line opens a block only without another `$` on it,
// so `$$x$$` on a line of its own is display math in a paragraph.
const fixtures = [
  ['$$x$$', 0, 1],
  ['text $$x$$', 0, 1],
  ['text $$x$$ more', 0, 1],
  ['x$$x$$', 0, 1],
  ['text $$x$$\nmore', 0, 1],
  ['$$x$$ more', 0, 1],
  ['text\n$$x$$ more', 0, 1],
  ['text\n   $$x$$ more', 0, 1],
  ['text\n$$x$$ more\n$$y$$', 0, 2],
  ['text\n$$x$$', 0, 1],
  ['$$\nx\n$$', 1],
  [' $$x$$', 0, 1],
  ['  $$x$$', 0, 1],
  ['   $$x$$', 0, 1],
  ['text\n   $$x$$', 0, 1],
  ['text\n   $$\nx\n$$', 1],
  ['   $$\nx\n   $$', 1],
  ['    $$x$$', 0],
  ['\t$$x$$', 0],
  ['text\n    $$x$$', 0, 1],
  ['- item\n\n  $$x$$', 0, 1],
  ['- text\n  $$x$$', 0, 1],
  ['- text\n  $$\n  x\n  $$', 1],
  ['- text $$x$$', 0, 1],
  ['- text $$x$$ more', 0, 1],
  ['- item\n\n  $$\n  x\n  $$', 1],
  ['> $$x$$', 0, 1],
  ['> text\n> $$x$$', 0, 1],
  ['> text\n> $$\n> x\n> $$', 1],
  ['> $$\n> x\n> $$', 1],
  ['> text $$x$$', 0, 1],
  ['> text $$x$$ more', 0, 1],
  // Lazy quote text cannot open a new formula when a nested list is re-read.
  ['> - w\n    $$\n   abc\n', 0],
  ['> - w\n    ordinary\n    $$\n   abc\n', 0],
  ['> - w\n    $$\n   abc\n\noutside words\n', 0],
  ['> - w\n>   $$\n>   abc\n', 1],
  // As in Obsidian, across lines of a paragraph or blank.
  ['text $$x\n+y$$ more', 0, 1],
  ['text $$ $$ more', 0, 1],
  ['text $$$$ more', 0, 1],
  ['> text $$x\n> +y$$ more', 0, 1],
  ['- text $$x\n  +y$$ more', 0, 1],
  // As in Obsidian, an escaped dollar leaves `$x$` before the last one.
  ['text \\$$x\n+y$$ more', 0, 1],
  ['$5 and $$10', 0],
  ['\\$$', 0],
  ['\\$$x$$', 0, 1],
  ['text \\$$x$$ more', 0, 1],
  ['`$$x$$`', 0],
  ['```tex\n$$x$$\n```', 0],
]

test('display math blocks start only at line boundaries in visual and source tokenizers', () => {
  const visual = new Marked(mathTokens)
  const parsers = [
    visual,
    markdownSourceParser({ gfm: false, math: true }),
    markdownSourceParser({ gfm: true, math: true }),
  ]
  for (const parser of parsers) {
    for (const [source, expected, inline = 0] of fixtures) {
      const tokens = parser.lexer(source)
      let blocks = 0,
        display = 0
      parser.walkTokens(tokens, (token) => {
        if (token.type === 'blockMath') blocks++
        if (token.type === 'inlineMath') display++
      })
      assert.equal(blocks, expected, source)
      // `$$…$$` inside a line is display math there, as Obsidian draws it.
      assert.equal(display, inline, source)
      assert.equal(tokens.map(({ raw }) => raw).join(''), source, source)
      assert.equal(mathFlavor.detect(source), expected + inline > 0, source)
    }
  }
})

test('display math start hints and tokenizer agree on indentation and real newlines', () => {
  const start = mathTokens.extensions.find(
    ({ name }) => name === 'blockMath',
  ).start
  for (const indent of ['', ' ', '  ', '   ']) {
    const source = `${indent}$$\nx\n$$`
    assert.equal(blockMath(source)?.raw, source)
    const tail = `text\n${source}`
    const at = start(tail)
    assert.ok(at >= 0)
    assert.ok(blockMath(tail.slice(at)))
  }
  for (const source of [
    '$$x$$',
    ' $$x$$',
    'text $$x$$',
    'text $$x$$ more',
    '\\$$x$$',
    'text\n    $$\nx',
    // Another `$` on the line, or no line after it.
    'text\n$$x$$\nmore',
    'text\n$$',
  ])
    assert.ok(start(source) === undefined || start(source) < 0, source)
  for (const source of [
    '$$x$$',
    'text $$x$$',
    'text $$x$$ more',
    '    $$\nx\n$$',
    '\t$$\nx\n$$',
    '\\$$x$$',
    '$$',
    '$$a$b\nc\n$$',
  ])
    assert.equal(blockMath(source), undefined, source)
  assert.equal(inlineMath('$x$')?.latex, 'x')
})

test('literal double dollars stay literal after rich serialization and export', () => {
  const parser = markdownSourceParser({ gfm: true, math: true })
  // The source the rich editor saved for each note with the GitHub and math
  // flavors, in full and block-local serialization.
  for (const [source, saved] of Object.entries({
    'before \\$\\$x\\$\\$ after': [
      'before \\$\\$x\\$\\$ after',
      'before \\$\\$x\\$\\$ after',
    ],
    '| \\$\\$x\\$\\$ |\n| --- |': [
      '\n| \\$\\$x\\$\\$ |\n| --------- |\n',
      '\n| \\$\\$x\\$\\$ |\n| --------- |\n',
    ],
    'before \\$\\$x\n+y\\$\\$ after': [
      'before \\$\\$x +y\\$\\$ after',
      'before \\$\\$x +y\\$\\$ after',
    ],
    'before \\$$ $$ after': [
      'before \\$\\$ \\$\\$ after',
      'before \\$\\$ \\$\\$ after',
    ],
    'before \\$$$$ after': [
      'before \\$\\$\\$\\$ after',
      'before \\$\\$\\$\\$ after',
    ],
    'before \\$\\$ x $y\\$\\$ after': [
      'before $$ x $y\\$\\$ after',
      'before $$ x $y\\$\\$ after',
    ],
  }))
    for (const text of saved) {
      let formulas = 0
      parser.walkTokens(parser.lexer(text), (token) => {
        if (token.type === 'inlineMath' || token.type === 'blockMath')
          formulas++
      })
      assert.equal(formulas, 0, JSON.stringify({ source, text }))
    }
})

test('disabled block math leaves lazy quotes and setext headings as Markdown', () => {
  let enabled = false
  const parser = new Marked(
    blockMarkdown,
    mathTokensWith(() => enabled),
  )
  for (const source of ['> a\n$$\nx\n', 'a\n$$\nx\n---\n'])
    assert.equal(parser.parse(source), new Marked().parse(source))
  enabled = true
  assert.equal(parser.lexer('$$\nx\n')[0].type, 'blockMath')
  enabled = false
  assert.equal(parser.lexer('$$\nx\n')[0].type, 'paragraph')
})

test('the math addon exports headings after an unclosed block when block math is off', async (t) => {
  const { createServer } = await import('vite')
  const server = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, watch: null },
    appType: 'custom',
  })
  t.after(() => server.close())
  const { startMath } = await server.ssrLoadModule('/src/addons/math/engine.ts')
  // Export renders synchronously; no formula is mounted for observation.
  const observers = ['IntersectionObserver', 'ResizeObserver']
  const previous = observers.map((name) => globalThis[name])
  for (const name of observers) globalThis[name] = class {}
  t.after(() =>
    observers.forEach((name, index) => {
      globalThis[name] = previous[index]
    }),
  )
  let flavor
  let blocks = false
  t.after(
    startMath({
      editor: {
        registerSyntax() {},
        registerSource() {},
        registerFlavor(value) {
          flavor = value
        },
        isSyntaxEnabled: () => blocks,
        onDocumentChange() {},
      },
      styles: { register() {} },
      commands: { register() {} },
      toolbar: { register: () => ({ update() {} }) },
    }),
  )
  const parser = new Marked(...flavor.export.extensions)
  const source = '$$\n**bold**\n\n# after\n'
  assert.match(parser.parse(source), /<strong>bold<\/strong>/)
  assert.match(parser.parse(source), /<h1>after<\/h1>/)
  blocks = true
  assert.doesNotMatch(parser.parse(source), /<h1>/)
  assert.match(parser.parse(source), /class="katex/)
  const warnings = []
  t.mock.method(console, 'warn', (message) => warnings.push(message))
  assert.match(parser.parse('$$\nördinäry 日本語\n$$\n'), /class="katex/)
  assert.deepEqual(warnings, [])
  blocks = false
  assert.match(parser.parse(source), /<h1>after<\/h1>/)
})
