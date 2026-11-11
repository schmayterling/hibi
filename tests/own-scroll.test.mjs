import assert from 'node:assert/strict'
import test from 'node:test'
import {
  foreignScroll,
  inOwnScroll,
  ownScroll,
} from '../src/renderer/src/own-scroll.ts'

test('a correction that throws leaves no write counted as its own', () => {
  assert.throws(
    () =>
      ownScroll(() => {
        assert.equal(inOwnScroll(), true)
        throw new Error('measure failed')
      }),
    /measure failed/,
  )
  assert.equal(inOwnScroll(), false)
})

test("code handed to hibi runs as not hibi's own, then hibi's own again", () => {
  ownScroll(() => {
    assert.throws(
      () =>
        foreignScroll(() => {
          assert.equal(inOwnScroll(), false)
          throw new Error('addon failed')
        }),
      /addon failed/,
    )
    assert.equal(inOwnScroll(), true)
  })
  assert.equal(inOwnScroll(), false)
})
