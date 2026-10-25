import assert from 'node:assert/strict'
import test from 'node:test'
import { getSchema } from '@tiptap/core'
import { BlockMath, InlineMath } from '@tiptap/extension-mathematics'
import { TableKit } from '@tiptap/extension-table'
import { MarkdownManager } from '@tiptap/markdown'
import { Marked } from 'marked'
import {
  blockMath,
  inlineMath,
  mathFlavor,
  mathTokens,
} from '../src/addons/math/syntax.ts'
import { markdownConfiguration } from '../src/renderer/src/markdown.ts'
import { markdownSerializer } from '../src/renderer/src/markdown-serialization.ts'
import { preserveRichSource } from '../src/renderer/src/rich-source-preservation.ts'
import { markdownSourceParser } from '../src/shared/markdown-source-references.ts'

const fixtures = [
  ['$$x$$', 1],
  ['text $$x$$', 0],
  ['text $$x$$ more', 0],
  ['x$$x$$', 0],
  ['text $$x$$\nmore', 0],
  ['$$x$$ more', 0],
  ['text\n$$x$$ more', 0],
  ['text\n   $$x$$ more', 0],
  ['text\n$$x$$ more\n$$y$$', 1],
  ['text\n$$x$$', 1],
  ['$$\nx\n$$', 1],
  [' $$x$$', 1],
  ['  $$x$$', 1],
  ['   $$x$$', 1],
  ['text\n   $$x$$', 1],
  ['   $$\nx\n   $$', 1],
  ['    $$x$$', 0],
  ['\t$$x$$', 0],
  ['text\n    $$x$$', 0],
  ['- item\n\n  $$x$$', 1],
  ['- text\n  $$x$$', 1],
  ['- text $$x$$', 0],
  ['- text $$x$$ more', 0],
  ['- item\n\n  $$\n  x\n  $$', 1],
  ['> $$x$$', 1],
  ['> text\n> $$x$$', 1],
  ['> $$\n> x\n> $$', 1],
  ['> text $$x$$', 0],
  ['> text $$x$$ more', 0],
  ['$5 and $$10', 0],
  ['\\$$', 0],
  ['\\$$x$$', 0],
  ['text \\$$x$$ more', 0],
  ['`$$x$$`', 0],
  ['```tex\n$$x$$\n```', 0],
]

function mathParser(gfm = false) {
  const extensions = [InlineMath, BlockMath].map((extension) => {
    const syntax = mathTokens.extensions.find(
      ({ name }) => name === extension.name,
    )
    return extension.extend({
      markdownTokenizer: {
        name: syntax.name,
        level: syntax.level,
        start: syntax.start,
        tokenize: syntax.tokenizer,
      },
    })
  })
  const { parser, options, core, addons } = markdownConfiguration([
    {
      ...mathFlavor,
      id: 'math.latex',
      markedOptions: { gfm },
      richExtensions: [...extensions, ...(gfm ? [TableKit] : [])],
      export: { extensions: [mathTokens] },
    },
  ])
  const all = [...core, ...addons]
  return {
    schema: getSchema(all),
    manager: new MarkdownManager({
      extensions: all,
      marked: parser,
      markedOptions: options,
    }),
  }
}

test('display math starts only at line boundaries in visual and source tokenizers', () => {
  const parsers = [
    new Marked(mathTokens),
    markdownSourceParser({ gfm: false, math: true }),
    markdownSourceParser({ gfm: true, math: true }),
  ]
  for (const parser of parsers) {
    for (const [source, expected] of fixtures) {
      const tokens = parser.lexer(source)
      let blocks = 0
      parser.walkTokens(tokens, (token) => {
        if (token.type === 'blockMath') blocks++
        assert.notEqual(token.type, 'inlineMath', source)
      })
      assert.equal(blocks, expected, source)
      assert.equal(tokens.map(({ raw }) => raw).join(''), source, source)
      assert.equal(mathFlavor.detect(source), expected > 0, source)
    }
  }
})

test('display math start hints and tokenizer agree on indentation and real newlines', () => {
  const start = mathTokens.extensions.find(
    ({ name }) => name === 'blockMath',
  ).start
  for (const indent of ['', ' ', '  ', '   ']) {
    const source = `${indent}$$x$$`
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
    'text\n    $$x$$',
  ])
    assert.ok(start(source) === undefined || start(source) < 0, source)
  for (const source of [
    'text $$x$$',
    'text $$x$$ more',
    '    $$x$$',
    '\t$$x$$',
    '\\$$x$$',
  ])
    assert.equal(blockMath(source), undefined, source)
  assert.equal(inlineMath('$x$')?.latex, 'x')
})

