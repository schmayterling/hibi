import assert from 'node:assert/strict'
import test from 'node:test'
import { getSchema } from '@tiptap/core'
import { Image } from '@tiptap/extension-image'
import { TableKit } from '@tiptap/extension-table'
import { MarkdownManager } from '@tiptap/markdown'
import { Fragment, Schema } from '@tiptap/pm/model'
import { AllSelection, NodeSelection, TextSelection } from '@tiptap/pm/state'
import { CellSelection } from '@tiptap/pm/tables'
import { StarterKit } from '@tiptap/starter-kit'
import { Marked } from 'marked'
import { markdownPositions } from '../src/renderer/src/markdown-positions.ts'
import {
  richChangeMap,
  richEditMap,
} from '../src/renderer/src/rich-change-map.ts'

const extensions = [
  StarterKit.configure({ trailingNode: false }),
  Image,
  TableKit,
]
const schema = getSchema(extensions)
const manager = new MarkdownManager({
  extensions,
  markedOptions: { gfm: true },
})
const parse = (source) => schema.nodeFromJSON(manager.parse(source))
const original =
  '# notes\n\n![first](https://example.com/a.png)\n\nalpha beta\n\n| a | b |\n| --- | --- |\n| c | d |\n\nomega'

const at = (doc, matches) => {
  let found
  doc.descendants((node, pos) => {
    if (found === undefined && matches(node)) found = pos
  })
  if (found === undefined) throw new Error('missing fixture node')
  return found
}
function selections(doc) {
  const beta = at(doc, (node) => node.isText && node.text.includes('beta'))
  const from = beta + doc.nodeAt(beta).text.indexOf('beta')
  const cells = []
  doc.descendants((node, pos) => {
    if (node.type.name === 'tableCell') cells.push(pos)
  })
  return {
    text: TextSelection.create(doc, from, from + 4),
    node: NodeSelection.create(
      doc,
      at(doc, (node) => node.type.name === 'image'),
    ),
    cell: CellSelection.create(doc, cells[0], cells[1]),
    all: new AllSelection(doc),
  }
}
const describe = (selection) => ({
  type: selection.toJSON().type,
  node: selection instanceof NodeSelection ? selection.node.type.name : null,
  text: selection.$from.doc.textBetween(selection.from, selection.to, '|', '#'),
})

test('selections keep their kind and content when the preview is unchanged', () => {
  const before = parse(original)
  // A final newline changes the source but not the parsed document.
  const after = parse(`${original}\n`)
  assert.ok(before.eq(after) && before !== after)
  for (const [kind, selection] of Object.entries(selections(before))) {
    const mapped = selection.map(after, richChangeMap(before, after))
    assert.deepEqual(describe(mapped), describe(selection), kind)
    assert.deepEqual(mapped.toJSON(), selection.toJSON(), kind)
  }
})

test('untouched blocks between separate edits keep exact selections', () => {
  const before = parse(original)
  for (const source of [
    `preface\n\n${original} suffix`,
    `# notes changed\n\n${original.slice(9)} suffix`,
    original.replace('omega', 'omega\n\nlate'),
  ]) {
    const after = parse(source)
    const map = richChangeMap(before, after)
    const expected = selections(after)
    for (const [kind, selection] of Object.entries(selections(before))) {
      const mapped = selection.map(after, map)
      assert.deepEqual(mapped.toJSON(), expected[kind].toJSON(), kind)
    }
  }
})

test('moved and repeated blocks still anchor the unchanged ones', () => {
  const before = parse('first\n\nalpha beta\n\nsecond\n\nthird')
  const after = parse('alpha beta\n\nsecond\n\nthird\n\nfirst')
  const from = at(before, (node) => node.isText && node.text === 'alpha beta')
  const mapped = TextSelection.create(before, from + 6, from + 10).map(
    after,
    richChangeMap(before, after),
  )
  assert.equal(after.textBetween(mapped.from, mapped.to), 'beta')
  const repeated = parse('same\n\nsame\n\nalpha beta\n\nsame')
  const edited = parse('same\n\nalpha beta\n\nsame\n\nsame\n\nnew')
  const inside = at(
    repeated,
    (node) => node.isText && node.text === 'alpha beta',
  )
  const kept = TextSelection.create(repeated, inside + 6, inside + 10).map(
    edited,
    richChangeMap(repeated, edited),
  )
  assert.equal(edited.textBetween(kept.from, kept.to), 'beta')
})

