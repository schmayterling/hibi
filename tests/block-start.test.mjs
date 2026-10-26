import assert from 'node:assert/strict'
import test from 'node:test'
import { Lexer, Marked } from 'marked'
import { blockStartCounters } from '../src/addons/_shared/block-start.ts'
import { alertMarkdown, alertStart } from '../src/addons/markdown/alerts.ts'
import { blockMathStart, mathTokens } from '../src/addons/math/syntax.ts'
import {
  subtextStart,
  textExtrasMarkdown,
} from '../src/addons/text-extras/syntax.ts'

const hints = [
  { name: 'math', start: blockMathStart, line: / {0,3}\$\$/ },
  {
    name: 'alert',
    start: alertStart,
    line: / {0,3}>[ \t]*\[![a-zA-Z][a-zA-Z0-9-]*\]/,
  },
  { name: 'subtext', start: subtextStart, line: /-# / },
]
const alertExtension = { ...alertMarkdown.extensions[0], start: alertStart }
const lines = [
  ...['text', 'more words', '', '', ' ', '\t', ' \t '],
  ...['# heading', '#', '##x', '####### seven', '#\ttab', '  ## two'],
  ...['> quote', '>', '- item', '* item', '+ item', '-', '- ', '1. item'],
  ...['2. item', '1) item', '```', '```tex', '``` a`b', '~~~', '~~'],
  ...['---', '***', '___', '- - -', '===', '<div>', '</div>', '<DIV>'],
  ...['<span>', '<!-- c -->', '<?x', '<!DOC', '<![CDATA[', '| a | b |'],
  ...['|---|---|', 'a | b', '--- | ---', '    indented', '\t$$', '  $$x$$'],
  ...['$$x$$', '$$', '> [!NOTE]', '   > [!tip] t', '-# small', ' -# no'],
]
let seed = 0x9e3779b9
const random = () => {
  seed ^= seed << 13
  seed ^= seed >>> 17
  seed ^= seed << 5
  return (seed >>> 0) / 2 ** 32
}
const pick = () => lines[Math.floor(random() * lines.length)]
const reset = () =>
  Object.assign(blockStartCounters, { calls: 0, units: 0, max: 0 })

test('block start hints read exactly the paragraph marked would read', () => {
  for (const [mode, options] of [
    ['normal', { gfm: false, pedantic: false }],
    ['gfm', { gfm: true, pedantic: false }],
    ['pedantic', { gfm: false, pedantic: true }],
  ]) {
    const paragraph = Lexer.rules.block[mode].paragraph
    const context = { lexer: { state: { top: true }, options } }
    for (let index = 0; index < 4000; index++) {
      const source = `para ${Array.from(
        { length: 1 + Math.floor(random() * 10) },
        pick,
      ).join('\n')}`
      const read = paragraph.exec(source)[0]
      // A marker may also be the line that ends the paragraph, such as an alert.
      const end = source.indexOf('\n', read.length + 1)
      const scope = end < 0 ? source : source.slice(0, end)
      for (const { name, start, line } of hints) {
        const hit = new RegExp(`\\n(?:${line.source})`).exec(scope)
        assert.equal(
          start.call(context, source.slice(1)),
          hit ? hit.index : -1,
          `${mode} ${name} ${JSON.stringify(source)}`,
        )
      }
    }
  }
})

test('block start hints stay linear whatever ends the paragraph', () => {
  const parser = new Marked({ gfm: true }, mathTokens, textExtrasMarkdown, {
    extensions: [alertExtension],
  })
  const shapes = {
    blank: (index) => `paragraph ${index} text\n\n`,
    fence: (index) => `paragraph ${index} text\n\`\`\`\nx\n\`\`\`\n`,
    tilde: (index) => `paragraph ${index} text\n~~~\nx\n~~~\n`,
    divider: (index) => `paragraph ${index} text\n***\n`,
    heading: (index) => `paragraph ${index} text\n## heading\n`,
    html: (index) => `paragraph ${index} text\n<!-- note -->\n`,
    // Marked rejects this table (column counts differ) after it interrupts.
    table: (index) => `paragraph ${index}\na | b\n:---:\n`,
  }
  for (const [shape, section] of Object.entries(shapes)) {
    const units = [1000, 2000].map((count) => {
      // A later display equation made the old hints rescan the rest each time.
      const source = `${Array.from({ length: count }, (_, index) =>
        section(index),
      ).join('')}\n$$x$$`
      reset()
      const tokens = parser.lexer(source)
      assert.equal(tokens.at(-1).type, 'blockMath', shape)
      assert.ok(
        blockStartCounters.calls >= count &&
          // A rejected stop line, such as a table header, starts the next paragraph.
          blockStartCounters.units <= 2 * hints.length * source.length &&
          blockStartCounters.max <= 64,
        `${shape} ${JSON.stringify(blockStartCounters)}`,
      )
      return blockStartCounters.units
    })
    assert.ok(units[1] <= 2.1 * units[0], `${shape} ${units}`)
  }
  // Marked reads list items line by line and ignores block hints there.
  reset()
  parser.lexer(`- item\n${'  lazy line\n'.repeat(2000)}\n$$x$$`)
  assert.ok(blockStartCounters.calls >= 2000)
  assert.ok(blockStartCounters.units < 100, `${blockStartCounters.units}`)
})

test('bounded block start hints keep marked tokens on a fuzzed corpus', () => {
  // Earlier hints searched the whole rest of the note for a marked line.
  const unbounded = (line) => (source) => {
    const match = new RegExp(`\\n(?:${line.source})`).exec(source)
    return match ? match.index + 1 : -1
  }
  const extensions = (name, start) =>
    name === 'math'
      ? mathTokens.extensions.map((extension) =>
          extension.name === 'blockMath' ? { ...extension, start } : extension,
        )
      : name === 'alert'
        ? [{ ...alertExtension, start }]
        : textExtrasMarkdown.extensions.map((extension) =>
            extension.name === 'subtext' ? { ...extension, start } : extension,
          )
  for (const { name, start, line } of hints)
    for (const gfm of [false, true]) {
      const before = new Marked(
        { gfm },
        { extensions: extensions(name, unbounded(line)) },
      )
      const after = new Marked({ gfm }, { extensions: extensions(name, start) })
      for (let index = 0; index < 3000; index++) {
        const source =
          Array.from({ length: 1 + Math.floor(random() * 12) }, pick).join(
            random() < 0.1 ? '\r\n' : '\n',
          ) + (random() < 0.5 ? '\n' : '')
        const previous = before.lexer(source)
        const current = after.lexer(source)
        // A marked line past the paragraph no longer marks it as cut short,
        // so marked stops merging the next adjacent paragraph into it.
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
        assert.equal(at, current.length, `${name} ${source}`)
      }
    }
})

test('alert and subtext hints no longer start blocks in the middle of a line', () => {
  const parser = new Marked(textExtrasMarkdown, {
    extensions: [alertExtension],
  })
  const types = (source) => parser.lexer(source).map(({ type }) => type)
  // Marked drops a paragraph's first character before asking, so a marker
  // right after it is mid-line; earlier hints matched it at offset zero.
  assert.deepEqual(types('a-# small'), ['paragraph'])
  assert.deepEqual(types('a> [!NOTE] x'), ['paragraph'])
  assert.deepEqual(types('text\n-# small'), ['paragraph', 'subtext'])
  assert.deepEqual(types('text\n> [!NOTE]\n> body'), [
    'paragraph',
    'githubAlert',
  ])
})
