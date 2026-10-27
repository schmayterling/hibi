import assert from 'node:assert/strict'
import test from 'node:test'
import { DocInput } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { TreeFragment } from '@lezer/common'
import { GFM } from '@lezer/markdown'
import { blockStep, moveBlock } from '../src/addons/block-drag/formatted.ts'
import { blockMathSyntax } from '../src/addons/math/formatted-syntax.ts'
import { subtextSyntax } from '../src/addons/text-extras/formatted-syntax.ts'
import {
  BoundaryTree,
  boundaryRecords,
  ChunkedMarkdownParser,
  readAheadFrom,
  spliceBoundaryFragments,
} from '../src/renderer/src/chunked-markdown.ts'
import { formattedBlockParser } from '../src/renderer/src/formatted-contributions.ts'
import { formattedSyntax } from '../src/renderer/src/formatted-syntax.ts'
import { Footnotes, GithubAlerts } from '../src/shared/markdown-extra-syntax.ts'

const extensions = [
  GFM,
  Footnotes,
  GithubAlerts,
  blockMathSyntax,
  subtextSyntax,
]
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
function structure(doc, tree = md.parse(doc), moving = null, direction = 0) {
  const marks = []
  tree.iterate({
    enter(node) {
      if (node.name === 'QuoteMark') marks.push([node.from, node.to])
    },
  })
  marks.sort((a, b) => a[0] - b[0])
  const visit = (node) => {
    if (containers.has(node.name)) {
      const children = node.getChildren('Block')
      if (
        moving?.parent &&
        node.from === moving.parent.from &&
        node.to === moving.parent.to &&
        node.name === moving.parent.name
      ) {
        const at = children.findIndex(
          (child) =>
            child.from === moving.from &&
            child.to === moving.to &&
            child.name === moving.name,
        )
        assert.ok(at >= 0 && children[at + direction])
        const [moved] = children.splice(at, 1)
        children.splice(at + direction, 0, moved)
      }
      return [node.name, ...children.map(visit)]
    }
    if (/^(FencedCode|CodeBlock|BlockMath)$/.test(node.name))
      return [
        node.name,
        ['CodeMark', 'CodeInfo', 'CodeText', 'MathMark', 'MathText'].map(
          (name) =>
            node
              .getChildren(name)
              .map((part) => doc.slice(part.from, part.to))
              .join('')
              .replace(/\n+$/, ''),
        ),
      ]
    let at = node.from
    let text = ''
    for (const [from, to] of marks) {
      if (from < at || to > node.to) continue
      text += doc.slice(at, from)
      at = to
    }
    text += doc.slice(at, node.to)
    return [
      node.name,
      text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .join(' '),
    ]
  }
  return visit(tree.topNode)
}
function checkMoves(doc) {
  const { state, tree } = view(doc)
  assert.deepEqual(structure(doc, tree), structure(doc), doc)
  let moves = 0
  tree.iterate({
    enter(ref) {
      if (!ref.type.is('Block') || ref.name === 'Document') return
      for (const direction of [-1, 1]) {
        const spec = blockStep(state, tree, ref.node, direction)
        if (!spec) continue
        moves++
        const after = state.update(spec).state.doc.toString()
        assert.deepEqual(
          structure(after),
          structure(doc, tree, ref.node, direction),
          doc,
        )
      }
    },
  })
  return moves
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
  assert.equal(
    moved('> one\n>\n\nlast\n', 'one', 'Blockquote', 1),
    'last\n\n> one\n>\n',
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

test('a last item cannot absorb prose after blank separators', () => {
  for (const [doc, token, direction] of [
    ['- narrow item\n-   wide item\n\n  note text\n', 'narrow', 1],
    ['1. one\n2.  two\n\n   text\n', 'one', 1],
    ['- a\n-\n\n  text\n', 'a', 1],
    ['> - a\n> -   b\n>\n>   text\n', 'a', 1],
  ])
    assert.equal(moved(doc, token, 'ListItem', direction), null, doc)
})

test('moves cannot activate earlier math decisions across blocks or inside paragraphs', () => {
  const big = 'big ' + 'word '.repeat(2200)
  for (const [doc, token, direction] of [
    ['$$ a\n\nf\n\nt\n\nm $$ x\n\nz $$\n', 'z $$', -1],
    ['$$ a\n\nf\n\nt\n\nm $$ x\n\nz $$\n', 'm $$ x', 1],
    ['a1\na2\n$$ q\na4\na5\n\nm $$ x\n\nz $$\n', 'z $$', -1],
    [
      '> intro\n>\n> $$ a\n>\n> f\n>\n> t\n>\n> m $$ x\n>\n> z $$\n',
      'z $$',
      -1,
    ],
    [`$$ a\n\nf\n\nt\n\n${big}\n\nz $$\n\nlast\n`, 'big word', 1],
  ]) {
    const { state } = view(doc)
    for (const tree of [view(doc).tree, md.parse(doc)]) {
      let block = tree.resolveInner(doc.indexOf(token), 1)
      while (block && block.name !== 'Paragraph') block = block.parent
      assert.ok(block, token)
      assert.equal(blockStep(state, tree, block, direction), null, doc)
    }
  }
  const far = `$$\na + b\n\nf\n\ntee\n\n${'filler words here\n\n'.repeat(700)}$$\nx\n$$\n`
  const { state } = view(far)
  const tree = md.parse(far)
  const block = tree.topNode.getChild('BlockMath')
  const target = tree.resolveInner(far.indexOf('tee'), 1)
  assert.ok(block)
  assert.equal(moveBlock(state, tree, block, target, true), null)
  assert.equal(
    moved('$$\nx\n$$\n\none\n\ntwo\n', '$$', 'BlockMath', 1),
    'one\n\n$$\nx\n$$\n\ntwo\n',
  )
})

test('lookahead dependency queries skip unrelated chunks in large notes', () => {
  const doc = '$$ a\n\nf\n\nt\n\nm $$ x\n\nz $$\n'
  const chunked = new ChunkedMarkdownParser(md, md)
  const tree = chunked.parse(doc)
  const boundary = new BoundaryTree(chunked, doc.length)
  boundary.append([...boundaryRecords(tree)])
  assert.equal(readAheadFrom(boundary.finish(), doc.indexOf('m $$ x')), null)
  const visits = (count, quoted = false) => {
    let doc = '$$ q\n\nm $$ x\n\n'.repeat(count) + 'end\n'
    if (quoted)
      doc = doc
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')
    const chunked = new ChunkedMarkdownParser(md, md, {
      chunkSize: 64,
      groupSize: 8,
    })
    const work = chunked.startChunkedParse(
      new DocInput(EditorState.create({ doc }).doc),
      [],
      { from: Infinity, to: Infinity },
    )
    let tree
    while (!tree) tree = work.advance()
    let stored = 0,
      bytes = 0
    const inspect = (node) => {
      for (const [, value] of node.propValues) {
        if (!value?.kind) continue
        bytes += value.index?.byteLength ?? 0
        if (value.kind === 'root' || value.kind === 'group')
          node.children.forEach(inspect)
        else if (value.reads) {
          assert.ok(value.reads instanceof Float64Array)
          stored += value.reads.length / 2
          bytes += value.reads.byteLength
          for (let i = 2; i < value.reads.length; i += 2)
            assert.ok(value.reads[i] > value.reads[i - 2])
        }
      }
    }
    inspect(tree)
    assert.equal(stored, count)
    assert.ok(bytes <= count * 64 + 1024, String(bytes))
    const proto = Object.getPrototypeOf(tree)
    const original = proto.prop
    let calls = 0
    proto.prop = function (...args) {
      calls++
      const value = original.apply(this, args)
      const watch = (array) =>
        new Proxy(array, {
          get(target, key) {
            if (typeof key === 'string' && /^\d+$/.test(key)) calls++
            return Reflect.get(target, key, target)
          },
        })
      return value?.index || value?.reads
        ? {
            ...value,
            ...(value.index ? { index: watch(value.index) } : {}),
            ...(value.reads ? { reads: watch(value.reads) } : {}),
          }
        : value
    }
    try {
      const starts = readAheadFrom(tree, doc.lastIndexOf('m $$ x') + 3)
      const opening = doc.lastIndexOf('$$ q')
      assert.ok(starts?.includes(doc.lastIndexOf('\n', opening - 1) + 1))
    } finally {
      proto.prop = original
    }
    return calls
  }
  const small = visits(100)
  const large = visits(20000)
  const giantSmall = visits(100, true)
  const giantLarge = visits(20000, true)
  console.log(
    JSON.stringify({
      mathDependencies: { small, large, giantSmall, giantLarge },
    }),
  )
  assert.ok(large < 100 && large <= small + 32, `${small}, ${large}`)
  assert.ok(
    giantLarge < 100 && giantLarge <= giantSmall + 40,
    `${giantSmall}, ${giantLarge}`,
  )
})

test('lazy table lookahead and quoted literal lines keep their structure and text', () => {
  const table = '> a\n2. | b | c |\n>    | --- | - |\n>    # h\n'
  assert.equal(moved(table, '| --- |', 'Paragraph', 1), null)
  for (const doc of [
    '3.   > -# small 1457\n      > - [ ] t1458\n    >\n     > > al1460\n',
    '>p\n>\n>    ```\n>      c\n>    ```\n',
    '> p\n>\n>    ```\n>      c\n>    ```\n',
    '>11) -    sp2123\n>    -   ```` md\n>        c2126\n',
  ])
    checkMoves(doc)
})
test('tab separators cannot move a nested list across its content column', () => {
  const doc = '- a\n  1. x\n\n     -# s\n  2.\n \tt\n  > q\n'
  const { state, tree } = view(doc)
  const find = (token, name) => {
    let node = tree.resolveInner(doc.indexOf(token), 1)
    while (node && node.name !== name) node = node.parent
    assert.ok(node, name)
    return node
  }
  assert.equal(
    moveBlock(
      state,
      tree,
      find('1.', 'OrderedList'),
      find('> q', 'Blockquote'),
      false,
    ),
    null,
  )
  const spaced = doc.replace(' \tt', '    t')
  const current = view(spaced)
  let list = current.tree.resolveInner(spaced.indexOf('1.'), 1)
  while (list && list.name !== 'OrderedList') list = list.parent
  let quote = current.tree.resolveInner(spaced.indexOf('> q'), 1)
  while (quote && quote.name !== 'Blockquote') quote = quote.parent
  const spec = moveBlock(current.state, current.tree, list, quote, false)
  assert.ok(spec)
  assert.deepEqual(
    structure(current.state.update(spec).state.doc.toString()),
    structure(spaced, current.tree, list, 1),
  )
})
test('dragged blank separators cannot activate an earlier interior math line', () => {
  const body = `p1\np2\n$$ ${'q'.repeat(4000)}\n${'r'.repeat(5991)}\nplast`
  for (const doc of [
    `X\n\n${body}\n\n\n\n\n\nB\n\n$$\n`,
    `> X\n>\n${body
      .split('\n')
      .map((line) => '> ' + line)
      .join('\n')}\n>\n>\n>\n>\n>\n> B\n>\n> $$\n`,
  ]) {
    const { state, tree } = view(doc)
    const find = (token) => {
      let node = tree.resolveInner(doc.indexOf(token), 1)
      while (node && node.name !== 'Paragraph') node = node.parent
      assert.ok(node)
      return node
    }
    assert.equal(moveBlock(state, tree, find('B\n'), find('X'), false), null)
  }
})

test('every block in 800 seeded mixed notes preserves structure in both directions', () => {
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
    moves = 0
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  for (let i = 0; i < 400; i++) {
    const blocks = Array.from({ length: 6 }, (_, j) =>
      kinds[Math.floor(random() * kinds.length)](j),
    )
    for (const spacing of ['\n\n', '\n']) {
      let doc = `${blocks.join(spacing)}\n`
      if (i % 4 === 3)
        doc = `${doc
          .trimEnd()
          .split('\n')
          .map((line) => (line ? `> ${line}` : '>'))
          .join('\n')}\n`
      moves += checkMoves(doc)
    }
  }
  console.log(JSON.stringify({ moves, changed: 0 }))
  assert.ok(moves > 4000, String(moves))
})

test('jumping to a known giant end retains decisions through worker adoption', () => {
  const filler = (length, tag) => {
    const lines = []
    let size = 0
    for (let i = 0; size < length; i++) {
      const line = `${tag}${i} ${'w'.repeat(60 + (i % 37))}`
      lines.push(line)
      size += line.length + 1
    }
    return lines.join('\n')
  }
  const paragraph =
    'intro words of the long paragraph\n' +
    filler(80000, 'p') +
    '\n$$ a\n' +
    filler(9600, 'f')
  const doc =
    paragraph +
    '\n\nm $$ x\n\nz $$\n\n' +
    filler(4000, 'q') +
    '\n\n' +
    filler(30000, 'r').replaceAll('\n', '\n\n') +
    '\n'
  const chunked = new ChunkedMarkdownParser(md, md)
  const finish = (work) => {
    let tree
    while (!tree) tree = work.advance()
    return tree
  }
  const input = (doc) => new DocInput(EditorState.create({ doc }).doc)
  const demand = {
    from: doc.indexOf('m $$ x') + 3000,
    to: doc.indexOf('m $$ x') + 6000,
  }
  const initial = finish(chunked.startChunkedParse(input(doc), [], demand))
  const worker = finish(chunked.startBoundaryParse(input(doc), []))
  const edited = doc.slice(0, 5) + 'x' + doc.slice(5)
  const change = [{ fromA: 5, toA: 5, fromB: 5, toB: 6 }]
  const fragments = (tree) =>
    TreeFragment.applyChanges(TreeFragment.addTree(tree), change)
  const updated = finish(
    chunked.startChunkedParse(input(edited), fragments(initial), demand),
  )
  const repaired = finish(
    chunked.startBoundaryParse(input(edited), fragments(worker)),
  )
  const boundary = new BoundaryTree(chunked, edited.length)
  const records = [...boundaryRecords(repaired)]
  for (let i = 0; i < records.length; i += 128)
    boundary.append(records.slice(i, i + 128))
  const fresh = finish(chunked.startChunkedParse(input(edited), [], demand))
  const adopted = finish(
    chunked.startChunkedParse(
      input(edited),
      spliceBoundaryFragments(
        fresh,
        TreeFragment.addTree(fresh),
        0,
        edited.length,
        boundary.finish(),
      ),
      demand,
      0,
      true,
    ),
  )
  const { state } = view(edited)
  const at = edited.indexOf('m $$ x')
  const deciding = edited.indexOf('\n$$ a\n') + 1
  for (const tree of [updated, repaired, adopted]) {
    const decisions = readAheadFrom(tree, at)
    assert.ok(
      decisions === null || decisions.includes(deciding),
      String(decisions),
    )
  }
  for (const tree of [updated, adopted]) {
    let target = tree.resolveInner(at, 1)
    while (target && target.name !== 'Paragraph') target = target.parent
    let block = tree.resolveInner(edited.indexOf('z $$'), 1)
    while (block && block.name !== 'Paragraph') block = block.parent
    assert.ok(block && target)
    assert.equal(moveBlock(state, tree, block, target, false), null)
  }
})

test('a stuck continuation retains decisions before its new window', () => {
  const paragraphs = (length, tag) => {
    const lines = []
    let size = 0
    for (let i = 0; size < length; i++) {
      const line = `> ${tag}${i} ${'w'.repeat(60 + (i % 37))}`
      lines.push(line, '>')
      size += line.length + 3
    }
    return lines.join('\n')
  }
  const doc =
    '> intro\n>\n' +
    paragraphs(15000, 'p') +
    '\n> $$ a\n>\n' +
    paragraphs(9500, 'f') +
    '\n> m $$ x\n>\n> z $$\n>\n' +
    paragraphs(12000, 'g') +
    '\n> > ~~~\n> > code\n> > ~~~\n> >\n' +
    '> > quoted words *em*\n'.repeat(5000) +
    '\nend words\n'
  const chunked = new ChunkedMarkdownParser(md, md, {
    chunkSize: 1024,
    groupSize: 4,
    giantBlock: 65536,
  })
  const demand = {
    from: doc.indexOf('z $$') + 3000,
    to: doc.indexOf('z $$') + 6000,
  }
  const parse = (text, fragments, demand) => {
    const work = chunked.startChunkedParse(
      new DocInput(EditorState.create({ doc: text }).doc),
      fragments,
      demand,
    )
    let tree
    while (!tree) tree = work.advance()
    return tree
  }
  const initial = parse(doc, [], demand)
  const at = doc.indexOf('m $$ x')
  const deciding = doc.indexOf('> $$ a')
  assert.ok(readAheadFrom(initial, at)?.includes(deciding))
  const edit = doc.indexOf('> g40 ') + 4
  const edited = doc.slice(0, edit) + 'x' + doc.slice(edit)
  const fragments = TreeFragment.applyChanges(TreeFragment.addTree(initial), [
    { fromA: edit, toA: edit, fromB: edit, toB: edit + 1 },
  ])
  const { state } = view(edited)
  for (const viewport of [demand, { from: Infinity, to: Infinity }]) {
    const tree = parse(edited, fragments, viewport)
    const decisions = readAheadFrom(tree, at)
    assert.ok(
      decisions === null || decisions.includes(deciding),
      String(decisions),
    )
    if (viewport !== demand) continue
    let target = tree.resolveInner(at, 1)
    while (target && target.name !== 'Paragraph') target = target.parent
    let block = tree.resolveInner(edited.indexOf('z $$'), 1)
    while (block && block.name !== 'Paragraph') block = block.parent
    assert.ok(block && target)
    assert.equal(moveBlock(state, tree, block, target, false), null)
  }
})

test('viewport changes retain distant math decisions in giant containers', () => {
  const doc =
    '> intro\n>\n' +
    Array.from({ length: 300 }, (_, i) => `> padding ${i}\n>\n`).join('') +
    '> $$ a\n>\n' +
    '> f\n>\n'.repeat(1000) +
    '> m $$ x\n>\n> z $$\n'
  const { state } = view(doc)
  const chunked = new ChunkedMarkdownParser(md, md, {
    chunkSize: 128,
    groupSize: 4,
    giantBlock: 512,
  })
  const parse = (old, from, to) => {
    const work = chunked.startChunkedParse(
      new DocInput(state.doc),
      old ? TreeFragment.addTree(old) : [],
      { from, to },
    )
    for (;;) {
      const tree = work.advance()
      if (tree) return tree
    }
  }
  const at = doc.indexOf('m $$ x')
  const initial = parse(null, Infinity, Infinity)
  const boundary = new BoundaryTree(chunked, doc.length)
  const records = [...boundaryRecords(initial)]
  for (let i = 0; i < records.length; i += 128)
    boundary.append(records.slice(i, i + 128))
  for (const [complete, original] of [
    [true, initial],
    [false, boundary.finish()],
  ]) {
    let tree = original
    for (let i = 0; i < 3; i++) {
      tree = parse(tree, at - 10, doc.length)
      const starts = readAheadFrom(tree, at)
      if (complete) assert.ok(starts?.includes(doc.indexOf('> $$ a')))
      else assert.equal(starts, null)
      let block = tree.resolveInner(at, 1)
      while (block && block.name !== 'Paragraph') block = block.parent
      assert.ok(block)
      assert.equal(blockStep(state, tree, block, 1), null)
      tree = parse(tree, 0, 40)
    }
  }
})

test('mixed math decisions preserve the complete block tree in both directions', () => {
  const kinds = [
    '$$ a',
    'm $$ x',
    'z $$',
    '$$\nx\n$$',
    'a1\na2\n$$ q\na4\na5',
    'paragraph',
    '- item\n- second',
    '> quote\n>\n> after',
    '## heading',
  ]
  let seed = 29
  let moves = 0
  for (let i = 0; i < 300; i++) {
    const blocks = Array.from({ length: 7 }, () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return kinds[seed % kinds.length]
    })
    for (const spacing of ['\n', '\n\n']) {
      let doc = blocks.join(spacing) + '\n'
      if (i % 3 === 0)
        doc = doc
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n')
      moves += checkMoves(doc)
    }
  }
  console.log(JSON.stringify({ mathMoves: moves, changed: 0 }))
  assert.ok(moves > 500, String(moves))
})

test('varied list marker widths and blank runs retain the complete block tree', () => {
  let moves = 0
  for (const [first, second] of [
    ['-', '-'],
    ['1.', '2.'],
    ['9.', '10.'],
    ['10.', '11.'],
  ])
    for (const a of [1, 3])
      for (const b of [0, 1, 2, 4])
        for (const indent of [0, 1, 2, 3, 4, 5])
          for (const blanks of [1, 4])
            for (const quoted of [false, true]) {
              let doc =
                first +
                ' '.repeat(a) +
                'first\n' +
                second +
                (b ? ' '.repeat(b) + 'second' : '') +
                '\n'.repeat(blanks + 1) +
                ' '.repeat(indent) +
                'note\n'
              if (quoted)
                doc =
                  doc
                    .trimEnd()
                    .split('\n')
                    .map((line) => (line ? '> ' + line : '>'))
                    .join('\n') + '\n'
              moves += checkMoves(doc)
            }
  console.log(JSON.stringify({ variedListMoves: moves, changed: 0 }))
  assert.ok(moves > 500)
  const lazy = '> 9. nine\n> 10. ten\n>     more\n    ~~~\n> after\n'
  assert.ok(checkMoves(lazy))
  assert.ok(moved(lazy, '10.', 'ListItem', -1).includes('\n    ~~~\n'))
  assert.equal(
    moved('- intro bullet\n\n1. first\n  2. second\n', 'first', 'ListItem', 1),
    null,
  )
})

test('lazy continuation and paragraph interruption at either seam stay unchanged', () => {
  for (const [doc, token, name, direction] of [
    ['> para\n>\n> # heading\nlazy text\n', 'para', 'Paragraph', 1],
    ['> para\n>\n> # heading\nlazy text\n', 'heading', 'ATXHeading1', -1],
    ['> > para\n> >\n> > # h\n> after\n', 'para', 'Paragraph', 1],
    ['- x\n\n  para\n\n  # h\nlazy\n', 'para', 'Paragraph', 1],
    ['> para\n>\n> ***\nnext\n', 'para', 'Paragraph', 1],
    ['> para\n>\n> ```\n> code\n> ```\nnext\n', 'para', 'Paragraph', 1],
    ['> > reply\n> >\n> > ---\n> answer\n', 'reply', 'Paragraph', 1],
    ['para\n- b\n-\n  a\n', '-\n  a', 'ListItem', -1],
    ['para\n1. one\n2.\n', '2.', 'ListItem', -1],
  ]) {
    assert.equal(moved(doc, token, name, direction), null, doc)
  }
  for (const doc of [
    '> ```\n> code\n> ```\n>\n> p1\n>\n> p2\n>\n> p3\n',
    '```\ncode\n```\n> p1\n>\n> p2\n>\n> p3\n',
  ])
    assert.equal(
      moved(doc, 'p2', 'Paragraph', 1),
      doc.replace('p2\n>\n> p3', 'p3\n>\n> p2'),
    )
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
    const prototype = Object.getPrototypeOf(state.doc)
    const read = prototype.sliceString
    let widest = 0
    try {
      prototype.sliceString = function (from = 0, to = this.length, ...args) {
        widest = Math.max(widest, to - from)
        return read.call(this, from, to, ...args)
      }
      assert.ok(blockStep(state, tree, node, 1))
    } finally {
      prototype.sliceString = read
    }
    assert.ok(widest < 2048, String(widest))
    assert.equal(calls, 2)
    return units
  }
  const small = measure(100),
    large = measure(20000)
  console.log(JSON.stringify({ validationUnits: { small, large } }))
  assert.equal(large, small)
  assert.ok(large < 2048, String(large))
})

