import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'

setFlagsFromString('--expose-gc')
const gc = runInNewContext('gc')
// The renderer's bundler resolves its extensionless imports.
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context)
    } catch (error) {
      if (!specifier.startsWith('.') || error.code !== 'ERR_MODULE_NOT_FOUND')
        throw error
      return next(`${specifier}.ts`, context)
    }
  },
})
globalThis.window ??= { addEventListener() {} }
const { toolbar } = await import('../src/renderer/src/toolbar.ts')

/** A toolbar owner whose callbacks hold its state, as an editor's do. */
function mount() {
  const state = { source: 'x'.repeat(1024 * 1024) }
  const scope = toolbar.scope('retention', () => state.source)
  scope.api.register({
    id: 'probe',
    label: 'Probe',
    onClick: () => state.source.length,
  })
  return { scope, released: new WeakRef(state) }
}

test('entries rendered buttons still hold release a disposed owner', async () => {
  const { scope, released } = mount()
  // A rendered button keeps the entry it last rendered after the owner goes.
  const entry = toolbar
    .snapshot()
    .items.find((item) => item.id === 'retention.probe')
  assert.ok(entry)
  scope.dispose()
  assert.equal(
    toolbar.snapshot().items.some((item) => item.id === 'retention.probe'),
    false,
  )
  for (let attempt = 0; attempt < 5 && released.deref(); attempt++) {
    await new Promise((resolve) => setImmediate(resolve))
    gc()
  }
  assert.equal(released.deref(), undefined)
  // A click on the stale button does nothing.
  await entry.onClick()
})
