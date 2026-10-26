import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { GFM, parser } from '@lezer/markdown'
import { Marked } from 'marked'
import {
  dedentedFenceText,
  fenceBodyChanges,
  markedFenceText,
  readFence,
} from '../src/addons/_shared/formatted-fence.ts'
import { typstTokens } from '../src/addons/typst/syntax.ts'

const markdown = parser.configure(GFM)

/** Closed fences of `language`, with the body each view reads. */
function fences(source, language, text) {
  const doc = EditorState.create({ doc: source }).doc
  const found = []
  markdown.parse(source).iterate({
    enter(node) {
      if (node.name !== 'FencedCode') return
      const fence = readFence(doc, node.node)
      if (fence && fence.info.trim().toLowerCase() === language)
        found.push({ from: node.from, to: node.to, text: text(fence) })
      return false
    },
  })
  return found
}

/** The rich view's mermaid diagrams: Marked code tokens of that language. */
function markedDiagrams(source) {
  const marked = new Marked()
  const found = []
  marked.walkTokens(marked.lexer(source), (token) => {
    if (token.type === 'code' && token.lang?.toLowerCase() === 'mermaid')
      found.push(token.text)
  })
  return found
}

/** The rich view's Typst blocks: the Typst tokenizer's tokens. */
function markedTypst(source) {
  const marked = new Marked(typstTokens)
  const found = []
  marked.walkTokens(marked.lexer(source), (token) => {
    if (token.type === 'typstBlock') found.push(token.source)
  })
  return found
}

const bodies = [
  'graph TD\n  A-->B',
  '',
  '\nleading blank',
  'trailing blank\n',
  'a\n\nb',
  '  indented\n    more',
  'x ` y',
]
const wrappers = [
  (lang, body) => `\`\`\`${lang}\n${body}\n\`\`\``,
  (lang, body) => `~~~${lang}\n${body}\n~~~`,
  (lang, body) =>
    ` \`\`\`${lang}\n${body
      .split('\n')
      .map((line) => (line ? ` ${line}` : line))
      .join('\n')}\n \`\`\``,
  (lang, body) =>
    `   \`\`\`${lang}\n${body
      .split('\n')
      .map((line) => (line ? `  ${line}` : line))
      .join('\n')}\n   \`\`\``,
  (lang, body) =>
    `  ~~~${lang}\n${body
      .split('\n')
      .map((line) => (line ? `  ${line}` : line))
      .join('\n')}\n  ~~~`,
  (lang, body) =>
    `> \`\`\`${lang}\n${body
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')}\n> \`\`\``,
  (lang, body) =>
    `- item\n\n  \`\`\`${lang}\n${body
      .split('\n')
      .map((line) => (line ? `  ${line}` : line))
      .join('\n')}\n  \`\`\``,
  (lang, body) =>
    `- \`\`\`${lang}\n${body
      .split('\n')
      .map((line) => (line ? `  ${line}` : line))
      .join('\n')}\n  \`\`\``,
  (lang, body) =>
    `> - \`\`\`${lang}\n${body
      .split('\n')
      .map((line) => `>   ${line}`)
      .join('\n')}\n>   \`\`\``,
]

test('formatted fences read diagram and typst bodies as the rich view does', () => {
  for (const wrap of wrappers)
    for (const body of bodies)
      for (const ending of ['', '\n\nafter']) {
        const diagram = `intro\n\n${wrap('mermaid', body)}${ending}`
        assert.deepEqual(
          fences(diagram, 'mermaid', markedFenceText).map(({ text }) => text),
          markedDiagrams(diagram),
          JSON.stringify(diagram),
        )
        const typst = `intro\n\n${wrap('typst', body)}${ending}`
        assert.deepEqual(
          fences(typst, 'typst', dedentedFenceText).map(({ text }) => text),
          markedTypst(typst),
          JSON.stringify(typst),
        )
      }
  // Unclosed fences stay code blocks in both views.
  assert.deepEqual(
    fences('```mermaid\ngraph TD', 'mermaid', markedFenceText),
    [],
  )
  assert.deepEqual(markedTypst('```typst\n$ x $'), [])
})

test('editing a fence writes its body as one change and keeps the fence around it', () => {
  const sources = [
    'graph LR\n  X-->Y',
    '',
    'one',
    'a\n\nb',
    'has\n```\nfence',
    'has\n````\nlonger fence',
    '~~~\ntilde',
  ]
  for (const [language, read, indented] of [
    ['mermaid', markedDiagrams, (fence) => fence.marker.startsWith('`')],
    ['typst', markedTypst, () => true],
  ])
    for (const wrap of wrappers)
      for (const source of sources) {
        const before = `intro\n\n${wrap(language, 'old\nbody')}\n\nafter`
        const doc = EditorState.create({ doc: before }).doc
        let node
        markdown.parse(before).iterate({
          enter(ref) {
            if (ref.name === 'FencedCode') node ??= ref.node
          },
        })
        const fence = readFence(doc, node)
        const text = EditorState.create({ doc: before })
          .update({
            changes: fenceBodyChanges(doc, node, source, {
              indent: fence.indent,
              indented: indented(fence),
            }),
          })
          .state.doc.toString()
        // Both the rich view's reading and the formatted view's read the new source.
        assert.deepEqual(read(text), [source], JSON.stringify({ before, text }))
        assert.deepEqual(
          fences(
            text,
            language,
            language === 'typst' ? dedentedFenceText : markedFenceText,
          ).map(({ text }) => text),
          [source],
          JSON.stringify({ before, text }),
        )
        assert.ok(text.startsWith('intro\n\n') && text.endsWith('\n\nafter'))
      }
})