// Inline images stand in for any atom next to an edit, such as inline math.
const inline = [
  StarterKit.configure({ trailingNode: false }),
  Image.configure({ inline: true }),
]
const inlineSchema = getSchema(inline)
const inlineManager = new MarkdownManager({
  marked: new Marked({ gfm: true }),
  extensions: inline,
})
// The map the split preview builds at catch-up from its composed source edits.
function edited(source, edits) {
  let next = source
  for (const edit of [...edits].reverse())
    next = next.slice(0, edit.from) + edit.insert + next.slice(edit.to)
  const before = inlineSchema.nodeFromJSON(inlineManager.parse(source)),
    after = inlineSchema.nodeFromJSON(inlineManager.parse(next))
  return {
    before,
    after,
    map: richEditMap(before, after, edits, source.length, [
      markdownPositions(source, before),
      markdownPositions(next, after),
    ]),
  }
}
const lineEnd = (source, line) => {
  let end = -1
  for (let index = 0; index < line; index++) end = source.indexOf('\n', end + 1)
  return end < 0 ? source.length : end
}

test('source edits map selections in repeated, atom and edited blocks exactly', () => {
  const image = '![x](https://example.com/x.png)'
  const cases = [
    {
      source: `alpha ${image} beta gamma\n\nomega`,
      target: 'beta',
      edits: (s) => [
        { from: 0, to: 0, insert: '!' },
        { from: lineEnd(s, 1), to: lineEnd(s, 1), insert: '?' },
      ],
    },
    {
      source: `left\n\nsame\n\nsame\n\nmath ${image}\n\nomega`,
      target: 'same',
      edits: (s) => [
        { from: 4, to: 4, insert: '!' },
        { from: lineEnd(s, 7), to: lineEnd(s, 7), insert: '?' },
      ],
    },
    {
      source: `left\n\n![a](https://example.com/a.png)\n\n![b](https://example.com/b.png)\n\nmath ${image}\n\nomega`,
      target: null,
      edits: (s) => [
        { from: 4, to: 4, insert: '!' },
        { from: lineEnd(s, 7), to: lineEnd(s, 7), insert: '?' },
      ],
    },
  ]
  for (const item of cases) {
    const { before, after, map } = edited(item.source, item.edits(item.source))
    const position = at(before, (node) =>
      item.target
        ? node.isText && node.text.includes(item.target)
        : node.type.name === 'image',
    )
    const selection = item.target
      ? TextSelection.create(
          before,
          position + before.nodeAt(position).text.indexOf(item.target),
          position +
            before.nodeAt(position).text.indexOf(item.target) +
            item.target.length,
        )
      : NodeSelection.create(before, position)
    const mapped = selection.map(after, map)
    assert.equal(mapped.toJSON().type, selection.toJSON().type, item.source)
    if (item.target)
      assert.equal(
        after.textBetween(mapped.from, mapped.to),
        item.target,
        item.source,
      )
    else
      assert.equal(
        mapped.node.attrs.src,
        'https://example.com/a.png',
        item.source,
      )
    // The first repeated block stays the first one.
    assert.equal(mapped.from - selection.from, 1, item.source)
  }
})

test('edits deep inside long atoms keep the text between them', () => {
  // No visible text lies within hundreds of source units of either edit.
  const url = (name) => `https://example.com/${name.repeat(200)}.png`
  const source = `alpha ![x](${url('x')}) beta ![y](${url('y')}) gamma`
  const middle = (name) => source.indexOf(url(name)) + 100
  const { before, after, map } = edited(source, [
    { from: middle('x'), to: middle('x'), insert: 'z' },
    { from: middle('y'), to: middle('y'), insert: 'z' },
  ])
  const beta = at(before, (node) => node.isText && node.text.includes('beta'))
  const from = beta + before.nodeAt(beta).text.indexOf('beta')
  const mapped = TextSelection.create(before, from, from + 4).map(after, map)
  assert.equal(after.textBetween(mapped.from, mapped.to), 'beta')
  assert.deepEqual([mapped.from, mapped.to], [from, from + 4])
})

