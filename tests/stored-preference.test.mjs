import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const { outputFiles } = await build({
  stdin: {
    contents: `
      export { editorPreferences } from './editor-preferences'
      export { tabIndent } from './indentation'
      export { autosave } from './autosave'
    `,
    resolveDir: resolve('src/renderer/src'),
  },
  bundle: true,
  format: 'cjs',
  packages: 'external',
  external: ['./EditorCursor', './document-runtime'],
  write: false,
})

function stores(storage) {
  const module = { exports: {} }
  const listeners = []
  runInNewContext(outputFiles[0].text, {
    module,
    localStorage: storage,
    addEventListener(type, listener) {
      assert.equal(type, 'storage')
      listeners.push(listener)
    },
    require(id) {
      if (id === './EditorCursor') return { loadCursor: () => ({}) }
      if (id === './document-runtime') return {}
      return require(id)
    },
  })
  return {
    ...module.exports,
    storageEvent: (key) => {
      for (const listener of listeners) listener({ key })
    },
  }
}

for (const [name, key, changed, defaults] of [
  [
    'tabIndent',
    'hibi:tab-indent',
    { enabled: false, unit: '  ' },
    { enabled: true, unit: '\t' },
  ],
  [
    'autosave',
    'hibi:autosave',
    { enabled: true, delay: 5000 },
    { enabled: false, delay: 2000 },
  ],
]) {
  test(`${name} refreshes another window on storage changes and clear`, () => {
    const values = new Map()
    const storage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    }
    const first = stores(storage)
    const second = stores(storage)
    const notifications = []
    const unsubscribe = second[name].subscribe(() =>
      notifications.push({ ...second[name].snapshot() }),
    )
    first[name].set(changed)
    assert.deepEqual({ ...first[name].snapshot() }, changed)
    assert.deepEqual({ ...second[name].snapshot() }, defaults)
    second.storageEvent('unrelated')
    assert.equal(notifications.length, 0)
    second.storageEvent(key)
    assert.deepEqual({ ...second[name].snapshot() }, changed)
    assert.deepEqual(notifications, [changed])
    second[name].set({ enabled: defaults.enabled })
    assert.deepEqual(
      { ...second[name].snapshot() },
      {
        ...changed,
        enabled: defaults.enabled,
      },
    )
    values.set(key, 'invalid json')
    second.storageEvent(key)
    assert.deepEqual({ ...second[name].snapshot() }, defaults)
    first[name].set(changed)
    first.editorPreferences.lineNumbers.set(true)
    second.storageEvent(key)
    second.storageEvent('line-numbers')
    assert.equal(second.editorPreferences.lineNumbers.get(), true)
    values.clear()
    second.storageEvent(null)
    assert.deepEqual({ ...second[name].snapshot() }, defaults)
    assert.equal(second.editorPreferences.lineNumbers.get(), false)
    assert.deepEqual(notifications.at(-1), defaults)
    unsubscribe()
    const count = notifications.length
    second.storageEvent(null)
    assert.equal(notifications.length, count)
  })
}
