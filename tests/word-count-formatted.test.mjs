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
import { typstMarkdown } from '../src/addons/typst/markdown.ts'
import { typstTokens } from '../src/addons/typst/syntax.ts'
import { countText } from '../src/addons/word-count/count.ts'
import { FormattedCounter } from '../src/addons/word-count/formatted-counter.ts'
import { richText } from '../src/addons/word-count/formatted-text.ts'
import { documentImage } from '../src/renderer/src/DocumentImage.ts'
import { editorExtensions } from '../src/renderer/src/markdown.ts'
import { markdownSyntax } from '../src/renderer/src/markdown-syntax.ts'
import { markedGithubFootnote } from '../src/shared/marked-footnotes.ts'
import { defaultNoteSyntax } from '../src/shared/note-syntax.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'
import {
  customBodyBoldCases,
  customBodyCases,
} from './fixtures/custom-body.mjs'

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
markdownSyntax.register('markdown', {
  id: 'strike',
  label: 'Strikethrough',
  group: 'Markdown',
  level: 'inline',
  extensions: ['strike'],
  nodes: ['Strikethrough'],
  matches: (token) => token.type === 'del',
})

function nativeDocument(source, selected = flavors) {
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
  return schema.nodeFromJSON(manager.parse(source))
}

function native(source, selected = flavors) {
  const document = nativeDocument(source, selected)
  return getText(document, {
    blockSeparator: '\n',
    textSerializers: getTextSerializersFromSchema(document.type.schema),
  })
}

for (const fixture of customBodyCases)
  test(`custom body native model: ${fixture.name}`, () => {
    markdownSyntax.reset()
    if (fixture.feature) markdownSyntax.setEnabled(fixture.feature, false)
    try {
      const document = nativeDocument(fixture.source)
      assert.equal(native(fixture.source), fixture.text)
      const nodes = [],
        marks = []
      document.descendants((node) => {
        nodes.push(node.type.name)
        marks.push(...node.marks.map((mark) => mark.type.name))
      })
      if (fixture.feature === 'markdown.strike')
        assert.ok(!marks.includes('strike'))
      if (fixture.feature === 'core.italic')
        assert.ok(!marks.includes('italic'))
      if (fixture.feature === 'core.links') assert.ok(!marks.includes('link'))
      if (fixture.feature === 'core.bold') assert.ok(!marks.includes('bold'))
      if (fixture.feature === 'core.heading-1')
        assert.ok(nodes.includes('heading'))
      if (fixture.name === 'subscript bold')
        assert.ok(marks.includes('subscript'))
      if (fixture.name === 'alert task') assert.ok(nodes.includes('taskItem'))
      if (fixture.name === 'bullet alert')
        assert.equal(
          document.firstChild.firstChild.firstChild.firstChild.text,
          '**x** y',
        )
      if (fixture.name === 'ordered alert') {
        assert.deepEqual(
          nodes.filter((name) => name !== 'text'),
          [
            'orderedList',
            'listItem',
            'paragraph',
            'githubAlert',
            'paragraph',
            'blockquote',
            'paragraph',
          ],
        )
        assert.ok(marks.includes('bold'))
      }
      const syntax = {
        ...defaultNoteSyntax,
        alerts: true,
        textExtras: true,
        disabledFeatures: fixture.feature ? [fixture.feature] : [],
      }
      assert.equal(richText(fixture.source, syntax).slice(1), fixture.text)
      const counter = new FormattedCounter(
        new SourceStore(fixture.source, { tabId: 'custom-body', revision: 0 }),
        syntax,
      )
      try {
        let step
        const work = counter.read()
        do step = work.next()
        while (!step.done)
        assert.deepEqual(step.value, countText(fixture.text))
      } finally {
        counter.dispose()
      }
    } finally {
      markdownSyntax.reset()
    }
  })

