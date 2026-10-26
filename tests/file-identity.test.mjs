import assert from 'node:assert/strict'
import test from 'node:test'
import { sameFileIdentity } from '../src/shared/file-identity.ts'

test('file identity keeps device and inode ids exact above the safe integer range', () => {
  const first = { dev: 1152921504606846977n, ino: 1152921504606846977n }
  const nextInode = { ...first, ino: first.ino + 1n }
  const nextDevice = { ...first, dev: first.dev + 1n }
  assert.equal(Number(first.ino), Number(nextInode.ino))
  assert.equal(Number(first.dev), Number(nextDevice.dev))
  assert.equal(sameFileIdentity(first, { ...first }), true)
  assert.equal(sameFileIdentity(first, nextInode), false)
  assert.equal(sameFileIdentity(first, nextDevice), false)
})
