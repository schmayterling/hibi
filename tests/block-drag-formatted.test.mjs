import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { TreeFragment } from '@lezer/common'
import { GFM, parser, Table } from '@lezer/markdown'
import {
  blockNode,
  blockStep,
  dropSibling,
  handleTarget,
  moveBlock,
  selectionStep,
} from '../src/addons/block-drag/formatted.ts'
import {
  ChunkedMarkdownParser,
  parsedChunks,
} from '../src/renderer/src/chunked-markdown.ts'
import {
  formattedMarkdown,
  formattedPrefix,
} from '../src/renderer/src/formatted-contributions.ts'
import { formattedSyntax } from '../src/renderer/src/formatted-syntax.ts'

/** A formatted view's state and syntax tree for `doc`, with the caret at `anchor`. */
const view = (doc, anchor = 0, extensions = []) => {
  const syntax = formattedSyntax({ slice: 1000 })
  const state = EditorState.create({
    doc,
    selection: { anchor },
    extensions: [extensions, syntax.extension],
  })
  return { state, tree: syntax.tree(state) }
}
const edited = (state, spec) =>
  spec ? state.update(spec).state.doc.toString() : null
/** Move the block at the caret `at` one place up or down, as the palette commands do. */
const step = (doc, at, direction, extensions) => {
  const { state, tree } = view(doc, doc.indexOf(at), extensions)
  return edited(state, selectionStep(state, tree, direction))
}
const nodeAt = (tree, pos, name) => {
  let node = tree.resolveInner(pos, 1)
  while (node && node.name !== name) node = node.parent
  return node
}
/** Drag the `name` block at `from` and drop it beside the sibling at `to`. */
const drag = (doc, from, name, to, after) => {
  const { state, tree } = view(doc)
  const block = nodeAt(tree, doc.indexOf(from), name)
  const near = dropSibling(tree, block, doc.indexOf(to))
  return edited(state, near && moveBlock(state, tree, block, near, after))
}

test('moving a block swaps it with its sibling in one source edit', () => {
  const note = '# Title\n\nsecond\n\nthird'
  assert.equal(step(note, 'Title', 1), 'second\n\n# Title\n\nthird')
  assert.equal(step(note, 'second', -1), 'second\n\n# Title\n\nthird')
  assert.equal(step(note, 'third', -1), '# Title\n\nthird\n\nsecond')
  assert.equal(step(note, 'third', 1), null)
  assert.equal(step(note, 'Title', -1), null)
  // Tight and loose items keep the separator of each place.
  assert.equal(step('- a\n- b\n- c\n', 'a', 1), '- b\n- a\n- c\n')
  assert.equal(step('- a\n\n- b\n- c\n', 'a', 1), '- b\n\n- a\n- c\n')
  // Items move with their nested lists; nested items move among themselves.
  assert.equal(
    step('- a\n- b\n  - b1\n- c\n', 'b', 1),
    '- a\n- c\n- b\n  - b1\n',
  )
  assert.equal(
    step('- a\n  - a1\n  - a2\n- b\n', 'a1', 1),
    '- a\n  - a2\n  - a1\n- b\n',
  )
  // Blocks in quotes and items keep their containers' markers.
  assert.equal(step('> a\n>\n> b\n', 'a', 1), '> b\n>\n> a\n')
  assert.equal(
    step('> > inner\n> >\n> > two\n', 'inner', 1),
    '> > two\n> >\n> > inner\n',
  )
  assert.equal(
    step('- p1\n\n  p2\n\n  p3\n', 'p2', 1),
    '- p1\n\n  p3\n\n  p2\n',
  )
  assert.equal(
    step('```js\ncode\n```\n\npara\n', 'code', 1),
    'para\n\n```js\ncode\n```\n',
  )
  // A block that cannot move gives way to the container around it.
  assert.equal(step('> only\n\npara\n', 'only', 1), 'para\n\n> only\n')
  assert.equal(step('para\n\n- only\n', 'only', -1), '- only\n\npara\n')
})

