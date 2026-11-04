import assert from 'node:assert/strict'
import test from 'node:test'
import { errorMessage } from '../src/shared/errors.ts'

test('errorMessage takes anything an addon can throw and stays short', () => {
  assert.equal(errorMessage(new Error('Error: boom')), 'boom')
  assert.equal(errorMessage('text'), 'text')
  assert.equal(errorMessage(undefined), 'undefined')
  for (const thrown of [
    Object.create(null),
    {
      toString() {
        throw new Error('no text')
      },
    },
    Object.defineProperty(new Error(), 'message', {
      get() {
        throw new Error('no text')
      },
    }),
  ])
    assert.equal(errorMessage(thrown), 'The error could not be read.')
  assert.equal(errorMessage(new Error('x'.repeat(20000))).length, 501)
})