test('math paragraphs retain literal text without inserted line breaks', () => {
  const { manager, schema } = mathParser()
  for (const source of [
    'text $$x$$',
    'text $$x$$ more',
    'x$$x$$',
    '$5 and $$10',
    '\\$$x$$',
  ]) {
    const doc = schema.nodeFromJSON(manager.parse(source))
    assert.equal(doc.childCount, 1, source)
    assert.equal(doc.firstChild.type.name, 'paragraph', source)
    assert.equal(doc.textContent, source.replace('\\$', '$'), source)
  }
})

test('full and cached math serialization preserve literal dollars and equations', async (t) => {
  const parsers = [mathParser(), mathParser(true)]
  for (const source of [
    '\\$$x$$',
    '\\$x$',
    '$5 and $10',
    'a \\$ b',
    'text $$x$$',
    'text $$x$$ more',
    '$$x$$ more',
    'text  \n\\$$x$$',
    '> \\$$x$$',
    '- \\$$x$$',
    '\\# \\$x$',
    '**\\$x$**',
    '\\$**x**$',
    '[\\$x$](https://example.com/$y$)',
    '`$x$`',
    '`$x$` and \\$x$',
    '| \\$x$ | `$y$` |\n| --- | --- |\n| $z$ | $5 and $10 |',
    '```tex\n$x$\n```',
    '$x$ and \\$x$',
    '\\$x$ and $x$',
    '$x$\\$',
    '\\$$x$',
    '\\$5 or \\$y$ total',
    '\\$$$x$',
    'a \\$5 then \\$x$ more',
    '$x$ and $5 and $10',
    '$x+y$ and $$z$$',
    '$$x$$',
    '$$\nx+y\n$$',
    '\uE0000\uE001 \\$x$ \uE000\uE0000\uE001',
  ]) {
    await t.test(JSON.stringify(source), () => {
      for (const { manager, schema } of parsers) {
        const doc = schema.nodeFromJSON(manager.parse(source))
        doc.check()
        for (const blockLocal of [false, true]) {
          const saved = markdownSerializer(manager, blockLocal)(doc).source
          const reparsed = schema.nodeFromJSON(manager.parse(saved))
          assert.equal(reparsed.textContent, doc.textContent, saved)
          assert.ok(reparsed.eq(doc), saved)
          if (source.includes('$5 and $10'))
            assert.ok(saved.includes('$5 and $10'), saved)
          if (source.includes('`$x$`'))
            assert.ok(saved.includes('`$x$`'), saved)
        }
      }
    })
  }
})

test('table cells keep literal double dollars without display math escapes', () => {
  const { manager, schema } = mathParser(true)
  const doc = schema.nodeFromJSON(
    manager.parse('| \\$$x$$ |\n| --- |\n| $x$ |'),
  )
  for (const blockLocal of [false, true]) {
    const saved = markdownSerializer(manager, blockLocal)(doc).source
    assert.ok(saved.includes('| $$x$$ |'), saved)
    assert.ok(schema.nodeFromJSON(manager.parse(saved)).eq(doc), saved)
  }
})

test('math-disabled serialization leaves dollar signs unchanged', () => {
  const { core, parser, options } = markdownConfiguration([])
  const manager = new MarkdownManager({
    extensions: core,
    marked: parser,
    markedOptions: options,
  })
  for (const source of ['$x$', '$$x$$', '$5 and $10'])
    assert.equal(manager.serialize(manager.parse(source)), source)
})

test('math round-trips preserve bytes through unrelated rich edits', () => {
  const { manager, schema } = mathParser()
  for (const [fixture, expected] of fixtures) {
    for (const eol of ['\n', '\r\n']) {
      for (const ending of ['', eol]) {
        const source = `${fixture}\n\nanchor`.replaceAll('\n', eol) + ending
        const doc = schema.nodeFromJSON(manager.parse(source))
        doc.check()
        let blocks = 0
        doc.descendants((node) => {
          if (node.type.name === 'blockMath') blocks++
        })
        assert.equal(blocks, expected, source)
        const before = manager.serialize(doc.toJSON())
        assert.equal(
          preserveRichSource(source, before, before, (candidate) =>
            schema.nodeFromJSON(manager.parse(candidate)).eq(doc),
          ),
          source,
        )
        const changed = structuredClone(doc.toJSON())
        changed.content.at(-1).content[0].text = 'changed'
        const next = schema.nodeFromJSON(changed)
        const after = manager.serialize(changed)
        assert.equal(
          preserveRichSource(source, before, after, (candidate) =>
            schema.nodeFromJSON(manager.parse(candidate)).eq(next),
          ),
          source.replace('anchor', 'changed'),
        )
      }
    }
  }
})

