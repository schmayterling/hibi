import assert from 'node:assert/strict'
import test from 'node:test'
import { createAddonGlobalShortcuts } from '../src/renderer/src/addon-global-shortcuts.ts'

test('pending registration and old disposer cannot remove a replacement', async () => {
  let releaseFirst
  const firstReply = new Promise((resolve) => {
    releaseFirst = resolve
  })
  const listeners = new Set()
  let current = null
  let first = true
  const transport = {
    async registerGlobalShortcut(id, accelerator, token) {
      current = { id, accelerator, token }
      if (first) {
        first = false
        await firstReply
      }
    },
    async unregisterGlobalShortcut(id, token) {
      if (current?.id === id && current.token === token) current = null
    },
    onGlobalShortcut(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const invoked = []
  const old = createAddonGlobalShortcuts(
    'example',
    transport,
    (command) => invoked.push(command),
    assert.fail,
  )
  const pending = old.register('capture', 'CommandOrControl+Alt+N', 'capture')
  await assert.rejects(
    old.register('capture', 'CommandOrControl+Alt+M', 'capture'),
    /already registered/,
  )
  const oldToken = current.token
  old.dispose()

  const next = createAddonGlobalShortcuts(
    'example',
    transport,
    (command) => invoked.push(command),
    assert.fail,
  )
  const removeNext = await next.register(
    'capture',
    'CommandOrControl+Alt+N',
    'capture',
  )
  const nextToken = current.token
  assert.notEqual(nextToken, oldToken)
  releaseFirst()
  const removeOld = await pending
  removeOld()
  assert.equal(current.token, nextToken)

  for (const listener of listeners) {
    listener({ id: 'example.capture', token: oldToken })
    listener({ id: 'example.capture', token: nextToken })
  }
  assert.deepEqual(invoked, ['capture'])
  removeNext()
  assert.equal(current, null)
})

test('callback registration used by existing addons remains owned', async () => {
  let listener
  let currentToken
  let calls = 0
  const transport = {
    async registerGlobalShortcut(_id, _accelerator, token) {
      currentToken = token
    },
    async unregisterGlobalShortcut(_id, token) {
      if (currentToken === token) currentToken = undefined
    },
    onGlobalShortcut(callback) {
      listener = callback
      return () => {
        listener = undefined
      }
    },
  }
  const scope = createAddonGlobalShortcuts(
    'quick-note',
    transport,
    (command) => command(),
    assert.fail,
  )
  const remove = await scope.register(
    'capture',
    'CommandOrControl+Alt+N',
    () => {
      calls += 1
    },
  )
  listener({ id: 'quick-note.capture', token: currentToken })
  assert.equal(calls, 1)
  remove()
  assert.equal(currentToken, undefined)
  assert.equal(listener, undefined)
})
