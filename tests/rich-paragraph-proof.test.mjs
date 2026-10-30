import assert from 'node:assert/strict'
import test from 'node:test'
import { getSchema } from '@tiptap/core'
import { BlockMath, InlineMath } from '@tiptap/extension-mathematics'
import { MarkdownManager } from '@tiptap/markdown'
import { EditorState } from '@tiptap/pm/state'
import { blockMath, inlineMath, mathTokens } from '../src/addons/math/syntax.ts'
import { markdownConfiguration } from '../src/renderer/src/markdown.ts'
import { createRichParagraphProof } from '../src/renderer/src/rich-paragraph-proof.ts'

const mathFlavor = {
  id: 'math.latex',
  richExtensions: [
    InlineMath.extend({
      markdownTokenizer: {
        name: 'inlineMath',
        level: 'inline',
        start: (source) => source.indexOf('$'),
        tokenize: inlineMath,
      },
    }),
    BlockMath.extend({
      markdownTokenizer: {
        name: 'blockMath',
        level: 'block',
        start: (source) => source.indexOf('$$'),
        tokenize: blockMath,
      },
    }),
  ],
  export: { extensions: [mathTokens] },
}
const { core, addons, parser, options } = markdownConfiguration([mathFlavor])
const extensions = [...core, ...addons]
const schema = getSchema(extensions)
const manager = new MarkdownManager({
  extensions,
  marked: parser,
  markedOptions: options,
})

function setup(source) {
  const state = EditorState.create({
    schema,
    doc: schema.nodeFromJSON(manager.parse(source)),
  })
  return { state, proof: createRichParagraphProof(source, state.doc, manager) }
}

function insert(state, text, at, value) {
  let position = -1
  state.doc.descendants((node, pos) => {
    if (position < 0 && node.isText && node.text?.includes(text))
      position = pos + node.text.indexOf(text) + at
  })
  assert.notEqual(position, -1, text)
  return state.tr.insertText(value, position)
}

test('preserves crlf, emphasis delimiter, bullets, setext heading, and block math', () => {
  const source =
    '# head\r\n\r\nmath $x$ and _em_ here\r\n\r\n* bullet\r\n\r\nSetext\r\n------\r\n\r\n$$\r\nx+y\r\n$$\r\n\r\ntail'
  let { state, proof } = setup(source)
  assert.ok(proof)
  assert.notEqual(
    manager.serialize(state.doc.toJSON()),
    source.replaceAll('\r\n', '\n'),
  )
  const first = insert(state, ' here', 1, '!')
  const result = proof.plan(state, first, first.doc)
  assert.ok(result)
  assert.equal(result.source, source.replace(' here', ' !here'))
  assert.ok(result.proof.matches(result.source, first.doc))
  assert.ok(proof.matches(source, state.doc))
  assert.ok(!proof.matches(result.source, first.doc))
  state = state.apply(first)
  proof = result.proof
  const second = insert(state, 'tail', 2, 'Z')
  const last = proof.plan(state, second, second.doc)
  assert.ok(last)
  assert.equal(last.source, result.source.replace('tail', 'taZil'))
  assert.ok(schema.nodeFromJSON(manager.parse(last.source)).eq(second.doc))
})

test('math-enabled CRLF paragraphs preserve exact line endings when q becomes qq', () => {
  const { state, proof } = setup('p\r\n\r\nq')
  assert.ok(proof)
  const tr = insert(state, 'q', 1, 'q')
  assert.equal(proof.plan(state, tr, tr.doc)?.source, 'p\r\n\r\nqq')
})

test('keeps noncanonical inline math and emphasis source on ordinary typing', () => {
  const source = 'before $x+y$ and _em_ after\n\nnext'
  const { state, proof } = setup(source)
  assert.ok(proof)
  const tr = insert(state, ' after', 2, 'q')
  const result = proof.plan(state, tr, tr.doc)
  assert.ok(result)
  assert.equal(result.source, source.replace(' after', ' aqfter'))
  assert.ok(schema.nodeFromJSON(manager.parse(result.source)).eq(tr.doc))
})

