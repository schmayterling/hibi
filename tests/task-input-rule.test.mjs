import assert from 'node:assert/strict'
import test from 'node:test'
import { getExtensionField, getSchema, inputRulesPlugin } from '@tiptap/core'
import { BulletList, TaskItem, TaskList } from '@tiptap/extension-list'
import { MarkdownManager } from '@tiptap/markdown'
import { history, redo, undo } from '@tiptap/pm/history'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { markdownConfiguration } from '../src/renderer/src/markdown.ts'

function fixture(source = '', selected = '', taskOptions = {}) {
  const { core, addons, parser, options } = markdownConfiguration([
    {
      id: 'markdown.github',
      markedOptions: { gfm: true },
      richExtensions: [
        TaskList,
        TaskItem.configure({ nested: true, ...taskOptions }),
      ],
    },
  ])
  const extensions = [...core, ...addons]
  const schema = getSchema(extensions)
  const manager = new MarkdownManager({
    extensions,
    marked: parser,
    markedOptions: options,
  })
  const doc = source
    ? schema.nodeFromJSON(manager.parse(source))
    : schema.node('doc', null, [schema.node('paragraph')])
  let selection
  doc.descendants((node, pos) => {
    if (node.isTextblock && node.textContent === selected)
      selection = TextSelection.create(
        doc,
        pos + 1,
        pos + 1 + node.content.size,
      )
  })
  assert.ok(selection, 'The selected text block must exist.')
  const view = {
    state: EditorState.create({ schema, doc, selection }),
    composing: false,
    dispatch(tr) {
      this.state = this.state.apply(tr)
    },
  }
  const editor = { view, extensionManager: { commands: {} } }
  const rules = [
    BulletList,
    addons.find((item) => item.name === 'taskItem'),
  ].flatMap((extension) =>
    getExtensionField(extension, 'addInputRules', {
      type: schema.nodes[extension.name],
      options: extension.options,
    })(),
  )
  const plugin = inputRulesPlugin({ editor, rules })
  view.state = view.state.reconfigure({ plugins: [history(), plugin] })
  const type = (text) => {
    for (const character of text) {
      const { from, to } = view.state.selection
      if (!plugin.props.handleTextInput(view, from, to, character))
        view.dispatch(view.state.tr.insertText(character, from, to))
    }
  }
  return { view, type }
}

test('typing a Markdown task marker converts the native bullet input rule result', () => {
  for (const [marker, checked] of [
    ['- [ ] ', false],
    ['+ [x] ', true],
    ['* [ ] ', false],
  ]) {
    const { view, type } = fixture()
    type(`${marker}task`)
    assert.equal(view.state.doc.firstChild.type.name, 'taskList')
    const item = view.state.doc.firstChild.firstChild
    assert.equal(item.type.name, 'taskItem')
    assert.equal(item.attrs.checked, checked)
    assert.equal(item.textContent, 'task')
  }
})

test('typing a task splits only that bullet and preserves siblings and nested content', () => {
  const { view, type } = fixture(
    '- before\n- target\n  - child\n- after',
    'target',
  )
  type('[x] task')
  const doc = view.state.doc
  assert.deepEqual(
    Array.from(
      { length: doc.childCount },
      (_, index) => doc.child(index).type.name,
    ),
    ['bulletList', 'taskList', 'bulletList'],
  )
  assert.equal(doc.child(0).textContent, 'before')
  assert.equal(doc.child(2).textContent, 'after')
  const task = doc.child(1).firstChild
  assert.equal(task.attrs.checked, true)
  assert.equal(task.firstChild.textContent, 'task')
  assert.equal(task.child(1).type.name, 'bulletList')
  assert.equal(task.child(1).textContent, 'child')
})

test('nested task input keeps its parent and joins adjacent task lists', () => {
  const nested = fixture('- parent\n  - target', 'target')
  nested.type('[ ] task')
  const parent = nested.view.state.doc.firstChild.firstChild
  assert.equal(parent.firstChild.textContent, 'parent')
  assert.equal(parent.child(1).type.name, 'taskList')
  assert.equal(parent.child(1).textContent, 'task')
  const adjacent = fixture('- [ ] before\n\nplain', 'plain')
  adjacent.type('- [ ] after')
  assert.equal(adjacent.view.state.doc.childCount, 1)
  assert.equal(adjacent.view.state.doc.firstChild.childCount, 2)
})

test('missing task-list schema keeps native input behavior', () => {
  const { view, type } = fixture('', '', { taskListTypeName: 'missing' })
  type('- [ ] task')
  assert.equal(view.state.doc.firstChild.type.name, 'bulletList')
  assert.equal(view.state.doc.textContent, '[ ] task')
})

test('task conversion is one undo step and does not convert ordered lists or code', () => {
  const { view, type } = fixture()
  type('- [ ] ')
  assert.equal(view.state.doc.firstChild.type.name, 'taskList')
  assert.ok(undo(view.state, (tr) => view.dispatch(tr)))
  assert.equal(view.state.doc.firstChild.type.name, 'bulletList')
  assert.equal(view.state.doc.textContent, '[ ] ')
  assert.ok(redo(view.state, (tr) => view.dispatch(tr)))
  assert.equal(view.state.doc.firstChild.type.name, 'taskList')
  for (const source of ['1. target', '```\ntarget\n```']) {
    const other = fixture(source, 'target')
    const original = other.view.state.doc.firstChild.type.name
    other.type('[ ] task')
    assert.equal(other.view.state.doc.firstChild.type.name, original)
    assert.equal(other.view.state.doc.textContent, '[ ] task')
  }
})
