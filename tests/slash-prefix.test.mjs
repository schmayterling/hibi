import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import { Text } from '@codemirror/state'
import { Schema } from '@tiptap/pm/model'
import {
  maximumSlashQueryUnits,
  slashQuery,
} from '../src/addons/slash-commands/commands.ts'

async function load(file, name, bindings) {
  const source = stripTypeScriptTypes(
    await readFile(
      new URL(`../src/addons/slash-commands/${file}.ts`, import.meta.url),
      'utf8',
    ),
    { mode: 'transform' },
  )
    .replace(/^import .* from .*$/gm, '')
    .replace(/^export /gm, '')
  return new Function(...Object.keys(bindings), `${source}\nreturn ${name}`)(
    ...Object.values(bindings),
  )
}
const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'inline*' },
    box: { inline: true, group: 'inline', content: 'inline*' },
    text: { group: 'inline' },
  },
  marks: { strong: {}, em: {} },
})
const astral = '\u{10400}'.repeat(48)

// Run the actual plugin update and its frame callback against native PM nodes.
async function richPrefix(content) {
  let frame,
    pluginView,
    reads = 0,
    units = 0,
    childReads = 0
  const updates = []
  const paragraph = schema.nodes.paragraph.create(null, content)
  const document = schema.nodes.doc.create(null, paragraph)
  const position = document.resolve(paragraph.nodeSize - 1)
  const parent = position.parent
  const track = (node) => {
    if (node.isText) return
    const child = node.child.bind(node)
    node.child = (index) => {
      childReads++
      return child(index)
    }
    node.forEach(track)
  }
  track(parent)
  const read = parent.textBetween.bind(parent)
  parent.textBetween = (from, to, ...args) => {
    reads++
    units += to - from
    return read(from, to, ...args)
  }
  const view = {
    editable: true,
    hasFocus: () => true,
    state: { selection: { empty: true, $from: position } },
    coordsAtPos: () => ({ left: 0, right: 0, top: 0, bottom: 0 }),
  }
  const attach = await load('rich', 'attachRich', {
    Plugin: class {
      constructor(spec) {
        this.spec = spec
      }
    },
    PluginKey: class {},
    slashQuery,
    maximumSlashQueryUnits,
    createSlashMenu: () => ({
      observe() {},
      update: (value) => updates.push(value?.query ?? null),
      destroy() {},
    }),
    requestAnimationFrame: (callback) => {
      frame = callback
      return 1
    },
    cancelAnimationFrame() {},
  })
  const stop = attach(
    {
      registerPlugin(plugin) {
        pluginView = plugin.spec.view(view)
      },
      unregisterPlugin() {
        pluginView.destroy()
      },
    },
    {},
  )
  reads = units = childReads = 0
  updates.length = 0
  pluginView.update()
  frame()
  stop()
  return { reads, units, childReads, query: updates.at(-1) }
}

test('rich updates skip impossible long text prefixes and preserve Unicode and inline containers', async () => {
  assert.deepEqual(await richPrefix(schema.text('x'.repeat(100_000))), {
    reads: 0,
    units: 0,
    childReads: 2,
    query: null,
  })
  assert.equal(`/${astral}`.length, maximumSlashQueryUnits)
  assert.equal((await richPrefix(schema.text(`/${astral}`))).query, astral)
  assert.equal((await richPrefix(schema.text(`/${astral}\u{10400}`))).reads, 0)
  const wrapped = schema.nodes.box.create(
    null,
    schema.nodes.box.create(null, schema.text(`/${astral}`)),
  )
  assert.equal((await richPrefix(wrapped)).query, astral)
})

test('rich prefix checks stop early across marked spans and inline containers', async () => {
  const bold = schema.marks.strong.create()
  const italic = schema.marks.em.create()
  const alternating = [
    schema.text('/'),
    ...Array.from({ length: 5000 }, (_, index) =>
      schema.text('a', [index % 2 ? bold : italic]),
    ),
  ]
  for (const content of [
    [schema.text('a'.repeat(100_000), [bold]), schema.text('b')],
    alternating,
    schema.nodes.box.create(null, alternating),
  ]) {
    const result = await richPrefix(content)
    assert.equal(result.query, null)
    assert.equal(result.reads, 0)
    assert.equal(result.units, 0)
    assert.ok(result.childReads > 0)
    assert.ok(result.childReads <= 2 * (maximumSlashQueryUnits + 2))
  }
})

test('source reads only a possible slash prefix, even near the start of a long line', async () => {
  const ranges = []
  const current = await load('source', 'current', {
    EditorView: { editable: Symbol('editable') },
    syntaxTree: () => ({ resolveInner: () => null }),
    slashQuery,
    maximumSlashQueryUnits,
  })
  const match = (source, head = source.length) => {
    ranges.length = 0
    const text = Text.of([source])
    return current({
      hasFocus: true,
      scrollDOM: { classList: { contains: () => false } },
      state: {
        readOnly: false,
        facet: () => true,
        selection: { main: { head, empty: true }, ranges: [{}] },
        doc: {
          lineAt: () => ({
            from: 0,
            get text() {
              throw new Error('must not read the full line')
            },
          }),
          sliceString: (from, to) => {
            ranges.push([from, to])
            return text.sliceString(from, to)
          },
        },
      },
    })
  }
  assert.equal(match('x'.repeat(100_000)), null)
  assert.deepEqual(ranges, [])
  assert.equal(match(`/a${'x'.repeat(100_000)}`, 2).query, 'a')
  assert.deepEqual(ranges, [
    [0, 2],
    [0, 4],
  ])
  assert.equal(match(`/${astral}`).query, astral)
  assert.deepEqual(ranges, [
    [0, maximumSlashQueryUnits],
    [0, 4],
  ])
  assert.equal(match(`/${astral}\u{10400}`), null)
  assert.deepEqual(ranges, [])
})
