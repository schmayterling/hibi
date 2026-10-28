import assert from 'node:assert/strict'
import test from 'node:test'
import { GFM, parser } from '@lezer/markdown'
import {
  getSchema,
  getText,
  getTextSerializersFromSchema,
  Node,
} from '@tiptap/core'
import { BlockMath, InlineMath } from '@tiptap/extension-mathematics'
import { Strike } from '@tiptap/extension-strike'
import { TableKit } from '@tiptap/extension-table'
import { TaskItem } from '@tiptap/extension-task-item'
import { TaskList } from '@tiptap/extension-task-list'
import { MarkdownManager } from '@tiptap/markdown'
import { markedGithubFootnote } from 'marked-github-footnote'
import { alertMarkdown } from '../src/addons/markdown/alerts.ts'
import { GithubAlert } from '../src/addons/markdown/GithubAlert.ts'
import {
  ObsidianHighlight,
  obsidianMarkdown,
  WikiEmbed,
  WikiLink,
} from '../src/addons/markdown/obsidian.ts'
import {
  blockMath,
  blockMathStart,
  inlineMath,
  mathTokens,
} from '../src/addons/math/syntax.ts'
import { mermaidMarkdown } from '../src/addons/mermaid/markdown.ts'
import { Subscript, Subtext } from '../src/addons/text-extras/nodes.ts'
import { textExtrasMarkdown } from '../src/addons/text-extras/syntax.ts'
import { typstBlock, typstTokens } from '../src/addons/typst/syntax.ts'
import { countText } from '../src/addons/word-count/count.ts'
import { FormattedCounter } from '../src/addons/word-count/formatted-counter.ts'
import { richText } from '../src/addons/word-count/formatted-text.ts'
import { documentImage } from '../src/renderer/src/DocumentImage.ts'
import { editorExtensions } from '../src/renderer/src/markdown.ts'
import { markdownSyntax } from '../src/renderer/src/markdown-syntax.ts'
import { defaultNoteSyntax } from '../src/shared/note-syntax.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'

const flavors = [
  {
    id: 'markdown.github',
    markedOptions: { gfm: true },
    richExtensions: [
      GithubAlert,
      Strike,
      TableKit.configure({ table: { resizable: false } }),
      TaskList,
      TaskItem.configure({ nested: true }),
    ],
    export: { extensions: [alertMarkdown, markedGithubFootnote()] },
  },
  {
    id: 'markdown.obsidian',
    richExtensions: [ObsidianHighlight, WikiLink, WikiEmbed],
    export: { extensions: [obsidianMarkdown] },
  },
  {
    id: 'text-extras.text-extras',
    richExtensions: [Subscript, Subtext],
    export: { extensions: [textExtrasMarkdown] },
  },
]
flavors.push({
  id: 'math.latex',
  richExtensions: [
    BlockMath.extend({
      markdownTokenizer: {
        name: 'blockMath',
        level: 'block',
        start: blockMathStart,
        tokenize: blockMath,
      },
    }),
    InlineMath.extend({
      markdownTokenizer: {
        name: 'inlineMath',
        level: 'inline',
        start: (source) => source.indexOf('$'),
        tokenize: inlineMath,
      },
    }),
  ],
  export: { extensions: [mathTokens] },
})
function native(source, selected = flavors) {
  const freshFlavors = selected.map((flavor) =>
    flavor.id === 'markdown.github'
      ? {
          ...flavor,
          export: { extensions: [alertMarkdown, markedGithubFootnote()] },
        }
      : flavor,
  )
  const extensions = [...editorExtensions(freshFlavors), documentImage(0)]
  const markdown = extensions.find((extension) => extension.name === 'markdown')
  const manager = new MarkdownManager({
    extensions,
    marked: markdown.options.marked,
    markedOptions: markdown.options.markedOptions,
  })
  const schema = getSchema(extensions)
  return getText(schema.nodeFromJSON(manager.parse(source)), {
    blockSeparator: '\n',
    textSerializers: getTextSerializersFromSchema(schema),
  })
}

