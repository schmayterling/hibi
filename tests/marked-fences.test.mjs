import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { GFM, parser } from '@lezer/markdown'
import { getSchema, Node } from '@tiptap/core'
import { MarkdownManager } from '@tiptap/markdown'
import { Marked } from 'marked'
import { micromark } from 'micromark'
import {
  markedFenceText,
  readFence,
} from '../src/addons/_shared/formatted-fence.ts'
import { typstMarkdown } from '../src/addons/typst/markdown.ts'
import {
  typstBlock,
  typstFlavor,
  typstTokens,
} from '../src/addons/typst/syntax.ts'
import { markdownConfiguration } from '../src/renderer/src/markdown.ts'
import { blockMarkdown } from '../src/shared/marked-blocks.ts'

const markdown = parser.configure(GFM)
const decode = (html) =>
  html
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&')

/** Closed Typst bodies each view reads, beside CommonMark's code text. */
function views(source) {
  const rich = []
  const marked = new Marked(blockMarkdown, typstTokens)
  marked.walkTokens(marked.lexer(source), (token) => {
    if (token.type === 'code' && typstBlock(token.raw)) rich.push(token.text)
  })
  const exported = [
    ...marked.parse(source).matchAll(/data-typst="([^"]*)"/g),
  ].map((match) => decodeURIComponent(match[1]))
  // Exports that add only the Typst extension read the same blocks.
  const standalone = [
    ...new Marked(typstTokens).parse(source).matchAll(/data-typst="([^"]*)"/g),
  ].map((match) => decodeURIComponent(match[1]))
  const doc = EditorState.create({ doc: source }).doc
  const formatted = []
  markdown.parse(source).iterate({
    enter(node) {
      if (node.name !== 'FencedCode') return
      const fence = readFence(doc, node.node)
      if (fence?.info.trim().toLowerCase() === 'typst')
        formatted.push(markedFenceText(fence))
      return false
    },
  })
  const commonmark = [
    ...micromark(source).matchAll(/<code[^>]*>([\s\S]*?)<\/code>/g),
  ].map((match) => decode(match[1]).replace(/\n$/, ''))
  return {
    rich,
    exported,
    standalone,
    formatted,
    detected: typstFlavor.detect(source),
    commonmark,
  }
}

const cases = [
  // A closing fence ends in spaces or tabs.
  ['```typst\nx\n```\t\nafter', 'x'],
  ['```typst\nx\n``` \t \nafter', 'x'],
  ['~~~typst\nx\n~~~~\t\nafter', 'x'],
  ['> ```typst\n> x\n> ```\t\n\nafter', 'x'],
  ['- ```typst\n  x\n  ```\t\n\nafter', 'x'],
  // An indented tilde fence removes its indentation from body lines.
  ['  ~~~typst\n  x\n    y\n z\n  ~~~\nafter', 'x\n  y\nz'],
  ['   ~~~typst\n   x\n  ~~~\nafter', 'x'],
  ['>  ~~~typst\n>  x\n>    y\n>  ~~~\n\nafter', 'x\n  y'],
  ['- item\n\n   ~~~typst\n   x\n     y\n   ~~~\n\nafter', 'x\n  y'],
  // Backtick fences keep their reading.
  ['  ```typst\n  x\n    y\n  ```\nafter', 'x\n  y'],
]
// Fences that stay open: a closer in the other character, a tab in the
// closer's indentation, or a closing run followed by the other character.
const open = [
  '~~~typst\nx\n```\nafter',
  '```typst\nx\n \t```\nafter',
  '```typst\nx\n```~~~\nafter',
  '~~~typst\nx\n~~~```\nafter',
  '> ```typst\n> x\n> ```~\n> after',
  '- ~~~typst\n  x\n  ~~~`\n  after',
]

