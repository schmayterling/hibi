import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { sourceFormatting } from '../src/renderer/src/source-formatting.ts'

test('source toolbar inspection checks each supported active action once', () => {
  const calls = []
  const source = sourceFormatting(
    { state: EditorState.create({ doc: 'hello world' }) },
    {
      actions: ['bold', 'italic'],
      apply: () => null,
      isActive(id, selection) {
        calls.push({ id, selection })
        return id === 'bold'
      },
    },
  )
  const inspection = source.inspect()

  assert.deepEqual(inspection.state('bold', true), {
    supported: true,
    pressed: true,
    disabled: false,
  })
  assert.equal(inspection.state('italic', true).pressed, false)
  assert.equal(inspection.state('undo', false).pressed, false)
  assert.deepEqual(inspection.state('heading-1', true), {
    supported: false,
    pressed: false,
    disabled: true,
  })
  assert.deepEqual(
    calls.map(({ id }) => id),
    ['bold', 'italic'],
  )
  assert.notEqual(calls[0].selection, calls[1].selection)
  assert.deepEqual(calls[0].selection, calls[1].selection)
})