for (const paragraphs of [32, 2048])
  test(`custom body edits retain bounded regional counts with ${paragraphs} neighbours`, (t) => {
    const prefix = 'padding block\n\n'.repeat(paragraphs)
    const fixture = customBodyCases.find((entry) => entry.name === 'alert task')
    const syntax = {
      ...defaultNoteSyntax,
      alerts: true,
      textExtras: true,
      disabledFeatures: ['core.bold'],
    }
    const source = `${prefix}${fixture.source}\n\nend`
    const counter = new FormattedCounter(
      new SourceStore(source, { tabId: 'bounded-custom', revision: 0 }),
      syntax,
    )
    const read = () => {
      const work = counter.read()
      let step
      do step = work.next()
      while (!step.done)
      return step.value
    }
    const edit = (from, to, insert) => {
      const snapshot = counter.store.snapshot()
      counter.apply({
        document: snapshot.document,
        operationId: `body-${snapshot.version}`,
        baseVersion: snapshot.version,
        contentVersion: snapshot.version + 1,
        origin: 'source',
        historyGroup: 'custom-body',
        changes: [{ from, to, insert }],
      })
    }
    try {
      const initial = read()
      const at = prefix.length + fixture.source.length
      counter.counters(true)
      edit(at, at, ' proof')
      assert.deepEqual(read(), {
        words: initial.words + 1,
        characters: initial.characters + 6,
      })
      const work = counter.counters()
      assert.ok(work.countedUnits < 2048, JSON.stringify(work))
      assert.ok(work.source.sourceUnitsRead < 16384, JSON.stringify(work))
      assert.equal(work.source.materializations, 0)
      assert.equal(work.source.materializedUnits, 0)
      t.diagnostic(JSON.stringify({ paragraphs, work }))
      edit(at, at + 6, '')
      assert.deepEqual(read(), initial)
    } finally {
      counter.dispose()
    }
  })

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

