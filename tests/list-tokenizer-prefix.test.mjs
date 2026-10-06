import assert from 'node:assert/strict'
import test from 'node:test'
import {
  flattenExtensions,
  getExtensionField,
  getSchema,
  Node,
} from '@tiptap/core'
import { OrderedList, TaskItem, TaskList } from '@tiptap/extension-list'
import { MarkdownManager } from '@tiptap/markdown'
import { StarterKit } from '@tiptap/starter-kit'
import { Marked } from 'marked'
import { alertMarkdown } from '../src/addons/markdown/alerts.ts'
import { GithubAlert } from '../src/addons/markdown/GithubAlert.ts'
import {
  guardNativeListTokenizer,
  parseEmptyTaskItems,
} from '../src/renderer/src/list-tokenizer-prefix.ts'
import { markdownConfiguration } from '../src/renderer/src/markdown.ts'
import { preserveRichSource } from '../src/renderer/src/rich-source-preservation.ts'

function taskParser() {
  const { parser, options, core, addons } = markdownConfiguration([
    {
      id: 'github-markdown.github',
      markedOptions: { gfm: true },
      richExtensions: [
        TaskList,
        TaskItem.configure({ nested: true }),
        GithubAlert,
      ],
      export: { extensions: [alertMarkdown] },
    },
  ])
  const extensions = [...core, ...addons]
  const schema = getSchema(extensions)
  const manager = new MarkdownManager({
    extensions,
    marked: parser,
    markedOptions: options,
  })
  return { manager, schema }
}

const block = (type, ...content) => ({ type, content })
const paragraph = (text = '') =>
  block('paragraph', ...(text ? [{ type: 'text', text }] : []))
const taskItem = (checked, text = '', ...nested) => ({
  ...block('taskItem', paragraph(text), ...nested),
  attrs: { checked },
})
const listItem = (text, ...nested) =>
  block('listItem', paragraph(text), ...nested)

const taskFixtures = [
  ['- [ ]', [block('taskList', taskItem(false))]],
  ['- [ ] ', [block('taskList', taskItem(false))]],
  ['- [x]', [block('taskList', taskItem(true))]],
  ['- [X]', [block('taskList', taskItem(true))]],
  ['+ [x]', [block('taskList', taskItem(true))]],
  ['* [ ]', [block('taskList', taskItem(false))]],
  [
    '- [ ] a\n- [ ] b',
    [block('taskList', taskItem(false, 'a'), taskItem(false, 'b'))],
  ],
  [
    '- [ ] a\n- [ ]',
    [block('taskList', taskItem(false, 'a'), taskItem(false))],
  ],
  ['- [ ]\n- [ ]', [block('taskList', taskItem(false), taskItem(false))]],
  ['- [ ]\n- [x]', [block('taskList', taskItem(false), taskItem(true))]],
  [
    '- [ ]\n- [ ] a',
    [block('taskList', taskItem(false), taskItem(false, 'a'))],
  ],
  [
    '- a\n- [ ] b',
    [
      block('bulletList', listItem('a')),
      block('taskList', taskItem(false, 'b')),
    ],
  ],
  [
    '- a\n- [ ]',
    [block('bulletList', listItem('a')), block('taskList', taskItem(false))],
  ],
  [
    '- [ ]\n- a',
    [block('taskList', taskItem(false)), block('bulletList', listItem('a'))],
  ],
  [
    '- [x]\n- a\n- [ ]',
    [
      block('taskList', taskItem(true)),
      block('bulletList', listItem('a')),
      block('taskList', taskItem(false)),
    ],
  ],
  [
    '- parent\n  - [ ]\n  - [x] done',
    [
      block(
        'bulletList',
        listItem(
          'parent',
          block('taskList', taskItem(false), taskItem(true, 'done')),
        ),
      ),
    ],
  ],
  [
    '- [ ]\n  - child',
    [
      block(
        'taskList',
        taskItem(false, '', block('bulletList', listItem('child'))),
      ),
    ],
  ],
  [
    '- [ ]\n\n  - child',
    [
      block(
        'taskList',
        taskItem(false, '', block('bulletList', listItem('child'))),
      ),
    ],
  ],
  [
    '- [ ] a\n  - [ ]\n  - [x]',
    [
      block(
        'taskList',
        taskItem(
          false,
          'a',
          block('taskList', taskItem(false), taskItem(true)),
        ),
      ),
    ],
  ],
  [
    '> - [ ] a\n> - [ ]',
    [
      block(
        'blockquote',
        block('taskList', taskItem(false, 'a'), taskItem(false)),
      ),
    ],
  ],
  [
    '> - [ ]\n> - [x]',
    [block('blockquote', block('taskList', taskItem(false), taskItem(true)))],
  ],
  [
    '> [!NOTE]\n> - [ ]\n> - [X]',
    [block('githubAlert', block('taskList', taskItem(false), taskItem(true)))],
  ],
  [
    '- [ ]\n  lazy',
    [block('taskList', taskItem(false, '', paragraph('lazy')))],
  ],
  ['1. [ ]', [block('orderedList', listItem('[ ]'))]],
  ['- [ ]text', [block('bulletList', listItem('[ ]text'))]],
]

