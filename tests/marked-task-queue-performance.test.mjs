import assert from 'node:assert/strict'
import test from 'node:test'
import { Lexer, Marked, Parser } from 'marked'
import { richText } from '../src/addons/word-count/formatted-text.ts'
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

test('task queue controls retain following blocks and inline markup', () => {
  for (const source of [
    '- [ ] **one**\n- [x] two\n\noutside',
    '- [ ] one\n\n  second paragraph\n- [x] two',
    '- [ ] one\n  - [x] two\n- [ ] three',
    '- [ ] one\n- ordinary\n\n[x] literal',
    '1. [ ] one\n2. [x] two\n\n> after',
    '- [ ] one\n\n# heading\n\n- [x] two\n\nafter',
    '- [ ] one\n- [ ] [ ] two\n- [x] three',
    '- [x] one\n- > [ ] quoted\n- [ ] [x] two',
    '[ ] before\n\n- [ ]\n- [ ] one',
  ])
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
