import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { GFM } from '@lezer/markdown'
import { Lexer, Marked, Parser } from 'marked'
import { mathTokens } from '../src/addons/math/syntax.ts'
import { richText } from '../src/addons/word-count/formatted-text.ts'
import { listAction } from '../src/renderer/src/source-formatting-actions.ts'
import { formattedMarkdownParser } from '../src/shared/formatted-markdown.ts'
import { BlockTokenizer, blockMarkdown } from '../src/shared/marked-blocks.ts'
import { defaultNoteSyntax } from '../src/shared/note-syntax.ts'

const read = (source, operation) =>
  operation === 'export'
    ? new Marked(blockMarkdown).parse(source)
    : richText(source, defaultNoteSyntax)
const text = (result) => result.replace(/<[^>]*>/g, '').replace(/\s/g, '')
const cases = [
  ['unordered', '- [ ] a\n', 'a', 1, 1],
  ['checked', '- [x] a\n', 'a', 1, 1],
  ['ordered', '1. [x] a\n', 'a', 1, 1],
  ['quoted', '> - [ ] a\n', 'a', 1, 1],
  ['mixed', '- [ ] a\n- b\n- [x] c\n', 'abc', 2, 3],
  ['nested', '- p\n  - [ ] a\n', 'pa', 1, 2],
  ['separate', '- [ ] a\n\n# h\n\n', 'ah', 1, 1],
]
for (const [name, unit, expected, tasks, items] of cases)
  for (const operation of ['export', 'count']) {
    test(`task queue ${name} ${operation} bounds pending scans`, (t) => {
      for (const count of [32, 256]) {
        const source = unit.repeat(count),
          rule = new Lexer().tokenizer.rules.other.listIsTask
        const test = RegExp.prototype.test
        let calls = 0
        const probe = t.mock.method(
          RegExp.prototype,
          'test',
          function (source) {
            if (this === rule) calls++
            return test.call(this, source)
          },
        )
        let result
        try {
          result = read(source, operation)
        } finally {
          probe.mock.restore()
        }
        assert.equal(text(result), expected.repeat(count))
        if (operation === 'export')
          assert.equal((result.match(/<input /g) ?? []).length, count * tasks)
        assert.ok(
          calls <= count * items * 3,
          `${calls} task tests / ${count * items} items`,
        )
      }
    })
  }

const controls = [
  '- [ ] **one**\n- [x] two\n\noutside',
  '- [ ] one\n\n  second paragraph\n- [x] two',
  '- [ ] one\n  - [x] two\n- [ ] three',
  '- [ ] one\n- ordinary\n\n[x] literal',
  '1. [ ] one\n2. [x] two\n\n> after',
  '- [ ] one\n\n# heading\n\n- [x] two\n\nafter',
  '- [ ] one\n- [ ] [ ] two\n- [x] three',
  '- [x] one\n- > [ ] quoted\n- [ ] [x] two',
  '[ ] before\n\n- [ ]\n- [ ] one',
]
test('task queue controls retain following blocks and inline markup', () => {
  for (const source of controls)
    assert.equal(
      new Marked(blockMarkdown).parse(source),
      new Marked().parse(source),
      source,
    )
})

test('task queue controls keep replacement queues made by block readers', () => {
  let copies = 0
  class CopyQueue extends BlockTokenizer {
    text(source) {
      const token = super.text(source)
      if (token && ++copies)
        this.lexer.inlineQueue = this.lexer.inlineQueue.map((work) => ({
          ...work,
        }))
      return token
    }
  }
  const source = '- [ ] one\n- [x] two\n\nafter'
  const lexer = new Lexer({ gfm: true, tokenizer: new CopyQueue() })
  assert.equal(Parser.parse(lexer.lex(source)), new Marked().parse(source))
  assert.equal(copies, 2)
})

// JSON keeps every token field the projections read (task, checked, raw, text).
const tree = (tokens) => JSON.parse(JSON.stringify(tokens))
test('task queue tokens equal native marked tokens', () => {
  for (const source of [
    ...cases.map(([, unit]) => unit.repeat(32)),
    ...controls,
    '- [x] a\n- [X] b\n\n- [ ] c',
  ])
    assert.deepEqual(
      tree(new Marked(blockMarkdown).lexer(source)),
      tree(new Marked().lexer(source)),
      source,
    )
})

test('task queue reads tasks in every group of a list re-read after a lazy opener', () => {
  const tasks = (source) => {
    const found = []
    const walk = (tokens) => {
      for (const token of tokens ?? []) {
        if (token.type === 'list_item' && token.task)
          found.push([token.checked, token.tokens[0]?.type, token.text])
        walk(token.tokens)
        walk(token.items)
      }
    }
    walk(new Marked(blockMarkdown, mathTokens).lexer(source))
    return found
  }
  for (const [source, expected] of [
    [
      '- a\n-\n$$\nx\n$$\n- [ ] b\n- [x] c',
      [
        [false, 'checkbox', 'b'],
        [true, 'checkbox', 'c'],
      ],
    ],
    ['- a\n- # h\n$$\nx\n$$\n- [ ] b', [[false, 'checkbox', 'b']]],
    ['1. a\n2.\n$$\nx\n$$\n3. [ ] b', [[false, 'checkbox', 'b']]],
    [
      '- [ ] a\n-\n$$\nx\n$$\n- b\n- [x] c',
      [
        [false, 'checkbox', 'a'],
        [true, 'checkbox', 'c'],
      ],
    ],
  ])
    assert.deepEqual(tasks(source), expected, source)
})

test('task queue list reformat keeps checked tasks checked', () => {
  const doc = '- [x] done\n- [ ] open\n- [X] last'
  const state = EditorState.create({ doc, selection: { anchor: 13 } })
  const spec = listAction(
    state,
    formattedMarkdownParser(GFM).parse(doc),
    'indent',
  )
  assert.equal(
    state.update(spec).state.doc.toString(),
    '- [x] done\n  - [ ] open\n- [x] last',
  )
})