test('validation skips interiors of 50 mib neighbors and distant unchanged siblings', () => {
  const counted = (doc, tree, source, destination, drop = false) => {
    let units = 0
    const state = EditorState.create({
      doc,
      extensions: formattedBlockParser.of(() => ({
        parse(input, fragments, ranges) {
          units += ranges.reduce((sum, range) => sum + range.to - range.from, 0)
          return md.parse(input, fragments, ranges)
        },
      })),
    })
    const node = (token) => {
      let n = tree.resolveInner(doc.indexOf(token), 1)
      while (n && n.name !== 'Paragraph') n = n.parent
      assert.ok(n)
      return n
    }
    const block = node(source)
    assert.ok(
      drop
        ? moveBlock(state, tree, block, node(destination), true)
        : blockStep(state, tree, block, 1),
    )
    return units
  }
  for (const fence of [false, true]) {
    const measure = (mib) => {
      const row = fence
        ? 'code ' + 'x'.repeat(1000) + '\n'
        : '| ' + 'x'.repeat(1000) + ' | y |\n'
      const header = fence ? '\x60\x60\x60txt\n' : '| a | b |\n| - | - |\n'
      const body = row.repeat(Math.ceil((mib * 1024 * 1024) / row.length))
      const doc =
        'before\n\n' +
        header +
        body +
        (fence ? '\x60\x60\x60\n' : '') +
        '\nmiddle\n\nlast\n'
      // A known block's head and tail, as in the view's giant-block tree.
      const tail = doc.lastIndexOf(row)
      const tree = md.parse(
        doc,
        [],
        [
          { from: 0, to: 8 + header.length },
          { from: tail, to: doc.length },
        ],
      )
      return counted(doc, tree, 'before') + counted(doc, tree, 'middle')
    }
    const small = measure(2),
      large = measure(50)
    console.log(
      JSON.stringify({ kind: fence ? 'fence' : 'table', small, large }),
    )
    assert.equal(large, small)
    assert.ok(large < 16384, String(large))
  }
  const measure = (count) => {
    const doc =
      Array.from(
        { length: count },
        (_, i) => 'paragraph ' + String(i).padStart(5, '0') + ' text',
      ).join('\n\n') + '\n'
    return counted(
      doc,
      md.parse(doc),
      'paragraph 00010',
      'paragraph ' + String(count - 10).padStart(5, '0'),
      true,
    )
  }
  const small = measure(100),
    large = measure(20000)
  console.log(JSON.stringify({ farDrop: { small, large } }))
  assert.equal(large, small)
  assert.ok(large < 2048, String(large))
})

