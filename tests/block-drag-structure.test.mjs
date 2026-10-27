import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { GFM } from '@lezer/markdown'
import { blockStep } from '../src/addons/block-drag/formatted.ts'
import { ChunkedMarkdownParser } from '../src/renderer/src/chunked-markdown.ts'
import { formattedBlockParser } from '../src/renderer/src/formatted-contributions.ts'
import { formattedSyntax } from '../src/renderer/src/formatted-syntax.ts'
import { Footnotes, GithubAlerts } from '../src/shared/markdown-extra-syntax.ts'

const extensions = [GFM, Footnotes, GithubAlerts]
const grammar = EditorState.create({
  extensions: formattedSyntax({ extensions }).extension,
})
const md = grammar.facet(formattedBlockParser)(grammar)
const containers = new Set([
  'Blockquote',
  'BulletList',
  'OrderedList',
  'ListItem',
  'FootnoteDefinition',
  'Document',
])
function leaves(doc) {
  const out = [],
    path = []
  md.parse(doc).iterate({
    enter(node) {
      if (!node.type.is('Block') && node.name !== 'Document') return false
      if (containers.has(node.name)) {
        path.push(node.name)
        return true
      }
      const text = doc
        .slice(node.from, node.to)
        .split('\n')
        .map((line) => line.replace(/^[\s>]*/, '').trim())
        .filter(Boolean)
        .join(' ')
      out.push(`${path.join('/')}/${node.name}:${text}`)
      return false
    },
    leave(node) {
      if (containers.has(node.name)) path.pop()
    },
  })
  return out.sort()
}
const view = (doc) => {
  const syntax = formattedSyntax({ slice: 1e6, extensions })
  const state = EditorState.create({ doc, extensions: syntax.extension })
  return { state, tree: syntax.tree(state) }
}
const moved = (doc, token, name, direction) => {
  const { state, tree } = view(doc)
  let node = tree.resolveInner(doc.indexOf(token), 1)
  while (node && node.name !== name) node = node.parent
  assert.ok(node, name)
  const spec = blockStep(state, tree, node, direction)
  return spec ? state.update(spec).state.doc.toString() : null
}

test('quoted items leave trailing quote-only lines between blocks', () => {
  for (const [list, swapped] of [
    ['- a\n> - b', '- b\n> - a'],
    ['1. a\n> 2. b', '1. b\n> 2. a'],
  ]) {
    const doc = `> ${list}\n>\n> after\n`
    const expected = `> ${swapped}\n>\n> after\n`
    assert.equal(moved(doc, 'a', 'ListItem', 1), expected)
    assert.equal(moved(doc, 'b', 'ListItem', -1), expected)
  }
  assert.equal(moved('1.\n2. two\n', '1.', 'ListItem', 1), '1. two\n2.\n')
  assert.equal(
    moved('> -\n>   a\n> - b\n>\n> after\n', 'a', 'ListItem', 1),
    '> - b\n> -\n>   a\n>\n> after\n',
  )
  let doc = '> before\n>\n> - a\n> - b\n>\n> after\n'
  const original = doc
  for (let i = 0; i < 3; i++) {
    doc = moved(doc, 'before', 'Paragraph', 1)
    assert.ok(doc)
    doc = moved(doc, 'before', 'Paragraph', -1)
    assert.equal(doc, original)
  }
})

test('moves reject absorption at both the old and new neighbors', () => {
  for (const [doc, token, name, direction] of [
    ['    code\n\n- item\n\nend\n', 'code', 'CodeBlock', 1],
    ['- item\n\npara\n\n    code\n', 'para', 'Paragraph', -1],
    ['  para\n\n- item\n\nend\n', 'para', 'Paragraph', 1],
    ['[^f]: note\n\npara\n\n    code\n', 'para', 'Paragraph', -1],
    ['    code\n\n[^f]: note\n\nend\n', 'code', 'CodeBlock', 1],
    ['>     code\n>\n> - item\n>\n> end\n', 'code', 'CodeBlock', 1],
    ['1. one\n\npara\n\n    code\n', 'para', 'Paragraph', -1],
    ['- first\n\npara\n\n- second\n', 'para', 'Paragraph', -1],
  ]) {
    const after = moved(doc, token, name, direction)
    assert.equal(after, null, doc)
  }
})

