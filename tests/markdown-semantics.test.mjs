import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getSchema,
  getText,
  getTextSerializersFromSchema,
  Node,
} from '@tiptap/core'
import { Strike } from '@tiptap/extension-strike'
import { TableKit } from '@tiptap/extension-table'
import { TaskItem } from '@tiptap/extension-task-item'
import { TaskList } from '@tiptap/extension-task-list'
import { MarkdownManager } from '@tiptap/markdown'
import { EditorState } from '@tiptap/pm/state'
import { Marked } from 'marked'
import { alertMarkdown } from '../src/addons/markdown/alerts.ts'
import { GithubAlert } from '../src/addons/markdown/GithubAlert.ts'
import { Subscript, Subtext } from '../src/addons/text-extras/nodes.ts'
import { textExtrasMarkdown } from '../src/addons/text-extras/syntax.ts'
import { documentImage } from '../src/renderer/src/DocumentImage.ts'
import { editorExtensions } from '../src/renderer/src/markdown.ts'
import { createMarkdownSemantics } from '../src/renderer/src/markdown-semantics.ts'
import { markdownSyntax } from '../src/renderer/src/markdown-syntax.ts'

const flavors = [
  {
    id: 'github-markdown.github',
    markedOptions: { gfm: true },
    richExtensions: [
      GithubAlert,
      Strike,
      TableKit.configure({ table: { resizable: false } }),
      TaskList,
      TaskItem.configure({ nested: true }),
    ],
    export: { extensions: [alertMarkdown] },
  },
  {
    id: 'text-extras.text-extras',
    richExtensions: [Subscript, Subtext],
    export: { extensions: [textExtrasMarkdown] },
  },
]
const context = { before: false, after: false }
const tokens = (source, taskGrammar = false) => {
  const parser = new Marked({ gfm: true }, alertMarkdown, textExtrasMarkdown)
  if (taskGrammar)
    new MarkdownManager({ marked: parser, extensions: [TaskList, TaskItem] })
  return structuredClone([
    ...new parser.Lexer({ ...parser.defaults, tokenizer: null }).lex(source),
  ])
}
function fullParser() {
  const extensions = [
    ...editorExtensions(flavors),
    ...(markdownSyntax.enabled('core.images') ? [documentImage(0)] : []),
  ]
  const markdown = extensions.find((extension) => extension.name === 'markdown')
  const manager = new MarkdownManager({
    extensions,
    marked: markdown.options.marked,
    markedOptions: markdown.options.markedOptions,
  })
  const schema = getSchema(extensions)
  return (source) => {
    const json = manager.parse(source),
      doc = schema.nodeFromJSON(json)
    return {
      json,
      text: getText(doc, {
        blockSeparator: '\n',
        textSerializers: getTextSerializersFromSchema(schema),
      }),
    }
  }
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value)) freeze(child)
  }
  return value
}

test('schema-only consumption matches current editor declarations without creating editor state', (t) => {
  t.mock.method(EditorState, 'create', () => {
    throw new Error('Semantic conversion must not create editor state.')
  })
  const readFull = fullParser(),
    reader = createMarkdownSemantics(flavors, 0)
  assert.ok(reader)
  for (const source of [
    '',
    '# title\n\nwords **bold**, *italic*, and `code`.',
    '## **bold** [link](https://example.com) 😀\n\nlast',
    'one  \ntwo\n\n---\n\n```js\nconst x = 1\n```',
    '> quote\n>\n> ## nested heading\n>\n> - item',
    '- ordinary\n- items',
    '| a | b |\n|---|---|\n| c | d |',
    '> [!WARNING]\n> **careful**',
    'H~2~O and ~~strike~~\n\n-# small **words**',
    '![photo](image.png "caption")',
    'one\n\n\n\ntwo',
    'é 👩🏽‍💻 &amp; &#13;',
  ]) {
    const input = freeze(tokens(source)),
      serialized = JSON.stringify(input),
      actual = reader.read(input, context),
      expected = readFull(source)
    assert.ok(actual, source)
    assert.deepEqual(actual.json, expected.json, source)
    assert.equal(actual.text, expected.text, source)
    assert.equal(actual.blockCount, actual.json.content.length)
    assert.equal(JSON.stringify(input), serialized)
  }
  const result = reader.read(tokens('# title\n\nwords\n\n## second'), context)
  assert.equal(result.text, 'title\nwords\nsecond')
  assert.deepEqual(result.headings, [
    { position: 0, label: 'title', level: 1 },
    { position: 14, label: 'second', level: 2 },
  ])
})

