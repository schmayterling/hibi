import assert from 'node:assert/strict'
import test from 'node:test'
import { getSchema } from '@tiptap/core'
import { Image } from '@tiptap/extension-image'
import { TableKit } from '@tiptap/extension-table'
import { MarkdownManager } from '@tiptap/markdown'
import { AllSelection, NodeSelection, TextSelection } from '@tiptap/pm/state'
import { CellSelection } from '@tiptap/pm/tables'
import { StarterKit } from '@tiptap/starter-kit'
import { richChangeMap } from '../src/renderer/src/rich-change-map.ts'

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