for (const source of [
  '> [!NOTE]\n> a\n>\n>\n>\n> b',
  '> [!NOTE]\n>\n>\n> a\n>\n>',
  '- a\n  -\n nested',
  '1. o \n\n2. two',
  '[^a]: note\n\n- [ ] text[^a]',
  '[ref]: /target\n\n- [ ] [some words][ref]',
])
  test(`list projection preserves rich block structure: ${JSON.stringify(source)}`, () => {
    const syntax = {
      ...defaultNoteSyntax,
      alerts: true,
      math: true,
      textExtras: true,
    }
    assert.equal(richText(source, syntax).slice(1), native(source))
  })

for (const [source, formatted, rich] of [
  ['- [ ] text[^a]\n\n[^a]: note', '\n\ntext\nnote', '\n\ntext[^a]\nnote'],
  [
    '- [ ] [some words][ref]\n\n[ref]: /target',
    '\n\nsome words',
    '\n\n[some words][ref]',
  ],
  [
    '- [ ] [label][ref]\n\n[ref]: https://example.test',
    '\n\nlabel',
    '\n\n[label][ref]',
  ],
])
  test(`task forward references retain Markdown semantics: ${JSON.stringify(source)}`, () => {
    // tiptap tokenizes task text before later definitions; valid forward links still resolve.
    assert.equal(
      richText(source, {
        ...defaultNoteSyntax,
        math: true,
        textExtras: true,
        alerts: true,
      }).slice(1),
      formatted,
    )
    assert.equal(native(source), rich)
  })

test('disabled bullets stay literal beside active task lists', () => {
  const source = '- [ ] task\n\n- a\n  - nested'
  markdownSyntax.setEnabled('core.bullet-lists', false)
  try {
    const syntax = {
      ...defaultNoteSyntax,
      disabledFeatures: ['core.bullet-lists'],
    }
    assert.equal(richText(source, syntax).slice(1), native(source))
  } finally {
    markdownSyntax.reset()
  }
})

test('tab-separated task markers match the rendered task text and counts', () => {
  for (const source of [
    '- [ ] a\n- [ ]\tbuy milk',
    '- [x]\tbuy milk',
    '* [X]\tbuy milk',
    '+ [ ]\tbuy milk',
    '- [ ] \tbuy milk',
    '- [ ]\tbuy milk\n  continuation',
    '- [ ]\tbuy milk\n  - [ ]\tnested',
    '- [ ]text\n- [z]\tbuy milk',
    '1. [ ]\tbuy milk',
  ]) {
    const expected = native(source)
    const counter = new FormattedCounter(
      new SourceStore(source, { tabId: 'tasks', revision: 0 }),
      defaultNoteSyntax,
    )
    try {
      const work = counter.read()
      let step
      do step = work.next()
      while (!step.done)
      assert.deepEqual(step.value, countText(expected), source)
      assert.equal(
        richText(source, defaultNoteSyntax).slice(1),
        expected,
        source,
      )
    } finally {
      counter.dispose()
    }
  }
})

test('indented code in list items stays literal instead of becoming a task', () => {
  for (const [source, characters] of [
    ['-     [ ] x', 7],
    ['-     [ ]\tx', 7],
    ['-\t\t[ ] x', 9],
  ]) {
    const item = parser
      .configure(GFM)
      .parse(source)
      .topNode.getChild('BulletList')
      ?.getChild('ListItem')
    assert.ok(item?.getChild('CodeBlock'), source)
    assert.equal(item?.getChild('Task'), null, source)
    const counter = new FormattedCounter(
      new SourceStore(source, { tabId: 'code-item', revision: 0 }),
      defaultNoteSyntax,
    )
    try {
      const work = counter.read()
      let step
      do step = work.next()
      while (!step.done)
      assert.deepEqual(step.value, { words: 1, characters }, source)
      assert.deepEqual(countText(native(source)), { words: 1, characters: 3 })
    } finally {
      counter.dispose()
    }
  }
})

