import assert from 'node:assert/strict'
import test from 'node:test'
import { flattenExtensions, getExtensionField, Node } from '@tiptap/core'
import { Table, TableKit } from '@tiptap/extension-table'
import { MarkdownManager } from '@tiptap/markdown'
import { StarterKit } from '@tiptap/starter-kit'
import { Marked } from 'marked'
import {
  guardNativeTableTokenizer,
  NativeTableKit,
} from '../src/addons/markdown/table-tokenizer.ts'

const original = getExtensionField(Table, 'markdownTokenizer')
const guarded = getExtensionField(
  guardNativeTableTokenizer(Table),
  'markdownTokenizer',
)
const cases = [
  '',
  'ordinary',
  'ordinary\nsecond',
  'a | b\n--- | ---',
  '| a | b |\n| :--- | ---: |\n| c | d |',
  '| `a|b` | c |\n|---|---|\n| d | `e|f` |\n\n# after',
  'header\n---',
  'header\n---|---\n`a|b`',
  '\n|---|---\n`a|b`',
  '\n\n|---|---\n`a|b`',
  'a | b\n--- | ---\n\n| `later|code` | d |',
  'a | b\n--- | ---\n# heading\n\nlast',
  'a | b\n--- | ---\n> quote',
  'a | b\n--- | ---\n```txt\na|b\n```',
  'a | b\r\n--- | ---\r\nlast',
  'a | b\n--- | ---\n \n| `c|d` | e |',
]
for (const header of ['plain', '| a |', '`a|b`', 'a \\| b', ''])
  for (const separator of [
    '---',
    '|---|',
    ' - | :--: ',
    '\t|---|\t',
    '| ::: |',
    '|',
    '---||',
    '|---|\r',
    '',
    '|-x-|',
    '|-\u00a0|',
  ])
    for (const ending of ['', '\n', '\n| `a|b` | c |\n\nparagraph\n|---|'])
      cases.push(`${header}\n${separator}${ending}`)

function tokenize(tokenizer, source) {
  const calls = []
  const helper = {
    inlineTokens: () => [],
    blockTokens: (value) => {
      calls.push(value)
      return [
        { type: 'table', raw: `${value}\n`, header: [], align: [], rows: [] },
      ]
    },
  }
  return { value: tokenizer.tokenize(source, [], helper), calls }
}

test('two-line guards preserve native table starts, tokens and helper calls', () => {
  for (const source of cases) {
    assert.equal(guarded.start(source), original.start(source), source)
    assert.deepEqual(
      tokenize(guarded, source),
      tokenize(original, source),
      source,
    )
  }
})

test('ordinary paragraph tails are never split by guarded table detection', (t) => {
  const source = `ordinary\nsecond line\n${'remaining prose\n'.repeat(20000)}`
  const split = String.prototype.split
  let fullSplits = 0
  t.mock.method(String.prototype, 'split', function (...args) {
    if (String(this) === source && args[0] === '\n') fullSplits++
    return split.apply(this, args)
  })
  assert.equal(original.start(source), -1)
  assert.equal(fullSplits, 1)
  fullSplits = 0
  assert.equal(tokenize(original, source).value, undefined)
  assert.equal(fullSplits, 1)
  fullSplits = 0
  for (let index = 0; index < 100; index++) {
    assert.equal(guarded.start(source), -1)
    assert.equal(tokenize(guarded, source).value, undefined)
  }
  assert.equal(fullSplits, 0)
})

test('table kit retains schema options and leaves custom tokenizers unchanged', () => {
  const options = {
    table: { resizable: false, HTMLAttributes: { class: 'fixture' } },
    tableHeader: false,
  }
  const before = flattenExtensions([TableKit.configure(options)]),
    after = flattenExtensions([NativeTableKit.configure(options)])
  assert.deepEqual(
    after.map((extension) => extension.name),
    before.map((extension) => extension.name),
  )
  for (const [index, extension] of after.entries()) {
    assert.deepEqual(extension.options, before[index].options)
    assert.equal(
      extension.config.parseMarkdown,
      before[index].config.parseMarkdown,
    )
  }
  const replacement = Table.extend({
    markdownTokenizer: {
      ...original,
      start: () => 9,
      tokenize: () => ({ type: 'custom', raw: 'ordinary' }),
    },
  })
  assert.equal(guardNativeTableTokenizer(replacement), replacement)
  const unrelated = Node.create({ name: 'unrelated' })
  assert.equal(guardNativeTableTokenizer(unrelated), unrelated)
})

test('guarded table schema preserves native JSON for escaped and code-span pipes', () => {
  const managers = [TableKit, NativeTableKit].map(
    (kit) =>
      new MarkdownManager({
        marked: new Marked({ gfm: true }),
        extensions: [
          StarterKit,
          kit.configure({ table: { resizable: false } }),
        ],
      }),
  )
  for (const source of [
    ...cases,
    '| `one|two` | **bold** |\n|---|---|\n| `a|b` | [ref] |\n\n[ref]: /target',
    '| ``a`|b`` | value |\n|:--|--:|\n| c \\| d | e |',
    '> | `a|b` | c |\n> |---|---|\n> | d | e |\n\nlast',
  ])
    assert.deepEqual(
      managers[1].parse(source),
      managers[0].parse(source),
      source,
    )
})
