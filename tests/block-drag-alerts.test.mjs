import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import {
  blockStep,
  dropSibling,
  handleTarget,
  moveBlock,
  selectionStep,
} from '../src/addons/block-drag/formatted.ts'
import { formattedSyntax } from '../src/renderer/src/formatted-syntax.ts'
import { GithubAlerts } from '../src/shared/markdown-extra-syntax.ts'

const doc = '> [!NOTE]\n> first body\n>\n> second body\n\nafter\n'
const view = (anchor = 0) => {
  const syntax = formattedSyntax({ extensions: [GithubAlerts], slice: 1000 })
  const state = EditorState.create({
    doc,
    selection: { anchor },
    extensions: syntax.extension,
  })
  const tree = syntax.tree(state)
  const title = tree.topNode.firstChild.getChild('AlertTitle')
  const first = title.parent.getChildren('Paragraph')[0]
  const second = title.parent.getChildren('Paragraph')[1]
  return { state, tree, title, first, second }
}
test('an alert title is fixed and its handle targets the whole alert', () => {
  const { state, tree, title, first, second } = view()
  assert.equal(
    handleTarget(tree, title.from + 2, () => false)?.name,
    'Blockquote',
  )
  assert.equal(blockStep(state, tree, title, 1), null)
  assert.equal(blockStep(state, tree, first, -1), null)
  assert.equal(moveBlock(state, tree, first, title, false), null)
  assert.equal(moveBlock(state, tree, second, title, false), null)
  assert.equal(moveBlock(state, tree, title, second, true), null)
})
test('body blocks still reorder below the title; title commands move the whole alert', () => {
  const { state, tree, first, second } = view(doc.indexOf('[!NOTE]'))
  const body = blockStep(state, tree, first, 1)
  assert.ok(body)
  assert.equal(
    state.update(body).state.doc.toString(),
    '> [!NOTE]\n>\n> second body\n>\n> first body\n\nafter\n',
  )
  const near = dropSibling(tree, second, doc.indexOf('[!NOTE]'))
  assert.equal(near.name, 'AlertTitle')
  assert.equal(
    state
      .update(moveBlock(state, tree, second, near, true))
      .state.doc.toString(),
    state.update(body).state.doc.toString(),
  )
  const whole = selectionStep(state, tree, 1)
  assert.ok(whole)
  assert.equal(
    state.update(whole).state.doc.toString(),
    'after\n\n> [!NOTE]\n> first body\n>\n> second body\n',
  )
})