test('rejects definitions, html, cross-block math, and paragraph shape changes', () => {
  assert.equal(setup('word [id]\n\n[id]: /url').proof, null)
  for (const [source, text, at, value] of [
    ['text <span>html</span>', 'text ', 2, 'x'],
    ['text $$ hazard', 'text ', 2, 'x'],
    ['plain\n\nnext', 'plain', 0, '['],
    ['plain\n\nnext', 'plain', 0, '$$'],
    ['plain\n\nnext', 'plain', 2, '\n'],
    [' plain\n\nnext', 'plain', 0, ' '],
  ]) {
    const { state, proof } = setup(source)
    if (!proof) continue
    const tr = insert(state, text, at, value)
    assert.equal(proof.plan(state, tr, tr.doc), null, source + value)
  }
})

test('escaped block markers stay literal while structural edits fall back', () => {
  const source = 'plain\n\nnext'
  const { state, proof } = setup(source)
  assert.ok(proof)
  for (const marker of ['# ', '- ']) {
    const tr = insert(state, 'plain', 0, marker)
    const result = proof.plan(state, tr, tr.doc)
    assert.ok(result)
    assert.equal(result.source, `\\${marker}${source}`)
    assert.ok(schema.nodeFromJSON(manager.parse(result.source)).eq(tr.doc))
  }
  const heading = state.tr.setNodeMarkup(0, schema.nodes.heading, { level: 1 })
  assert.equal(proof.plan(state, heading, heading.doc), null)
})

test('escaped angle bracket remains literal text, never raw html', () => {
  const source = 'plain\n\nnext'
  const { state, proof } = setup(source)
  assert.ok(proof)
  const tr = insert(state, 'plain', 0, '<')
  assert.equal(
    proof.plan(state, tr, tr.doc, () => null),
    null,
  )
  const result = proof.plan(state, tr, tr.doc)
  assert.ok(result)
  assert.equal(result.source, '&lt;plain\n\nnext')
  assert.ok(schema.nodeFromJSON(manager.parse(result.source)).eq(tr.doc))
})

test('paragraph edits cannot change adjacent block math across a token boundary', () => {
  for (const source of [
    'head\n$$\nx\n$$',
    '$$\nx\n$$\nhead',
    'head$$\nx\n$$',
  ]) {
    const { state, proof } = setup(source)
    assert.ok(proof)
    const tr = insert(state, 'head', 4, '$')
    assert.equal(proof.plan(state, tr, tr.doc), null)
  }
})

test('rejects mismatched document, stale state, and multi-step transaction', () => {
  const source = 'first\n\nsecond'
  const { state, proof } = setup(source)
  assert.ok(proof)
  const changed = insert(state, 'first', 2, 'z')
  assert.equal(proof.plan(state, changed, state.doc), null)
  assert.equal(proof.plan(state.apply(changed), changed, changed.doc), null)
  const other = schema.nodeFromJSON(manager.parse('other\n\nsecond'))
  assert.equal(createRichParagraphProof(source, other, manager), null)
  const multi = insert(state, 'first', 2, 'z')
  multi.insertText('q', 6)
  assert.equal(proof.plan(state, multi, multi.doc), null)
})

test('one-megabyte math document parses only edited paragraph after certification', () => {
  const source = `# head\n\n${'x'.repeat(1_000_000)}\n\nsmall $x$ tail`
  const { state, proof } = setup(source)
  assert.ok(proof)
  const parsed = []
  const original = manager.parse
  manager.parse = function (text) {
    parsed.push(text.length)
    return original.call(this, text)
  }
  try {
    const tr = insert(state, ' tail', 2, 'z')
    const result = proof.plan(state, tr, tr.doc)
    assert.ok(result)
    assert.equal(result.source === source.replace(' tail', ' tzail'), true)
    assert.ok(parsed.length <= 8)
    assert.ok(parsed.every((length) => length <= 16 * 1024 + 2))
  } finally {
    manager.parse = original
  }
})