test('empty, mixed and nested task items parse and round-trip without changing source bytes', () => {
  const { manager, schema } = taskParser()
  for (const [fixture, expected] of taskFixtures) {
    for (const eol of ['\n', '\r\n']) {
      for (const ending of ['', eol]) {
        const source = fixture.replaceAll('\n', eol) + ending
        const doc = schema.nodeFromJSON(manager.parse(source))
        doc.check()
        assert.deepEqual(
          doc.toJSON(),
          schema.nodeFromJSON(block('doc', ...expected)).toJSON(),
          JSON.stringify(source),
        )
        const serialized = manager.serialize(doc.toJSON())
        assert.ok(schema.nodeFromJSON(manager.parse(serialized)).eq(doc))
        assert.equal(
          preserveRichSource(source, serialized, serialized, (candidate) =>
            schema.nodeFromJSON(manager.parse(candidate)).eq(doc),
          ),
          source,
        )
        const changed = structuredClone(doc.toJSON())
        let toggled = false
        const toggle = (node) => {
          if (!toggled && node.type === 'taskItem') {
            node.attrs.checked = !node.attrs.checked
            toggled = true
          }
          node.content?.forEach(toggle)
        }
        toggle(changed)
        // Native serialization lowercases [X]; byte-preserving toggles need
        // the same marker spelling in the original and serialized source.
        if (!toggled || source.match(/\[[ xX]\]/)?.[0] === '[X]') continue
        const after = schema.nodeFromJSON(changed)
        const edited = preserveRichSource(
          source,
          serialized,
          manager.serialize(changed),
          (candidate) =>
            schema.nodeFromJSON(manager.parse(candidate)).eq(after),
        )
        assert.equal(
          edited,
          source.replace(/\[([ xX])\]/, (_, checked) =>
            checked === ' ' ? '[x]' : '[ ]',
          ),
          JSON.stringify(source),
        )
      }
    }
  }
})

const lexer = {
  inlineTokens: (source) => [{ type: 'text', raw: source, text: source }],
  blockTokens: (source) => [{ type: 'paragraph', raw: source, text: source }],
}
const tokenize = (extension, source) =>
  getExtensionField(extension, 'markdownTokenizer').tokenize(source, [], lexer)

test('task tokenizer consumes consecutive empty items before the next block', () => {
  const extension = parseEmptyTaskItems(TaskList)
  for (const source of ['- [ ]\n- [ ]', '- [ ]\n- [x]', '- [ ] a\n- [ ]']) {
    const token = tokenize(extension, `${source}\n\n# after`)
    assert.equal(token.type, 'taskList')
    assert.equal(token.raw, `${source}\n`)
    assert.equal(token.items.length, 2)
  }
  const { manager } = taskParser()
  assert.equal(
    manager.serialize(manager.parse('- [ ]\n- [x]')),
    '- [ ] \n- [x] ',
  )
})

const cases = [
  '',
  'ordinary words',
  '# heading\n1. later',
  'text\n- [ ] later',
  '1. item',
  '42) item\n43) next',
  '0. zero',
  '001. leading zero',
  'a. alpha\nb. second',
  'AA) alpha\nAB) second',
  'iii. roman',
  'XIV) roman',
  'mMm. mixed roman',
  'abcd. not alpha',
  'ab1. not marker',
  '(216) phone',
  '216) 555-1234',
  '1.item',
  '1.\ntext',
  '1.\r\ntext',
  '1. item\n  2) nested\n\n  extra\n3. last',
  '1. item\nplain continuation\n\n# end',
  '- [ ] task',
  '* [x] task',
  '+ [X] task',
  '- [ ] ',
  '- [ ]',
  '- [] task',
  '- [xx] task',
  '- [y] task',
  '- [ ]task',
  '- \n[ ] task',
  '- [ ]\ntext',
  '- [ ] task\n  - [x] nested\n  - plain\n\n# end',
  '- plain\n- [ ] task',
  '- [ ] task\n- plain',
  'a'.repeat(12000),
  'prose '.repeat(12000),
  `${'i'.repeat(200)} no marker`,
]
for (const whitespace of [
  '',
  ' ',
  '\t',
  '\r',
  '\v',
  '\f',
  '\u00a0',
  '\u1680',
  '\u2000',
  '\u2028',
  '\u2029',
  '\ufeff',
  '\n',
  ' \n\t\n',
]) {
  for (const marker of [
    '1.',
    '123)',
    'aa.',
    'IV)',
    'AB.',
    '- [ ]',
    '* [x]',
    '+ [X]',
  ])
    for (const separator of [' ', '\t', '\r', '\u00a0', '\n', ''])
      cases.push(
        `${whitespace}${marker}${separator}item\n\nremaining paragraph`,
      )
}