test('explicit neighboring-token context preserves implicit empty paragraphs', () => {
  const reader = createMarkdownSemantics(flavors, 0),
    readFull = fullParser(),
    parts = ['# first\n\n\n\n', 'middle\n\n\n\n', '# last\n']
  const content = parts.flatMap(
    (part, index) =>
      reader.read(tokens(part), {
        before: index > 0,
        after: index < parts.length - 1,
      }).json.content,
  )
  assert.deepEqual(content, readFull(parts.join('')).json.content)
})

test('public task tokenizer output consumes without native source re-lexing', () => {
  const reader = createMarkdownSemantics(flavors, 0),
    readFull = fullParser()
  for (const source of [
    '- [ ] todo\n- [x] done',
    '- [ ] **bold** H~2~O\n  - [x] nested\n  - ordinary',
    '> - [ ] quote task\n> - [x] complete',
    '- [ ] task\n- ordinary',
  ]) {
    const actual = reader.read(tokens(source, true), context),
      expected = readFull(source)
    assert.ok(actual, source)
    assert.deepEqual(actual.json, expected.json, source)
    assert.equal(actual.text, expected.text, source)
  }
  // Marked consumes this as a mixed list before the task tokenizer can run.
  assert.equal(
    reader.read(tokens('- ordinary\n- [ ] task', true), context),
    null,
  )
  assert.equal(
    reader.read(
      tokens('- [ ] task\n  - ordinary\n  - [ ] nested', true),
      context,
    ),
    null,
  )
})

test('syntax masking preserves input tokens and stale consumers refuse results', () => {
  const previous = createMarkdownSemantics(flavors, 0)
  try {
    markdownSyntax.setEnabled('core.bold', false)
    markdownSyntax.setEnabled('core.heading-1', false)
    markdownSyntax.setEnabled('core.images', false)
    const input = freeze(
      tokens('# heading\n\n**bold** and ![photo](image.png)'),
    )
    assert.equal(previous.read(input, context), null)
    const actual = createMarkdownSemantics(flavors, 0).read(input, context),
      expected = fullParser()('# heading\n\n**bold** and ![photo](image.png)')
    assert.deepEqual(actual.json, expected.json)
    assert.equal(actual.text, '# heading\n**bold** and ![photo](image.png)')
    assert.deepEqual(actual.headings, [])
    assert.equal(input[0].type, 'heading')
  } finally {
    for (const id of ['core.bold', 'core.heading-1', 'core.images'])
      markdownSyntax.setEnabled(id, true)
  }
})

test('unknown addon grammar, missing native DOM, and task lists use compatibility path', () => {
  const unknown = {
    id: 'custom.rich-only',
    richExtensions: [
      Node.create({
        name: 'custom',
        addStorage() {
          throw new Error('Unsupported addon hooks must not run.')
        },
      }),
    ],
  }
  assert.equal(createMarkdownSemantics([unknown], 0), null)
  const reader = createMarkdownSemantics(flavors, 0)
  assert.equal(reader.read(tokens('<em>native html</em>'), context), null)
  assert.equal(
    reader.read(tokens('- [ ] <em>native html</em>', true), context),
    null,
  )
  assert.equal(reader.read(tokens('- [ ] todo\n- [x] done'), context), null)
  assert.equal(reader.read(tokens('- [ ] task\n- ordinary'), context), null)
  assert.equal(reader.read(tokens('still works'), context).text, 'still works')
})

test('pre-tokenized task grammar requires its native schema to be enabled', () => {
  const unregister = markdownSyntax.register('semantic-fixture', {
    id: 'tasks',
    label: 'Tasks',
    group: 'Tests',
    level: 'block',
    extensions: ['taskList', 'taskItem'],
    matches: (token) =>
      token.type === 'list' && token.items.some((item) => item.task),
  })
  try {
    markdownSyntax.setEnabled('semantic-fixture.tasks', false)
    const reader = createMarkdownSemantics(flavors, 0)
    assert.equal(reader.read(tokens('- [ ] task', true), context), null)
    assert.equal(reader.read(tokens('- [ ] task'), context).text, '- [ ] task')
  } finally {
    markdownSyntax.setEnabled('semantic-fixture.tasks', true)
    unregister()
  }
})

test('native handlers cannot re-lex missing source context and failed reads release tokens', () => {
  const extension = Node.create({
    name: 'inlineRequest',
    group: 'block',
    content: 'text*',
    markdownTokenName: 'inlineRequest',
    parseMarkdown: (token, helpers) =>
      helpers.createNode(
        'inlineRequest',
        {},
        helpers.parseInline(helpers.tokenizeInline(token.raw)),
      ),
  })
  const reader = createMarkdownSemantics(
    [{ id: 'text-extras.text-extras', richExtensions: [extension] }],
    0,
  )
  assert.equal(
    reader.read([{ type: 'inlineRequest', raw: 'text' }], context),
    null,
  )
  assert.equal(reader.read(tokens('still works'), context).text, 'still works')
})