test('list and definition projection differences stay explicit', () => {
  for (const [source, formatted, rich] of [
    ['1. e\n=', [1, 3], [1, 4]],
    ['1. 2.', [0, 3], [0, 4]],
    ['2.\n    e', [1, 3], [1, 4]],
    ['- [ ]\n ', [0, 2], [0, 3]],
    ['1. one\n2.\n two', [2, 11], [3, 12]],
    ['1. one\n[^a]:', [1, 5], [2, 11]],
  ])
    for (const gfm of source === '1. one\n2.\n two' ? [false, true] : [true]) {
      const counter = new FormattedCounter(
        new SourceStore(source, { tabId: 'lists', revision: 0 }),
        { ...defaultNoteSyntax, gfm },
      )
      try {
        const work = counter.read()
        let step
        do step = work.next()
        while (!step.done)
        assert.deepEqual(
          [step.value.words, step.value.characters],
          formatted,
          source,
        )
        const expected = countText(
          native(
            source,
            gfm
              ? flavors
              : flavors.filter((flavor) => flavor.id !== 'markdown.github'),
          ),
        )
        assert.deepEqual([expected.words, expected.characters], rich, source)
      } finally {
        counter.dispose()
      }
    }
})

test('disabled syntax remains literal in document totals', () => {
  for (const [source, feature, expected] of [
    ['one **bold**', 'core.bold', 'one **bold**'],
    ['# title', 'core.heading-1', '# title'],
    ['[link](target)', 'core.links', '[link](target)'],
    ['~sub~', 'text-extras.subscript', '~sub~'],
    ['-# small', 'text-extras.subtext', '-# small'],
  ])
    assert.equal(
      richText(source, {
        ...defaultNoteSyntax,
        textExtras: true,
        disabledFeatures: [feature],
      }).slice(1),
      expected,
    )
})