test('the move is one transaction that keeps the caret in the moved block', () => {
  const doc = 'first\n\nsecond line\n\nthird'
  const { state, tree } = view(doc, doc.indexOf('line'))
  const spec = selectionStep(state, tree, -1)
  const next = state.update(spec)
  assert.equal(next.state.doc.toString(), 'second line\n\nfirst\n\nthird')
  assert.equal(next.state.selection.main.head, 'second '.length)
  assert.equal(next.isUserEvent('move'), true)
  // Only the moved block and its separators change.
  let touched = 0
  next.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    touched += toA - fromA + inserted.length
  })
  assert.ok(touched <= 3 * ('second line'.length + 2), String(touched))
})

test('numbered items keep the number of each place, and their lines follow its width', () => {
  assert.equal(step('1. a\n2. b\n3. c\n', 'a', 1), '1. b\n2. a\n3. c\n')
  assert.equal(step('1. a\n2. b\n3. c\n', 'c', -1), '1. a\n2. c\n3. b\n')
  // Numbers written alike stay alike.
  assert.equal(step('1. a\n1. b\n1. c\n', 'a', 1), '1. b\n1. a\n1. c\n')
  assert.equal(
    step('9. nine\n   more\n10. ten\n    more\n', 'nine', 1),
    '9. ten\n   more\n10. nine\n    more\n',
  )
  const list = '1. one\n2. two\n3. three\n4. four\n\nafter\n'
  assert.equal(
    drag(list, 'one', 'ListItem', 'three', true),
    '1. two\n2. three\n3. one\n4. four\n\nafter\n',
  )
  assert.equal(
    drag(list, 'four', 'ListItem', 'one', false),
    '1. four\n2. one\n3. two\n4. three\n\nafter\n',
  )
})

test('blocks other than items keep a blank line from their new neighbors', () => {
  // A paragraph after a quote with no blank line would continue the quote.
  assert.equal(step('para\n> quote\n', 'para', 1), '> quote\n\npara\n')
  assert.equal(step('para\n> quote\n', 'quote', -1), '> quote\n\npara\n')
  assert.equal(
    step('# H\npara\n\n- item\n', 'para', 1),
    '# H\n\n- item\n\npara\n',
  )
})

test('frontmatter and an item’s first block keep their places', () => {
  const frontmatter = formattedPrefix.of((state) => {
    const text = state.doc.toString()
    return text.startsWith('---\n') ? text.indexOf('\n---\n', 3) + 5 : 0
  })
  const note = '---\na: 1\n---\nfirst\n\nsecond\n'
  assert.equal(step(note, 'first', -1, [frontmatter]), null)
  assert.equal(
    step(note, 'second', -1, [frontmatter]),
    '---\na: 1\n---\nsecond\n\nfirst\n',
  )
  assert.equal(
    step(note, 'first', 1, [frontmatter]),
    '---\na: 1\n---\nsecond\n\nfirst\n',
  )
  const fencedMetadata = '---\na: |\n  \x60\x60\x60\n---\nfirst\n\nsecond\n'
  assert.equal(
    step(fencedMetadata, 'first', 1, [frontmatter]),
    fencedMetadata.replace('first\n\nsecond', 'second\n\nfirst'),
  )
  assert.equal(step('- p1\n\n  p2\n', 'p2', -1), null)
})

test('a drop lands beside the sibling under the pointer, or at the nearest end of its container', () => {
  const doc = '# A\n\nb para\n\nc para\n\nd para\n\ne para\n'
  assert.equal(
    drag(doc, '# A', 'ATXHeading1', 'd para', true),
    'b para\n\nc para\n\nd para\n\n# A\n\ne para\n',
  )
  assert.equal(
    drag(doc, '# A', 'ATXHeading1', 'd para', false),
    'b para\n\nc para\n\n# A\n\nd para\n\ne para\n',
  )
  assert.equal(
    drag(doc, 'e para', 'Paragraph', 'b para', false),
    '# A\n\ne para\n\nb para\n\nc para\n\nd para\n',
  )
  assert.equal(
    drag(doc, 'e para', 'Paragraph', '# A', true),
    '# A\n\ne para\n\nb para\n\nc para\n\nd para\n',
  )
  // On itself, or right after the block before it, it stays.
  assert.equal(drag(doc, 'c para', 'Paragraph', 'c para', true), null)
  assert.equal(drag(doc, 'c para', 'Paragraph', 'd para', false), null)
  // An item dropped outside its list goes to the list's nearest end.
  assert.equal(
    drag('- one\n- two\n\nafter\n', 'one', 'ListItem', 'after', true),
    '- two\n- one\n\nafter\n',
  )
})