test('display math start hints stop at the paragraph marked is reading', () => {
  const start = mathTokens.extensions.find(
    ({ name }) => name === 'blockMath',
  ).start
  // Count only the units this hint's own probe reads.
  const exec = RegExp.prototype.exec
  let scanned = 0
  RegExp.prototype.exec = function (input) {
    const match = exec.call(this, input)
    if (this.source.includes('(\\$\\$)'))
      scanned += match ? match.index + match[0].length : input.length
    return match
  }
  try {
    const filler = 'words '.repeat(50_000)
    assert.equal(start(`ext\n\n${filler}\n$$x$$`), -1)
    assert.equal(scanned, 'ext\n\n'.length)
    scanned = 0
    assert.equal(start(`ext\n \t\n${filler}\n$$x$$`), -1)
    assert.equal(scanned, 'ext\n \t\n'.length)
    scanned = 0
    assert.equal(start(`ext\n## heading\n${filler}\n$$x$$`), -1)
    assert.equal(scanned, 'ext\n## '.length)
    // Display math inside the paragraph still ends it.
    assert.equal(start(`ext\n   $$x$$\n\n${filler}`), 4)
    // A note costs one linear pass, not a rest-of-note scan per paragraph.
    scanned = 0
    const note = `${Array.from(
      { length: 2000 },
      (_, index) => `paragraph ${index} text`,
    ).join('\n\n')}\n\n$$x$$`
    const tokens = new Marked(mathTokens).lexer(note)
    assert.equal(tokens.filter(({ type }) => type === 'blockMath').length, 1)
    assert.ok(scanned > 0 && scanned <= note.length, `${scanned}`)
  } finally {
    RegExp.prototype.exec = exec
  }
})

test('bounded display math hints keep marked tokens on a fuzzed corpus', () => {
  const unbounded = (source) => {
    const match = /\n {0,3}\$\$/.exec(source)
    return match ? match.index + 1 : -1
  }
  const lines = [
    ...['text', 'more words', 'x\\', '$a$', 'text $$x$$ more', '\\$$'],
    ...['$$', '$$x$$', ' $$y$$', '   $$z$$', '    $$code$$', '\t$$t$$'],
    ...['$$\\frac{1}{2}$$', '$$ a', 'b $$'],
    ...['# heading', '#', '##x', '###### six', '####### seven', '#\ttab'],
    ...['> quote', '> $$q$$', '- item', '* item', '1. item', '2) item'],
    ...['  - nested', '    indented', '```', '```tex', '~~~'],
    ...['| a | b |', '|---|---|', '<div>', '</div>', '---', '***', '==='],
    ...['', '', ' ', '  ', '\t', ' \t '],
  ]
  let seed = 0x9e3779b9
  const random = () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return (seed >>> 0) / 2 ** 32
  }
  for (const gfm of [false, true]) {
    const before = new Marked(
      { gfm },
      {
        extensions: mathTokens.extensions.map((extension) =>
          extension.name === 'blockMath'
            ? { ...extension, start: unbounded }
            : extension,
        ),
      },
    )
    const after = new Marked({ gfm }, mathTokens)
    for (let index = 0; index < 5000; index++) {
      const source =
        Array.from(
          { length: 1 + Math.floor(random() * 12) },
          () => lines[Math.floor(random() * lines.length)],
        ).join(random() < 0.1 ? '\r\n' : '\n') + (random() < 0.5 ? '\n' : '')
      const previous = before.lexer(source)
      const current = after.lexer(source)
      // A `$$` line past a blank line or heading no longer marks the paragraph
      // as clipped, so marked stops merging the next adjacent paragraph into it.
      let at = 0
      for (const token of previous) {
        const span = [current[at++]]
        while (span.map(({ raw }) => raw).join('').length < token.raw.length)
          span.push(current[at++])
        if (span.length === 1) assert.deepEqual(span[0], token, source)
        else {
          assert.equal(token.type, 'paragraph', source)
          assert.ok(
            span.every((part) => part?.type === 'paragraph'),
            source,
          )
          assert.equal(span.map(({ raw }) => raw).join(''), token.raw, source)
        }
      }
      assert.equal(at, current.length, source)
    }
  }
})
