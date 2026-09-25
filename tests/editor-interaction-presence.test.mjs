import assert from 'node:assert/strict'
import test from 'node:test'
import {
  countEditorInteractionProvider,
  hasEditorInteractionProviders,
  onEditorInteractionProvidersChanged,
} from '../src/renderer/src/editor-interaction-presence.ts'

test('interaction UI activates for first provider and detaches after last', () => {
  const states = []
  const unsubscribe = onEditorInteractionProvidersChanged(() => {
    states.push(hasEditorInteractionProviders())
  })
  const first = countEditorInteractionProvider()
  const second = countEditorInteractionProvider()
  first()
  assert.equal(hasEditorInteractionProviders(), true)
  second()
  second()
  unsubscribe()
  assert.deepEqual(states, [true, false])
  assert.equal(hasEditorInteractionProviders(), false)
})
