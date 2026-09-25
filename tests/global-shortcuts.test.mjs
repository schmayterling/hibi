import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { GlobalShortcuts } from '../src/main/global-shortcuts.ts'
import { electron } from './electron.mjs'

test('global shortcut ownership survives replacement and stale callbacks', () => {
  const bindings = new Map()
  const system = {
    register(accelerator, callback) {
      if (accelerator === 'Control+Alt+F10' || bindings.has(accelerator))
        return false
      bindings.set(accelerator, callback)
      return true
    },
    unregister(accelerator) {
      bindings.delete(accelerator)
    },
  }
  const shortcuts = new GlobalShortcuts(system, 'linux')
  const invoked = []
  const invoke = (value) => invoked.push(value)
  shortcuts.register('test.one', 'Control+Alt+F9', 'first', invoke)
  const oldCallback = bindings.get('Control+Alt+F9')
  shortcuts.register('test.one', 'Control+Alt+F9', 'second', invoke)
  assert.equal(shortcuts.unregister('test.one', 'first'), false)
  oldCallback()
  assert.deepEqual(invoked, [{ id: 'test.one', token: 'second' }])
  assert.throws(
    () => shortcuts.register('test.one', 'Control+Alt+F10', 'third', invoke),
    /already in use or was denied/,
  )
  assert.equal(shortcuts.get('test.one').token, 'second')
  shortcuts.register('test.one', 'Control+Alt+Plus', 'fourth', invoke)
  oldCallback()
  assert.deepEqual(invoked, [{ id: 'test.one', token: 'second' }])
  bindings.get('Control+Alt+Plus')()
  assert.deepEqual(invoked.at(-1), { id: 'test.one', token: 'fourth' })
  shortcuts.clear()
  assert.equal(bindings.size, 0)
})

test('global shortcut validation accepts Electron keys and rejects malformed input', () => {
  const shortcuts = new GlobalShortcuts(
    { register: () => true, unregister: () => {} },
    'linux',
  )
  shortcuts.register('test.one', 'AltGr+F24', 'first', () => {})
  assert.throws(
    () => shortcuts.register('test.two', 'Shift+A', 'second', () => {}),
    /modifier and key/,
  )
  assert.throws(
    () => shortcuts.register('test.two', 'Command+F9', 'second', () => {}),
    /not supported/,
  )
  assert.throws(
    () => shortcuts.register('test.two', 'Control+Alt+', 'second', () => {}),
    /modifier and key/,
  )
})

test('global shortcut registration rejects conflicts and releases keys', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-global-shortcut-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await page.locator('.titlebar').waitFor()
  const shortcut = 'Control+Alt+Shift+F9'
  await assert.rejects(
    page.evaluate(() => window.hibi.registerGlobalShortcut('bad', 'A', 'bad')),
    /modifier and key/,
  )
  await assert.rejects(
    page.evaluate(() =>
      window.hibi.registerGlobalShortcut('test.shift', 'Shift+A', 'shift'),
    ),
    /modifier and key/,
  )
  await page.evaluate(
    (value) => window.hibi.registerGlobalShortcut('test.one', value, 'first'),
    shortcut,
  )
  assert.equal(
    await app.evaluate(
      ({ globalShortcut }, value) => globalShortcut.isRegistered(value),
      shortcut,
    ),
    true,
  )
  await assert.rejects(
    page.evaluate(
      (value) =>
        window.hibi.registerGlobalShortcut('test.two', value, 'second'),
      shortcut,
    ),
    /already in use/,
  )
  await page.evaluate(() =>
    window.hibi.registerGlobalShortcut(
      'test.one',
      'Control+Alt+Shift+F9',
      'replacement',
    ),
  )
  await page.evaluate(() =>
    window.hibi.unregisterGlobalShortcut('test.one', 'first'),
  )
  assert.equal(
    await app.evaluate(
      ({ globalShortcut }, value) => globalShortcut.isRegistered(value),
      shortcut,
    ),
    true,
  )
  await page.evaluate(() =>
    window.hibi.unregisterGlobalShortcut('test.one', 'replacement'),
  )
  assert.equal(
    await app.evaluate(
      ({ globalShortcut }, value) => globalShortcut.isRegistered(value),
      shortcut,
    ),
    false,
  )
})