test('typst fences close and dedent per CommonMark in every view', () => {
  for (const [source, body] of cases) {
    const read = views(source)
    assert.deepEqual(
      read.commonmark,
      [body],
      `oracle ${JSON.stringify(source)}`,
    )
    assert.deepEqual(
      read,
      {
        rich: [body],
        exported: [body],
        standalone: [body],
        formatted: [body],
        detected: true,
        commonmark: [body],
      },
      JSON.stringify(source),
    )
    assert.match(
      new Marked(blockMarkdown, typstTokens).parse(source),
      /<p>after<\/p>/,
      JSON.stringify(source),
    )
  }
  for (const source of open) {
    const read = views(source)
    assert.equal(read.commonmark.length, 1, source)
    assert.ok(read.commonmark[0].endsWith('after'), source)
    assert.deepEqual(
      read,
      {
        rich: [],
        exported: [],
        standalone: [],
        formatted: [],
        detected: false,
        commonmark: read.commonmark,
      },
      JSON.stringify(source),
    )
  }
})

test('rich documents preserve the same typst bodies', () => {
  const diagram = Node.create({
    name: 'typstBlock',
    group: 'block',
    atom: true,
    addAttributes: () => ({ source: { default: '' }, raw: { default: '' } }),
    ...typstMarkdown,
  })
  const configuration = markdownConfiguration([
    {
      ...typstFlavor,
      id: 'typst.blocks',
      richExtensions: [diagram],
      export: { extensions: [typstTokens] },
    },
  ])
  const extensions = [...configuration.core, ...configuration.addons]
  const manager = new MarkdownManager({
    marked: configuration.parser,
    extensions,
  })
  const schema = getSchema(extensions)
  const bodies = (json) => {
    const found = []
    schema.nodeFromJSON(json).descendants((node) => {
      if (node.type.name === 'typstBlock') found.push(node.attrs.source)
    })
    return found
  }
  for (const [source, body] of cases) {
    const json = manager.parse(source)
    assert.deepEqual(bodies(json), [body], source)
    assert.match(schema.nodeFromJSON(json).textContent, /after/, source)
  }
})

test('startup detection sees typst after another language closes with a tab', () => {
  const source = '```js\nx\n```\t\n\n```typst\ny\n```'
  assert.equal(typstFlavor.detect(source), true)
})

test('other fences keep their native code tokens', () => {
  const lex = (source) =>
    new Marked(blockMarkdown).lexer(source).map(({ type, raw, text }) => ({
      type,
      raw,
      text,
    }))
  for (const source of [
    '```js\nx\n```\n\nafter',
    '~~~\nx\n~~~\n',
    '````\n```\n````\n',
    '  ```\n  a\n b\n```\n',
    '```\nunclosed\n',
    '> ```\n> \tx\n> ```\n',
    '- a\n\n  ```\n  x\n  ```\n',
  ])
    assert.deepEqual(
      lex(source),
      new Marked()
        .lexer(source)
        .map(({ type, raw, text }) => ({ type, raw, text })),
      source,
    )
  // Closing fences with tabs and tilde fences' bodies change only per CommonMark.
  assert.deepEqual(lex('```\nx\n```\t\nafter')[0], {
    type: 'code',
    raw: '```\nx\n```\t\n',
    text: 'x',
  })
  assert.deepEqual(lex('  ~~~\n  x\n  ~~~')[0], {
    type: 'code',
    raw: '  ~~~\n  x\n  ~~~',
    text: 'x',
  })
  // A run of the other character does not close a fence.
  for (const [source, text] of [
    ['```\nx\n```~\nafter', 'x\n```~\nafter'],
    ['~~~\nx\n~~~```\nafter', 'x\n~~~```\nafter'],
    ['```\nx\n````\nafter', 'x'],
  ]) {
    assert.deepEqual(
      micromark(source).match(/<pre><code[^>]*>[\s\S]*?<\/code><\/pre>/g),
      [`<pre><code>${text}\n</code></pre>`],
    )
    assert.deepEqual(lex(source)[0], {
      type: 'code',
      raw: text === 'x' ? '```\nx\n````\n' : source,
      text,
    })
  }
})