test('mid-line display math is excluded from counts while literal dollars stay', () => {
  const syntax = { ...defaultNoteSyntax, math: true }
  for (const [source, text] of [
    ['before $$x+y$$ after', 'before  after'],
    ['before $$x$$$5 after', 'before $5 after'],
    ['before $$a+b$$$c+d$ after', 'before  after'],
    ['`$$x+y$$` costs $5 and $10', '$$x+y$$ costs $5 and $10'],
    [String.raw`before \$$x+y$$ after`, 'before $$x+y$$ after'],
  ])
    assert.deepEqual(
      countText(richText(source, syntax).slice(1)),
      countText(text),
      source,
    )
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

test('custom alert and subtext bodies retain native text with disabled bold', () => {
  const disabledFeatures = ['core.heading-1', 'core.bold', 'core.images']
  for (const feature of disabledFeatures)
    markdownSyntax.setEnabled(feature, false)
  try {
    for (const body of ['> [!TIP]\n> **careful**', '-# small **words**']) {
      const source = `**outside**\n\n${body}\n\n# after`
      const syntax = {
        ...defaultNoteSyntax,
        alerts: true,
        textExtras: true,
        disabledFeatures,
      }
      const expected = native(source)
      assert.equal(richText(source, syntax).slice(1), expected)
      const counter = new FormattedCounter(
        new SourceStore(source, { tabId: 'flavor', revision: 0 }),
        syntax,
      )
      try {
        const work = counter.read()
        let step
        do step = work.next()
        while (!step.done)
        assert.deepEqual(step.value, countText(expected))
      } finally {
        counter.dispose()
      }
    }
  } finally {
    markdownSyntax.reset()
  }
})

for (const [feature, bodies] of [
  [
    'core.italic',
    [
      ['> [!TIP]\n> *careful*', 'careful'],
      ['-# small *words*', 'small words'],
    ],
  ],
  [
    'markdown.strike',
    [
      ['> [!TIP]\n> ~~gone~~', 'gone'],
      ['-# small ~~words~~', 'small words'],
    ],
  ],
  [
    'core.links',
    [
      ['> [!TIP]\n> [a](https://b.test)', 'a'],
      ['-# small [a](https://b.test)', 'small a'],
    ],
  ],
  ['core.heading-1', [['> [!TIP]\n> # head', 'head']]],
])
  test(`custom bodies keep native ${feature} in counts`, () => {
    for (const [source, text] of bodies) {
      const syntax = {
        ...defaultNoteSyntax,
        alerts: true,
        textExtras: true,
        disabledFeatures: [feature],
      }
      const expected = (source.startsWith('>') ? '\n' : '') + text
      assert.equal(richText(source, syntax).slice(1), expected)
      const counter = new FormattedCounter(
        new SourceStore(source, { tabId: 'custom', revision: 0 }),
        syntax,
      )
      try {
        const work = counter.read()
        let step
        do step = work.next()
        while (!step.done)
        assert.deepEqual(step.value, countText(expected))
      } finally {
        counter.dispose()
      }
    }
  })

test('list-nested alerts keep disabled bold literal while subtext owns its body', () => {
  markdownSyntax.setEnabled('core.bold', false)
  try {
    for (const source of [
      '- > [!TIP]\n  > **x**',
      '1. > [!TIP]\n   > **x**',
      '- -# small **words**',
    ]) {
      const expected = native(source)
      assert.equal(
        richText(source, {
          ...defaultNoteSyntax,
          alerts: true,
          textExtras: true,
          disabledFeatures: ['core.bold'],
        })
          .slice(1)
          .trim(),
        expected.trim(),
        source,
      )
      assert.equal(
        expected.includes('**'),
        !source.includes('-# small'),
        source,
      )
    }
  } finally {
    markdownSyntax.reset()
  }
})

test('custom subscript bodies preserve native inline mark parsing', () => {
  markdownSyntax.setEnabled('core.bold', false)
  try {
    const source = 'H~**2**~O'
    assert.equal(native(source), 'H2O')
    assert.equal(
      richText(source, {
        ...defaultNoteSyntax,
        textExtras: true,
        disabledFeatures: ['core.bold'],
      }).slice(1),
      'H2O',
    )
  } finally {
    markdownSyntax.reset()
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
      ...(language === 'mermaid' ? mermaidMarkdown : typstMarkdown),
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
          : token.type === 'code' && /^typst(?:\s|$)/i.test(token.lang ?? ''),
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
            `> \`\`\`${language}\n> x\n> \`\`\`\noutside\n===\n\n# real`,
            `> \`\`\`${language}\r\n> x\r\n> \`\`\`\r\noutside\r\n===\r\n\r\n# real`,
            `- before\n\n  \`\`\`${language}\n  x\n  \`\`\`\n\nafter`,
            `before\n\n~~~${language}\nx\n~~~\t\n\nafter`,
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
  for (const language of ['js', 'typst'])
    for (const [indent, suffix] of [
      [' ', '\t'],
      ['   ', ' \t '],
    ]) {
      const source = `before\n\n${indent}~~~${language}\nx\n${indent}~~~${suffix}\n\nafter`
      assert.equal(native(source), 'before')
      assert.equal(
        richText(source, { ...defaultNoteSyntax, typst: true }).slice(1),
        `before\nx\n${indent}~~~${suffix}\n\nafter`,
      )
    }
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

test('rich view keeps headings after custom leaves outside containers', () => {
  // Tiptap copies tokenizer results; leaf identity must survive the copy.
  for (const source of [
    '> $$\n> x\n> $$\noutside\n===\n',
    '> -# small\noutside\n===\n',
    '- $$\n  x\n  $$\noutside\n===\n',
    '- -# small\noutside\n===\n',
    '> > [!NOTE]\n> > ```\n> > x\n> > ```\noutside\n===\n',
  ]) {
    const document = nativeDocument(source)
    const headings = []
    document.forEach((node) => {
      if (node.type.name === 'heading') headings.push(node.textContent)
    })
    assert.deepEqual(headings, ['outside'], source)
    assert.equal(
      richText(source, {
        ...defaultNoteSyntax,
        textExtras: true,
        alerts: true,
        math: true,
      }).slice(1),
      native(source),
      source,
    )
  }
})

for (const fixture of customBodyBoldCases)
  test(`custom body bold counts: ${fixture.name}`, () => {
    markdownSyntax.setEnabled('core.bold', false)
    try {
      for (const suffix of ['', '\n\ntail']) {
        const source = fixture.source + suffix
        const expected = fixture.text + (suffix ? '\ntail' : '')
        assert.equal(native(source), expected, source)
        const syntax = {
          ...defaultNoteSyntax,
          alerts: true,
          textExtras: true,
          disabledFeatures: ['core.bold'],
        }
        assert.equal(richText(source, syntax).slice(1), expected, source)
        const counter = new FormattedCounter(
          new SourceStore(source, { tabId: 'custom-count', revision: 0 }),
          syntax,
        )
        try {
          const work = counter.read()
          let step
          do step = work.next()
          while (!step.done)
          assert.deepEqual(step.value, countText(expected), source)
        } finally {
          counter.dispose()
        }
      }
    } finally {
      markdownSyntax.setEnabled('core.bold', true)
    }
  })