test('a 50 mib commonmark paragraph neighbor does not trigger an inline character walk', () => {
  const grammar = EditorState.create({
    extensions: formattedSyntax().extension,
  })
  const plain = grammar.facet(formattedBlockParser)(grammar)
  const measure = (mib) => {
    const doc =
      'first\n\n' +
      'word '.repeat(Math.ceil((mib * 1024 * 1024) / 5)) +
      '\n\nlast\n'
    const tree = plain.parse(doc)
    const state = EditorState.create({
      doc,
      extensions: formattedBlockParser.of(() => plain),
    })
    const original = String.prototype.charCodeAt
    let calls = 0
    try {
      String.prototype.charCodeAt = function (...args) {
        calls++
        return original.apply(this, args)
      }
      assert.ok(blockStep(state, tree, tree.topNode.firstChild, 1))
    } finally {
      String.prototype.charCodeAt = original
    }
    return calls
  }
  const small = measure(2),
    large = measure(50)
  console.log(JSON.stringify({ wideLineCharacters: { small, large } }))
  assert.equal(large, small)
  assert.ok(large < 2048, String(large))
})

test('blank quote tails stay outside validation work and nested outlines use edge paths', () => {
  const quoted = (mib) => {
    const head = '> one\n>\n> two\n',
      row = '> ' + ' '.repeat(1000) + '\n'
    const doc =
      head +
      row.repeat(Math.ceil((mib * 1024 * 1024) / row.length)) +
      '\nafter\n'
    const tree = md.parse(
      doc,
      [],
      [
        { from: 0, to: head.length },
        { from: doc.lastIndexOf(row), to: doc.length },
      ],
    )
    const state = EditorState.create({
      doc,
      extensions: formattedBlockParser.of(() => md),
    })
    const prototype = Object.getPrototypeOf(state.doc),
      read = prototype.sliceString,
      line = prototype.line
    let bytes = 0,
      lines = 0
    try {
      prototype.sliceString = function (from = 0, to = this.length, ...args) {
        bytes += to - from
        if (bytes > 65536) throw new Error('move scanned the blank run')
        return read.call(this, from, to, ...args)
      }
      prototype.line = function (...args) {
        if (++lines > 4096) throw new Error('move walked the blank lines')
        return line.apply(this, args)
      }
      assert.ok(blockStep(state, tree, tree.resolveInner(2, 1), 1))
    } finally {
      prototype.sliceString = read
      prototype.line = line
    }
    return { bytes, lines }
  }
  const small = quoted(2),
    large = quoted(50)
  console.log(JSON.stringify({ quoteTail: { small, large } }))
  assert.deepEqual(large, small)

  const outline = (depth) => {
    const lines = []
    let id = 0
    const append = (level) => {
      for (let i = 0; i < 2; i++) {
        lines.push('  '.repeat(level) + '- item ' + id++)
        if (level + 1 < depth) append(level + 1)
      }
    }
    append(0)
    const doc = lines.join('\n') + '\n\nmoved\n\nlast\n'
    const tree = md.parse(doc)
    let units = 0
    const state = EditorState.create({
      doc,
      extensions: formattedBlockParser.of(() => ({
        parse(input, fragments, ranges) {
          units += ranges.reduce((sum, range) => sum + range.to - range.from, 0)
          if (units > 16384) throw new Error('move scanned the whole outline')
          return md.parse(input, fragments, ranges)
        },
      })),
    })
    let node = tree.resolveInner(doc.indexOf('moved'), 1)
    while (node.name !== 'Paragraph') node = node.parent
    assert.ok(blockStep(state, tree, node, -1))
    return units
  }
  const shallow = outline(8),
    deep = outline(16)
  console.log(JSON.stringify({ branchingOutline: { shallow, deep } }))
  assert.ok(deep < shallow * 8)
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

test('later item blocks move after a closed first block', () => {
  for (const first of [
    '\x60\x60\x60txt\n  code\n  \x60\x60\x60',
    '<!--\n  body\n  -->',
    '<?php\n  body\n  ?>',
    '<script>\n  body\n  </script>',
    '| a |\n  | - |\n  | b |',
  ]) {
    const doc = `- ${first}\n\n  one\n\n  two\n\n  three\n\n  four\n`
    assert.equal(
      moved(doc, 'three', 'Paragraph', 1),
      doc.replace('  three\n\n  four', '  four\n\n  three'),
      first,
    )
  }
})