test('the handle takes the innermost block, an item rather than its first block, and top-level blocks at the left edge', () => {
  const doc = '- a\n  - a1\n\n> q1\n>\n> q2\n\n| x |\n| - |\n| y |\n'
  const { tree } = view(doc, 0, [formattedMarkdown.of(Table)])
  const target = (text, edge = false) =>
    handleTarget(tree, doc.indexOf(text), () => edge)?.name ?? null
  assert.equal(target('a'), 'ListItem')
  assert.equal(target('a1'), 'ListItem')
  assert.equal(
    handleTarget(tree, doc.indexOf('a1'), () => false)?.from,
    doc.indexOf('- a1'),
  )
  assert.equal(target('q2'), 'Paragraph')
  // At the left edge, the pointer reaches the handle beside a nested block.
  assert.equal(target('a', true), null)
  assert.equal(target('q2', true), 'Blockquote')
  assert.equal(target('y'), 'Table')
})

/**
 * Parse `text` with its viewport at `demand`, as the formatted view does, in
 * small chunks; `earlier` viewports were parsed first.
 */
const windowed = (text, demand, options = {}, earlier = []) => {
  const markdown = parser.configure(GFM)
  let tree = null
  for (const viewport of [...earlier, demand]) {
    const parse = new ChunkedMarkdownParser(markdown, markdown, {
      chunkSize: 256,
      giantBlock: 4096,
      ...options,
    }).startChunkedParse(
      {
        length: text.length,
        chunk: (from) => text.slice(from),
        read: (from, to) => text.slice(from, to),
        lineChunks: false,
      },
      tree ? TreeFragment.addTree(tree) : [],
      viewport,
    )
    for (tree = null; !tree; ) tree = parse.advance()
  }
  return tree
}

test('neighbors in text the view has not parsed, or past text the tree skips, are never moved over', () => {
  // A long list keeps inner nodes for its opening line and a window around
  // the viewport; the items between them are not in the tree.
  const items = Array.from({ length: 3000 }, (_, i) => `- item ${i}`)
  const text = `${items.join('\n')}\n`
  const middle = text.indexOf('- item 1500')
  const tree = windowed(text, { from: middle, to: middle + 400 })
  const state = EditorState.create({ doc: text })
  const opening = nodeAt(tree, 0, 'ListItem')
  const inside = nodeAt(tree, text.indexOf('item 1500'), 'ListItem')
  assert.ok(opening.nextSibling.from > 1000, String(opening.nextSibling.from))
  // The tree's next item after the opening one is far below it: no move
  // takes the text between.
  assert.equal(blockStep(state, tree, opening, 1), null)
  assert.equal(moveBlock(state, tree, opening, inside, true), null)
  // Items in the window move among themselves.
  assert.equal(
    edited(state, blockStep(state, tree, inside, 1)).slice(middle, middle + 24),
    '- item 1501\n- item 1500\n',
  )
  const below = nodeAt(tree, text.indexOf('item 1510'), 'ListItem')
  const dropped = edited(state, moveBlock(state, tree, inside, below, true))
  assert.equal(dropped.length, text.length)
  assert.ok(dropped.includes('- item 1510\n- item 1500\n- item 1511\n'))

  // After a far jump, the blocks between the start and the viewport are
  // pending: the first block in view does not look through them for a sibling.
  const paragraphs = Array.from({ length: 4000 }, (_, i) => `paragraph ${i}`)
  const long = paragraphs.join('\n\n')
  const far = Math.floor(long.length * 0.7)
  const jumped = windowed(long, { from: far, to: far + 400 }, {}, [
    { from: 0, to: 300 },
  ])
  const shown = parsedChunks(jumped).find(({ from }) => from > 1000)
  const first = nodeAt(jumped, shown.from + 1, 'Paragraph')
  const longState = EditorState.create({ doc: long })
  reads.watch(jumped, [0, first.from])
  reads.reset()
  assert.equal(blockStep(longState, jumped, first, -1), null)
  assert.ok(reads.count() < 20, String(reads.count()))
})