test('prefix guards preserve installed ordered and task tokenizer results', () => {
  for (const original of [OrderedList, TaskList]) {
    const guarded = guardNativeListTokenizer(original)
    for (const source of cases)
      assert.deepEqual(
        tokenize(guarded, source),
        tokenize(original, source),
        `${original.name}: ${JSON.stringify(source.slice(0, 100))}`,
      )
  }
})

test('non-list prose never reaches native whole-tail splitting', (t) => {
  const source = `ordinary paragraph\n\n${'more words\n\n'.repeat(20000)}`
  const split = String.prototype.split
  let fullSplits = 0
  t.mock.method(String.prototype, 'split', function (...args) {
    if (String(this) === source && args[0] === '\n') fullSplits++
    return split.apply(this, args)
  })
  for (const extension of [OrderedList, TaskList]) {
    fullSplits = 0
    assert.equal(tokenize(extension, source), undefined)
    assert.equal(
      fullSplits,
      1,
      `${extension.name} baseline must exercise measured split`,
    )
    fullSplits = 0
    const guarded = guardNativeListTokenizer(extension)
    for (let index = 0; index < 100; index++)
      assert.equal(tokenize(guarded, source), undefined)
    assert.equal(
      fullSplits,
      0,
      `${extension.name} guard must reject before split`,
    )
  }
})

test('configured builtins retain options and custom addon tokenizers remain untouched', () => {
  for (const base of [OrderedList, TaskList]) {
    const extension = base.configure({
      itemTypeName: 'customItem',
      HTMLAttributes: { class: 'custom' },
    })
    const guarded = guardNativeListTokenizer(extension)
    assert.deepEqual(guarded.options, extension.options)
    assert.equal(guarded.name, extension.name)
    assert.equal(guarded.config.parseMarkdown, extension.config.parseMarkdown)
    const tokenizer = getExtensionField(extension, 'markdownTokenizer')
    assert.equal(
      getExtensionField(guarded, 'markdownTokenizer').start,
      tokenizer.start,
    )
    const custom = extension.extend({
      markdownTokenizer: {
        ...tokenizer,
        tokenize: () => ({ type: 'custom', raw: 'ordinary' }),
      },
    })
    assert.equal(guardNativeListTokenizer(custom), custom)
    assert.equal(parseEmptyTaskItems(custom), custom)
    assert.equal(tokenize(custom, 'ordinary').type, 'custom')
  }
  const unrelated = Node.create({ name: 'custom' })
  assert.equal(guardNativeListTokenizer(unrelated), unrelated)
})

test('the shared markdown factory guards native lists without wrapping addon replacements', (t) => {
  const source = `ordinary paragraph\n\n${'more words\n\n'.repeat(10000)}`
  const taskReplacement = TaskList.extend({
    markdownTokenizer: {
      ...getExtensionField(TaskList, 'markdownTokenizer'),
      tokenize: () => ({ type: 'custom', raw: 'ordinary' }),
    },
  })
  const configuration = markdownConfiguration([
    { id: 'github-markdown.github', richExtensions: [TaskList] },
    { id: 'custom.override', richExtensions: [taskReplacement] },
  ])
  const ordered = flattenExtensions(configuration.core).find(
    (extension) => extension.name === 'orderedList',
  )
  const split = String.prototype.split
  let fullSplits = 0
  t.mock.method(String.prototype, 'split', function (...args) {
    if (String(this) === source && args[0] === '\n') fullSplits++
    return split.apply(this, args)
  })
  assert.equal(tokenize(ordered, source), undefined)
  assert.equal(tokenize(configuration.addons[0], source), undefined)
  assert.equal(fullSplits, 0)
  assert.equal(configuration.addons[1], taskReplacement)
})

test('native list JSON remains identical through mixed lists, nested blocks and references', () => {
  const guardedStarter = StarterKit.extend({
    addExtensions() {
      return this.parent().map(guardNativeListTokenizer)
    },
  })
  const managers = [
    [StarterKit, TaskList, TaskItem],
    [guardedStarter, guardNativeListTokenizer(TaskList), TaskItem],
  ].map(
    (extensions) =>
      new MarkdownManager({ marked: new Marked({ gfm: true }), extensions }),
  )
  for (const source of [
    ...cases.slice(0, 34),
    '1. **bold**\n2. [ref]\n\n[ref]: /target',
    '[ref]: /first\n\n- [ ] [ref]\n  - [x] nested\n  1. numbered',
    '- ordinary\n- [ ] [ref]\n  - nested\n\n[ref]: /later',
    'AA) first\n  i. nested\n  ii. second\nAB) next\n\nparagraph',
    '> 1. quote\n> 2. next\n>\n> - [ ] task',
    'paragraph\n\n\n\n- [ ] task\n\ntrailing',
  ])
    assert.deepEqual(
      managers[1].parse(source),
      managers[0].parse(source),
      source,
    )
})