test('edits with wider effects still map the content they leave alone', () => {
  // A heading marker changes the block type; the following blocks keep their place.
  const source = 'alpha\n\nbeta gamma\n\nomega'
  const { before, after, map } = edited(source, [
    { from: 0, to: 0, insert: '# ' },
  ])
  const beta = at(before, (node) => node.isText && node.text === 'beta gamma')
  const mapped = TextSelection.create(before, beta, beta + 4).map(after, map)
  assert.equal(after.textBetween(mapped.from, mapped.to), 'beta')
  assert.equal(after.firstChild.type.name, 'heading')
  // A lazy line joins the previous paragraph, so the edit covers both blocks.
  const joined = edited('one\n\ntwo\n\nthree', [{ from: 3, to: 5, insert: '' }])
  const three = at(
    joined.before,
    (node) => node.isText && node.text === 'three',
  )
  const kept = TextSelection.create(joined.before, three, three + 5).map(
    joined.after,
    joined.map,
  )
  assert.equal(joined.after.textBetween(kept.from, kept.to), 'three')
})

test('wrapping or unwrapping a block keeps selections in the blocks after it', () => {
  for (const [prefix, insert, moved] of [
    ['', '> ', 2],
    ['', '- ', 4],
    ['> ', '', -2],
    ['- ', '', -4],
  ]) {
    const source = `${prefix}alpha\n\nbeta gamma\n\nomega`
    const { before, after, map } = edited(source, [
      { from: 0, to: prefix.length, insert },
    ])
    const beta = at(before, (node) => node.isText && node.text === 'beta gamma')
    const mapped = TextSelection.create(before, beta, beta + 4).map(after, map)
    assert.equal(after.textBetween(mapped.from, mapped.to), 'beta', source)
    assert.equal(mapped.from - beta, moved, source)
  }
})

test('edits spread through a long document or list read each block a bounded number of times', () => {
  const nestedSchema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { content: 'text*', group: 'block' },
      bullet_list: { content: 'list_item+', group: 'block' },
      list_item: { content: 'paragraph' },
      text: {},
    },
  })
  const lines = Array.from(
    { length: 50000 },
    (_, index) => `row ${index} alpha beta omega`,
  )
  for (const list of [false, true]) {
    const paragraph = (row) =>
      nestedSchema.node('paragraph', null, nestedSchema.text(row))
    const build = (rows) =>
      nestedSchema.node(
        'doc',
        null,
        list
          ? nestedSchema.node(
              'bullet_list',
              null,
              rows.map((row) =>
                nestedSchema.node('list_item', null, paragraph(row)),
              ),
            )
          : rows.map(paragraph),
      )
    const prefix = list ? '- ' : '',
      separator = list ? '\n' : '\n\n'
    const join = (rows) => rows.map((row) => prefix + row).join(separator)
    const source = join(lines),
      before = build(lines)
    const starts = [0]
    for (const line of lines)
      starts.push(
        starts.at(-1) + prefix.length + line.length + separator.length,
      )
    const oldMap = markdownPositions(source, before)
    // ProseMirror reads children one by one when it resolves or cuts positions.
    const reads = (count) => {
      const rows = lines.slice(),
        edits = []
      for (let edit = 0; edit < count; edit++) {
        const row = Math.floor(((edit + 1) * lines.length) / (count + 1)),
          at = starts[row] + prefix.length
        edits.push({ from: at, to: at, insert: '!' })
        rows[row] = `!${rows[row]}`
      }
      const after = build(rows)
      const lookups = [oldMap, markdownPositions(join(rows), after)]
      const child = Fragment.prototype.child
      let total = 0
      Fragment.prototype.child = function (index) {
        total++
        return child.call(this, index)
      }
      let map
      try {
        map = richEditMap(before, after, edits, source.length, lookups)
      } finally {
        Fragment.prototype.child = child
      }
      // Row 12,345 is never edited; its `beta` keeps its text.
      let from
      before.descendants((node, position) => {
        if (node.isText && node.text === lines[12345])
          from = position + node.text.indexOf('beta')
      })
      const mapped = map.map(from)
      assert.equal(after.textBetween(mapped, mapped + 4), 'beta')
      return total
    }
    const few = reads(100),
      many = reads(1000)
    // Linear in the document and the edits, never their product.
    assert.ok(many < few * 1.5, `${few} reads for 100 edits, ${many} for 1,000`)
    assert.ok(many < 5 * lines.length, String(many))
  }
})