/**
 * Syntax node reads: navigation getters of lezer's node classes, and node
 * type checks, which also count the chunks a sibling lookup passes over.
 */
const reads = (() => {
  let count = 0
  const patched = new Set()
  return {
    /** Count reads on the node classes of `tree`. */
    watch(tree, positions) {
      const nodes = [
        tree.topNode,
        ...positions.map((pos) => tree.resolveInner(pos, 1)),
      ]
      for (const prototype of new Set([
        ...nodes.map(Object.getPrototypeOf),
        Object.getPrototypeOf(tree.type),
      ])) {
        if (patched.has(prototype)) continue
        patched.add(prototype)
        for (const key of [
          'parent',
          'nextSibling',
          'prevSibling',
          'firstChild',
          'lastChild',
          'isAnonymous',
        ]) {
          const descriptor = Object.getOwnPropertyDescriptor(prototype, key)
          if (!descriptor?.get) continue
          Object.defineProperty(prototype, key, {
            ...descriptor,
            get() {
              count++
              return descriptor.get.call(this)
            },
          })
        }
      }
    },
    reset: () => {
      count = 0
    },
    count: () => count,
  }
})()

test('finding and moving a block reads as many syntax nodes in a 20k-block note as in a small one', () => {
  const unit = (i) =>
    `## Section ${i}\n\nParagraph ${i} with **bold** text.\n\n- item ${i}a\n- item ${i}b\n\n> quote ${i}\n`
  const measure = (units) => {
    const text = Array.from({ length: units }, (_, i) => unit(i)).join('\n')
    const at = text.indexOf(`Paragraph ${units >> 1} `)
    const tree = windowed(text, { from: at - 200, to: at + 400 }, {})
    const state = EditorState.create({ doc: text, selection: { anchor: at } })
    reads.watch(tree, [at, text.indexOf('**bold**', at) + 3])
    reads.reset()
    const target = handleTarget(tree, at, () => false)
    const hover = reads.count()
    reads.reset()
    const item = nodeAt(tree, text.indexOf(`item ${units >> 1}a`), 'ListItem')
    const near = dropSibling(
      tree,
      item,
      text.indexOf(`quote ${(units >> 1) + 1}`),
    )
    const drop = reads.count()
    reads.reset()
    const spec = selectionStep(state, tree, 1)
    const move = reads.count()
    assert.equal(target?.name, 'Paragraph')
    assert.equal(near?.name, 'ListItem')
    assert.ok(spec)
    let touched = 0
    state.update(spec).changes.iterChanges((fromA, toA, _a, _b, inserted) => {
      touched += toA - fromA + inserted.length
    })
    return { hover, drop, move, touched }
  }
  const small = measure(200)
  const large = measure(20000)
  console.log(JSON.stringify({ small, large }))
  // Work depends on the blocks around the pointer, not the note's length.
  for (const key of ['hover', 'drop', 'move', 'touched'])
    assert.ok(
      large[key] <= small[key] + 8,
      `${key}: ${small[key]} → ${large[key]}`,
    )
  // Moves also verify the block context beyond both container edges.
  assert.ok(
    large.hover <= 150 && large.drop <= 300 && large.move <= 900,
    JSON.stringify(large),
  )
})

test('a block found again by range and name is the same node', () => {
  const doc = '# A\n\n- one\n- two\n'
  const { tree } = view(doc)
  const item = nodeAt(tree, doc.indexOf('two'), 'ListItem')
  const found = blockNode(tree, {
    from: item.from,
    to: item.to,
    name: 'ListItem',
  })
  assert.equal(found?.from, item.from)
  assert.equal(
    blockNode(tree, { from: item.from, to: item.to, name: 'Paragraph' }),
    null,
  )
})
