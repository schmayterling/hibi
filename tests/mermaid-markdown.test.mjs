import assert from 'node:assert/strict'
import test from 'node:test'
import { getSchema, Node } from '@tiptap/core'
import { MarkdownManager } from '@tiptap/markdown'
import { StarterKit } from '@tiptap/starter-kit'
import { Marked } from 'marked'
import { mermaidMarkdown } from '../src/addons/mermaid/markdown.ts'

const Mermaid = Node.create({
  name: 'mermaidBlock',
  group: 'block',
  atom: true,
  addAttributes: () => ({ source: { default: '' }, raw: { default: '' } }),
  ...mermaidMarkdown,
})
const extensions = [StarterKit.configure({ trailingNode: false }), Mermaid]
const schema = getSchema(extensions)
// The app passes its own Marked, as here; Tiptap's bundled copy is older.
const manager = new MarkdownManager({ marked: new Marked(), extensions })

// Headings and diagrams as Marked reads them: the source outline and metadata
// parse this way, so the rich document must agree.
function marked(source) {
  const found = { headings: [], diagrams: 0 }
  new Marked().walkTokens(new Marked().lexer(source), (token) => {
    if (token.type === 'heading')
      found.headings.push(`${token.depth} ${token.text}`)
    if (token.type === 'code' && token.lang?.toLowerCase() === 'mermaid')
      found.diagrams++
  })
  return found
}
function rich(source) {
  const found = { headings: [], diagrams: 0 }
  schema.nodeFromJSON(manager.parse(source)).descendants((node) => {
    if (node.type.name === 'heading')
      found.headings.push(`${node.attrs.level} ${node.textContent}`)
    if (node.type.name === 'mermaidBlock') found.diagrams++
  })
  return found
}
const lines = [
  '```mermaid',
  '~~~mermaid',
  '```Mermaid',
  '```js',
  '```',
  '~~~',
  '> ```mermaid',
  '> ~~~mermaid',
  '> A-->B',
  '> ```',
  '> ~~~',
  '>',
  '> text',
  'graph TD',
  'outside',
  '===',
  '---',
  '# heading',
  '## second',
  '',
  '',
  'words here',
]

test('diagrams keep Marked headings and block boundaries, including in quotes', () => {
  let seed = 11
  const random = (count) => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed % count
  }
  for (let index = 0; index < 3000; index++) {
    const source =
      Array.from(
        { length: 1 + random(10) },
        () => lines[random(lines.length)],
      ).join('\n') + (random(2) ? '\n' : '')
    assert.deepEqual(rich(source), marked(source), JSON.stringify(source))
  }
  // A quoted diagram ends the quote, so the next lines form a setext heading.
  const quoted =
    '> ```mermaid\n> graph TD\n> A-->B\n> ```\noutside\n===\n\n# real\n'
  assert.deepEqual(rich(quoted), {
    headings: ['1 outside', '1 real'],
    diagrams: 1,
  })
  const json = manager.parse(quoted)
  assert.deepEqual(
    json.content.map((node) => node.type),
    ['blockquote', 'heading', 'heading'],
  )
  assert.equal(json.content[0].content[0].attrs.source, 'graph TD\nA-->B')
  assert.equal(
    manager.serialize(json).split('\n\n')[0],
    '> ```mermaid\n> graph TD\n> A-->B\n> ```',
  )
})

test('other code blocks stay code blocks', () => {
  const json = manager.parse(
    '```js\nconst a = 1\n```\n\n```mermaid\nA-->B\n```',
  )
  assert.deepEqual(
    json.content.map((node) => node.type),
    ['codeBlock', 'mermaidBlock'],
  )
  assert.equal(
    manager.serialize(json),
    '```js\nconst a = 1\n```\n\n```mermaid\nA-->B\n```',
  )
})