for (const language of ['mermaid', 'typst'])
  test(`${language} fences retain native opaque, disabled and ordinary-code counts`, () => {
    const name = `${language}Block`
    const node = Node.create({
      name,
      group: 'block',
      atom: true,
      addAttributes: () => ({ source: { default: '' }, raw: { default: '' } }),
      ...(language === 'mermaid'
        ? mermaidMarkdown
        : {
            markdownTokenName: 'typstBlock',
            markdownTokenizer: {
              name,
              level: 'block',
              start: (source) =>
                source.search(/^ {0,3}(?:`{3,}|~{3,})typst[ \t]*\r?$/im),
              tokenize: typstBlock,
            },
            parseMarkdown: (token, helpers) =>
              helpers.createNode(name, {
                source: token.source,
                raw: token.raw,
              }),
          }),
    })
    const flavor = {
      id: `${language}.blocks`,
      richExtensions: [node],
      ...(language === 'typst'
        ? { export: { extensions: [typstTokens] } }
        : {}),
    }
    const remove = markdownSyntax.register(language, {
      id: 'blocks',
      label: language,
      group: language,
      level: 'block',
      extensions: [name],
      matches: (token) =>
        language === 'mermaid'
          ? token.type === 'code' && token.lang === 'mermaid'
          : token.type === 'typstBlock' ||
            (token.type === 'code' && /^typst(?:\s|$)/i.test(token.lang ?? '')),
    })
    try {
      for (const disabled of [
        [],
        [`${language}.blocks`],
        ['core.code-blocks'],
      ]) {
        markdownSyntax.reset()
        for (const feature of disabled)
          markdownSyntax.setEnabled(feature, false)
        for (const active of [true, false]) {
          const config = {
            ...defaultNoteSyntax,
            [language]: active,
            disabledFeatures: disabled,
          }
          for (const source of [
            `\`\`\`${language}\nx\n\`\`\``,
            `before\n\n\`\`\`${language}\nx\n\`\`\`\n\nafter`,
            `before\r\n\r\n~~~${language.toUpperCase()}\r\nx\r\n~~~\r\n\r\nafter`,
            `~~~${language[0].toUpperCase()}${language.slice(1)}\nx\n~~~`,
            `before\n\n\`\`\`${language}\nx\n\nafter`,
            `\`\`\`${language} extra\nx\n\`\`\``,
            `> \`\`\`${language}\n> x\n> \`\`\`\n\nafter`,
            `- before\n\n  \`\`\`${language}\n  x\n  \`\`\`\n\nafter`,
            `before\n\n~~~${language}\nx\n~~~\t\n\nafter`,
            ...(active && !disabled.length
              ? [
                  `before\n\n ~~~${language}\nx\n ~~~\t\n\nafter`,
                  `before\n\n   ~~~${language}\nx\n   ~~~ \t \n\nafter`,
                ]
              : []),
            `> ~~~${language}\n> x\n> ~~~\t\n> tail\n\nafter`,
            `- before\n\n  ~~~${language}\n  x\n  ~~~\t\n  tail\n\nafter`,
            '```js\nordinary code\n```',
          ]) {
            const expected = native(
              source,
              active ? [...flavors, flavor] : flavors,
            )
            const label = JSON.stringify({ language, active, disabled, source })
            assert.equal(richText(source, config).slice(1), expected, label)
            const counter = new FormattedCounter(
              new SourceStore(source, { tabId: 'fences', revision: 0 }),
              config,
            )
            try {
              const work = counter.read()
              let step
              do {
                step = work.next()
              } while (!step.done)
              assert.deepEqual(step.value, countText(expected), label)
            } finally {
              counter.dispose()
            }
          }
        }
      }
    } finally {
      remove()
      markdownSyntax.reset()
    }
  })

test('ordinary indented fences retain Marked text despite the native schema omission', () => {
  const source = 'before\n\n ~~~js\nx\n ~~~\t\n\nafter'
  assert.equal(native(source), 'before')
  assert.equal(
    richText(source, defaultNoteSyntax).slice(1),
    'before\nx\n ~~~\t\n\nafter',
  )
})

test('formatted text and counts match the rich view', () => {
  for (const source of [
    '',
    'words **bold** and *em*.',
    '# heading\n\ntext',
    'one\nsoft\n\nbreak  \nhard',
    'one\n\n\n\ntwo',
    '- one\n- two\n  - nested',
    '3. three\n4. four',
    '> quote\n>\n> second',
    '- [ ] todo\n- [x] done',
    '| a | b |\n|---|---|\n| c | d |',
    '---\n\nlast',
    '`inline`\n\n```js\nconst x = 1\n```',
    'a &amp; &#x1f600; café 👩🏽‍💻',
    '<kbd>raw</kbd>',
    '[[Other|shown]] and ==marked==',
    '![[Other]]',
    'before ![[Other]] after',
    'before $x+y$ after\n\n$$\nx=y\n$$',
    'footnote[^one]\n\n[^one]: definition',
    'footnote[^some]\n\n[^Some]: definition',
    'plain[^missing]',
    'footnote[^list]\n\n[^list]: one\n\n    second paragraph',
    'H~2~O\n\n-# small words',
    '![image](a.png)\n\na ![inline](b.png) b',
    '[label][ref]\n\n[ref]: https://example.test',
  ]) {
    const expected = native(source)
    const actual = richText(source, {
      ...defaultNoteSyntax,
      textExtras: true,
      alerts: true,
      math: true,
    }).slice(1)
    assert.equal(actual, expected, JSON.stringify(source))
    assert.deepEqual(
      countText(actual),
      countText(expected),
      JSON.stringify(source),
    )
  }
})
