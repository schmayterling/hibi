import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'

const source = stripTypeScriptTypes(
  await readFile(
    new URL('../src/main/window-creation.ts', import.meta.url),
    'utf8',
  ),
)
  .replace(/^import[\s\S]*?from 'electron'\n/, '')
  .replace('export function', 'function')

function fixture(platform = 'darwin') {
  const app = new EventEmitter()
  const pending = []
  let quits = 0
  app.quit = () => {
    quits++
  }
  class BrowserWindow {
    constructor(options) {
      options.construct?.()
    }
  }
  const create = new Function(
    'app',
    'BrowserWindow',
    'process',
    'setImmediate',
    `${source}; return createBrowserWindow`,
  )(app, BrowserWindow, { platform }, (callback) => pending.push(callback))
  return { app, create, pending, quits: () => quits }
}

const requestQuit = (app) => {
  let prevented = false
  app.emit('before-quit', {
    preventDefault() {
      prevented = true
    },
  })
  return prevented
}

test('mac quit waits for every nested window constructor and queues one retry', () => {
  const { app, create, pending, quits } = fixture()
  create({
    construct() {
      create({
        construct() {
          assert.equal(requestQuit(app), true)
          assert.equal(requestQuit(app), true)
        },
      })
      assert.equal(requestQuit(app), true)
    },
  })
  assert.equal(pending.length, 1)
  assert.equal(quits(), 0)
  pending.shift()()
  assert.equal(quits(), 1)
  assert.equal(requestQuit(app), false)
})

test('a failed constructor releases the quit guard', () => {
  const { app, create, pending } = fixture()
  assert.throws(
    () =>
      create({
        construct() {
          throw new Error('constructor failed')
        },
      }),
    /constructor failed/,
  )
  assert.equal(requestQuit(app), false)
  assert.equal(pending.length, 0)
})

test('other platforms keep their existing quit behavior during construction', () => {
  for (const platform of ['linux', 'win32']) {
    const { app, create, pending } = fixture(platform)
    create({
      construct() {
        assert.equal(requestQuit(app), false)
      },
    })
    assert.equal(pending.length, 0)
  }
})
