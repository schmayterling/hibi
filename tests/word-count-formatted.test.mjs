import assert from 'node:assert/strict'
import test from 'node:test'
import { getSchema, getText, getTextSerializersFromSchema } from '@tiptap/core'
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
import { Subscript, Subtext } from '../src/addons/text-extras/nodes.ts'
import { textExtrasMarkdown } from '../src/addons/text-extras/syntax.ts'
import { countText } from '../src/addons/word-count/count.ts'
import { richText } from '../src/addons/word-count/formatted-text.ts'
import { documentImage } from '../src/renderer/src/DocumentImage.ts'
import { editorExtensions } from '../src/renderer/src/markdown.ts'
import { defaultNoteSyntax } from '../src/shared/note-syntax.ts'

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
flavors.push({ id: 'math.latex', richExtensions: [BlockMath, InlineMath] })
const extensions = [...editorExtensions(flavors), documentImage(0)]
const markdown = extensions.find((extension) => extension.name === 'markdown')
const manager = new MarkdownManager({
  extensions,
  marked: markdown.options.marked,
  markedOptions: markdown.options.markedOptions,
})
const schema = getSchema(extensions)
const native = (source) =>
  getText(schema.nodeFromJSON(manager.parse(source)), {
    blockSeparator: '\n',
    textSerializers: getTextSerializersFromSchema(schema),
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
    '- [ ] [label][ref]\n\n[ref]: https://example.test',
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