test('every block in 400 seeded mixed notes preserves structure in both directions', () => {
  const kinds = [
    (i) => `para ${i} with a ref[^n${i}]`,
    (i) => `## heading ${i}`,
    (i) => `\x60\x60\x60js\nfence ${i}\n\x60\x60\x60`,
    (i) => `    indented ${i}`,
    (i) => `| a${i} | b |\n| - | - |\n| c | d |`,
    (i) => `> quoted ${i}\n>\n> second ${i}`,
    (i) => `- item ${i}\n- item ${i}b\n  - nested ${i}`,
    (i) => `1. first ${i}\n2. second ${i}`,
    (i) => `- [ ] task ${i}\n- [x] done ${i}`,
    (i) => `> [!NOTE]\n> alert ${i}`,
    (i) => `[^n${i}]: footnote ${i}`,
    () => '***',
    (i) => `<div>\nhtml ${i}\n</div>`,
    (i) => `[ref${i}]: https://example.com/${i}`,
    (i) => `  spaced ${i}`,
  ]
  let seed = 7,
    moves = 0,
    changed = 0
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const examples = []
  for (let i = 0; i < 400; i++) {
    let doc = `${Array.from({ length: 6 }, (_, j) => kinds[Math.floor(random() * kinds.length)](j)).join('\n\n')}\n`
    if (i % 4 === 3)
      doc = `${doc
        .trimEnd()
        .split('\n')
        .map((line) => (line ? `> ${line}` : '>'))
        .join('\n')}\n`
    const { state, tree } = view(doc)
    const before = leaves(doc)
    tree.iterate({
      enter(node) {
        if (!node.type.is('Block') || node.name === 'Document') return
        for (const direction of [-1, 1]) {
          const spec = blockStep(state, tree, node.node, direction)
          if (!spec) continue
          moves++
          const after = state.update(spec).state.doc.toString()
          if (JSON.stringify(leaves(after)) === JSON.stringify(before)) continue
          changed++
          if (examples.length < 3) examples.push({ doc, after })
        }
      },
    })
  }
  console.log(JSON.stringify({ moves, changed, examples }))
  assert.ok(moves > 4000, String(moves))
  assert.equal(changed, 0)
})

test('validation reads local ranges in a 20,000-item container', () => {
  const measure = (items) => {
    const doc = Array.from(
      { length: items },
      (_, i) => `- item ${String(i).padStart(5, '0')}`,
    ).join('\n')
    const at = doc.indexOf(`- item ${String(items >> 1).padStart(5, '0')}`)
    const parse = new ChunkedMarkdownParser(md, md, {
      chunkSize: 256,
      giantBlock: 4096,
    }).startChunkedParse(
      {
        length: doc.length,
        lineChunks: false,
        read: (from, to) => doc.slice(from, to),
        chunk: (from) => doc.slice(from),
      },
      [],
      { from: at - 200, to: at + 400 },
    )
    let tree
    while (!tree) tree = parse.advance()
    let units = 0,
      calls = 0
    const state = EditorState.create({
      doc,
      extensions: formattedBlockParser.of(() => ({
        parse(input, fragments, ranges) {
          calls++
          assert.ok(ranges)
          units += ranges.reduce((sum, range) => sum + range.to - range.from, 0)
          return md.parse(input, fragments, ranges)
        },
      })),
    })
    let node = tree.resolveInner(at + 4, 1)
    while (node.name !== 'ListItem') node = node.parent
    assert.ok(blockStep(state, tree, node, 1))
    assert.equal(calls, 2)
    return units
  }
  const small = measure(100),
    large = measure(20000)
  console.log(JSON.stringify({ validationUnits: { small, large } }))
  assert.equal(large, small)
  assert.ok(large < 2048, String(large))
})

test('structure validation serializes nested containers once', () => {
  for (const depth of [12, 64]) {
    const doc = `first\n\n${'> '.repeat(depth)}nested\n\nlast\n`
    const { state, tree } = view(doc)
    const stringify = JSON.stringify
    let units = 0,
      spec
    try {
      JSON.stringify = (value, ...args) => {
        const pending = [value]
        while (pending.length) {
          const part = pending.pop()
          if (typeof part === 'string') units += part.length
          else if (Array.isArray(part))
            for (const entry of part) pending.push(entry)
        }
        return stringify(value, ...args)
      }
      spec = blockStep(state, tree, tree.topNode.firstChild, 1)
    } finally {
      JSON.stringify = stringify
    }
    assert.ok(spec)
    console.log(
      JSON.stringify({ depth, source: doc.length, serialized: units }),
    )
    assert.ok(units < 50 * doc.length, String(units))
  }
})
