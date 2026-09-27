import assert from 'node:assert/strict'
import test from 'node:test'
import { GlobalShortcuts } from '../src/main/global-shortcuts.ts'
import { createAddonGlobalShortcuts } from '../src/renderer/src/addon-global-shortcuts.ts'

function shortcutHarness() {
  const bindings = new Map()
  const listeners = new Set()
  const shortcuts = new GlobalShortcuts(
    {
      register(accelerator, callback) {
        if (accelerator === 'Control+Alt+F10' || bindings.has(accelerator))
          return false
        bindings.set(accelerator, callback)
        return true
      },
      unregister(accelerator) {
        bindings.delete(accelerator)
      },
    },
    'linux',
  )
  const transport = {
    async registerGlobalShortcut(id, accelerator, token) {
      shortcuts.register(id, accelerator, token, (invocation) => {
        for (const listener of listeners) listener(invocation)
      })
    },
    async unregisterGlobalShortcut(id, token) {
      shortcuts.unregister(id, token)
    },
    onGlobalShortcut(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return { bindings, listeners, shortcuts, transport }
}

test('failed replacement retains old shortcut and successful replacement retires old disposer', async () => {
  const { bindings, shortcuts, transport } = shortcutHarness()
  let releasePending
  const gate = new Promise((resolve) => {
    releasePending = resolve
  })
  const register = transport.registerGlobalShortcut
  transport.registerGlobalShortcut = async (id, accelerator, token) => {
    if (accelerator === 'Control+Alt+F10') await gate
    return register(id, accelerator, token)
  }
  const invoked = []
  const scope = createAddonGlobalShortcuts(
    'example',
    transport,
    (command) => invoked.push(command),
    assert.fail,
  )
  const removeOld = await scope.register('capture', 'Control+Alt+F9', 'old')
  const replacing = scope.register('capture', 'Control+Alt+F10', 'denied')
  bindings.get('Control+Alt+F9')()
  assert.deepEqual(invoked, ['old'])
  releasePending()
  await assert.rejects(replacing, /already in use or was denied/)
  bindings.get('Control+Alt+F9')()
  assert.deepEqual(invoked, ['old', 'old'])

  const removeNext = await scope.register('capture', 'Control+Alt+F11', 'new')
  assert.equal(bindings.has('Control+Alt+F9'), false)
  assert.equal(bindings.has('Control+Alt+F11'), true)
  removeOld()
  assert.equal(shortcuts.get('example.capture')?.accelerator, 'Control+Alt+F11')
  bindings.get('Control+Alt+F11')()
  assert.deepEqual(invoked, ['old', 'old', 'new'])
  removeNext()
  assert.equal(bindings.size, 0)
})

test('dispose releases active shortcut and a successful late replacement', async () => {
  const { bindings, listeners, transport } = shortcutHarness()
  let releasePending
  const gate = new Promise((resolve) => {
    releasePending = resolve
  })
  const register = transport.registerGlobalShortcut
  transport.registerGlobalShortcut = async (id, accelerator, token) => {
    if (accelerator === 'Control+Alt+F11') await gate
    return register(id, accelerator, token)
  }
  const scope = createAddonGlobalShortcuts(
    'example',
    transport,
    assert.fail,
    assert.fail,
  )
  await scope.register('capture', 'Control+Alt+F9', 'old')
  const replacing = scope.register('capture', 'Control+Alt+F11', 'new')
  scope.dispose()
  assert.equal(bindings.size, 0)
  assert.equal(listeners.size, 0)
  releasePending()
  await replacing
  assert.equal(bindings.size, 0)
})

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
