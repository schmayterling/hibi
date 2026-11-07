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

test('markdown toolbar setup and inspection do not flatten the document', (t) => {
  const view = {
    state: EditorState.create({ doc: '# Heading\n\nordinary words' }),
  }
  const flatten = t.mock.method(view.state.doc, 'toString')
  const source = sourceFormatting(view)
  assert.equal(flatten.mock.callCount(), 0)
  assert.equal(source.inspect().state('heading-1').pressed, true)
  assert.equal(source.state('bold').pressed, false)
  assert.equal(flatten.mock.callCount(), 0)
})

for (const first of ['inspect', 'apply']) {
  test(`custom formatting materializes on first ${first} and refreshes only for a new document`, (t) => {
    const view = {
      state: EditorState.create({
        doc: 'hello\nworld🙂',
        selection: { anchor: 1, head: 4 },
      }),
    }
    const flatten = t.mock.method(view.state.doc, 'toString')
    const calls = []
    const source = sourceFormatting(view, {
      actions: ['probe'],
      isActive(_id, selection) {
        calls.push(selection)
        return false
      },
      apply(_id, selection) {
        calls.push(selection)
        return null
      },
    })
    assert.equal(flatten.mock.callCount(), 0)
    const values = { url: 'https://example.com/' }
    if (first === 'inspect') source.inspect().state('probe')
    else assert.equal(source.run('probe', values), false)
    assert.equal(flatten.mock.callCount(), 1)
    assert.deepEqual(calls[0], {
      source: 'hello\nworld🙂',
      from: 1,
      to: 4,
      values: first === 'apply' ? values : undefined,
    })

    const inspection = source.inspect()
    inspection.state('probe')
    inspection.state('probe')
    assert.notEqual(calls[1], calls[2])
    assert.deepEqual(calls[1], calls[2])
    assert.equal(source.run('probe', values), false)
    assert.equal(flatten.mock.callCount(), 1)
    assert.deepEqual(calls[3], {
      source: 'hello\nworld🙂',
      from: 1,
      to: 4,
      values,
    })

    view.state = view.state.update({ selection: { anchor: 6, head: 11 } }).state
    source.state('probe')
    assert.equal(flatten.mock.callCount(), 1)
    assert.deepEqual(calls[4], {
      source: 'hello\nworld🙂',
      from: 6,
      to: 11,
      values: undefined,
    })

    view.state = view.state.update({
      changes: { from: 0, to: 5, insert: 'goodbye' },
      selection: { anchor: 2, head: 6 },
    }).state
    const changed = t.mock.method(view.state.doc, 'toString')
    assert.equal(changed.mock.callCount(), 0)
    source.state('probe')
    assert.equal(source.run('probe', values), false)
    assert.equal(changed.mock.callCount(), 1)
    assert.equal(flatten.mock.callCount(), 1)
    assert.deepEqual(calls[5], {
      source: 'goodbye\nworld🙂',
      from: 2,
      to: 6,
      values: undefined,
    })
    assert.deepEqual(calls[6], { ...calls[5], values })
  })
}
