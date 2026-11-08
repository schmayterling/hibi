import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'
import { fixtureVault } from './obsidian/harness.mjs'

test('obsidian lane registrations are scoped and reject non-shared imports', async (t) => {
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true },
    appType: 'custom',
  })
  t.after(() => server.close())
  const registry = await server.ssrLoadModule(
    '/src/addons/obsidian/api/registry.ts',
  )
  const callbacks = []
  const app = { vault: {}, metadataCache: {}, workspace: {}, fileManager: {} }
  const vault = { fixture: true }
  const remove = registry.registerObsidianApi({
    id: 'fixture-vault',
    create: () => ({
      app: { vault },
      exports: { Fixture: class {} },
      dispose: () => callbacks.push('disposed'),
    }),
  })
  t.after(remove)
  const dispose = []
  const contributions = await registry.createObsidianContributions({
    app,
    hibi: {},
    register: (fn) => dispose.push(fn),
  })
  assert.equal(app.vault, vault)
  assert.equal(typeof contributions[0].exports.Fixture, 'function')
  assert.throws(
    () => registry.registerObsidianApi({ id: 'fixture-vault' }),
    /already registered/,
  )
  for (const name of [
    'fs',
    'node:fs',
    'electron',
    'path',
    '@codemirror/state/private',
  ])
    assert.throws(
      () => registry.registerObsidianHostModule(name, {}),
      /Unsupported/,
    )
  const shared = {}
  const unshare = registry.registerObsidianHostModule(
    '@codemirror/state',
    shared,
  )
  assert.equal(registry.requireObsidianHostModule('@codemirror/state'), shared)
  unshare()
  assert.throws(
    () => registry.requireObsidianHostModule('@codemirror/state'),
    /Unsupported/,
  )
  for (const fn of dispose) fn()
  assert.deepEqual(callbacks, ['disposed'])
})

test('component unload removes events, children and intervals exactly once even after an error', async (t) => {
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true },
    appType: 'custom',
  })
  t.after(() => server.close())
  const { Component } = await server.ssrLoadModule(
    '/src/addons/obsidian/api/core/component.ts',
  )
  const { Events } = await server.ssrLoadModule(
    '/src/addons/obsidian/api/core/events.ts',
  )
  const parent = new Component()
  const child = new Component()
  const calls = []
  parent.addChild(child)
  parent.register(() => calls.push('parent'))
  child.register(() => {
    calls.push('child')
    throw new Error('cleanup failure')
  })
  const emitter = new Events()
  parent.registerEvent(emitter.on('tick', () => calls.push('tick')))
  const target = new EventTarget()
  parent.registerDomEvent(target, 'click', () => calls.push('click'))
  let ticks = 0
  const interval = setInterval(() => ticks++, 1)
  parent.registerInterval(interval)
  await parent.loadAsync()
  emitter.trigger('tick')
  target.dispatchEvent(new Event('click'))
  assert.throws(() => parent.unload(), /teardown failed/)
  parent.unload()
  emitter.trigger('tick')
  target.dispatchEvent(new Event('click'))
  const before = ticks
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(ticks, before)
  assert.deepEqual(calls, ['tick', 'click', 'child', 'parent'])
  parent.register(() => calls.push('late cleanup'))
  assert.equal(calls.at(-1), 'late cleanup')
})

test('fixture harness keeps source vault byte-identical', async (t) => {
  const fixture = await fixtureVault(t)
  assert.equal(fixture.plugin.manifest.isDesktopOnly, false)
  assert.match(fixture.plugin.main, /require\('obsidian'\)/)
  await fixture.assertUnchanged()
})
