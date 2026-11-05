import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { parse } from '@babel/parser'

const source = await readFile('scripts/dev.mjs', 'utf8')
const body = parse(source, { sourceType: 'module' })
  .program.body.filter((node) => node.type !== 'ImportDeclaration')
  .map((node) => source.slice(node.start, node.end))
  .join('\n')
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
const launch = new AsyncFunction(
  'fork',
  'spawn',
  'resolve',
  'electronEnvironment',
  'process',
  'console',
  body,
)

function fixture(t, spawnError) {
  const environment = Promise.withResolvers()
  const calls = []
  const errors = []
  const failures = []
  const runtime = Object.assign(new EventEmitter(), {
    execPath: process.execPath,
    argv: ['node', 'scripts/dev.mjs', '--fixture-argument'],
  })
  function child(kind, file, args, options) {
    if (kind === 'desktop' && spawnError) throw spawnError
    const child = Object.assign(new EventEmitter(), {
      kills: 0,
      kill() {
        this.kills++
      },
    })
    calls.push({ kind, file, args, options, child })
    return child
  }
  const operation = launch(
    (...args) => child('site', ...args),
    (file, args, options) =>
      child(
        args.includes('--watch-preserve-output') ? 'docs' : 'desktop',
        file,
        args,
        options,
      ),
    resolve,
    () => environment.promise,
    runtime,
    { error: (error) => errors.push(error) },
  ).catch((error) => failures.push(error))
  t.after(async () => {
    environment.resolve({})
    await nextTurn()
    await operation
  })
  return { environment, calls, errors, failures, runtime }
}

for (const first of ['runtime', 'site']) {
  test(`development launcher overlaps preparation with site readiness: ${first} first`, async (t) => {
    const state = fixture(t)
    assert.deepEqual(
      state.calls.map((call) => call.kind),
      ['site', 'docs'],
    )
    const site = state.calls[0].child
    const env = { ELECTRON_EXEC_PATH: '/owned/hibi.app/Electron' }
    site.emit('message', { unrelated: true })
    if (first === 'runtime') state.environment.resolve(env)
    else {
      site.emit('message', { ready: true })
      site.emit('message', { ready: true })
    }
    await nextTurn()
    assert.equal(
      state.calls.length,
      2,
      'desktop still waits for the other dependency',
    )
    if (first === 'runtime') site.emit('message', { ready: true })
    else state.environment.resolve(env)
    await nextTurn()
    site.emit('message', { ready: true })
    await nextTurn()
    assert.deepEqual(
      state.calls.map((call) => call.kind),
      ['site', 'docs', 'desktop'],
    )
    const desktop = state.calls[2]
    assert.equal(desktop.file, process.execPath)
    assert.deepEqual(desktop.args, [
      resolve('node_modules/electron-vite/bin/electron-vite.js'),
      'dev',
      '--watch',
      '--fixture-argument',
    ])
    assert.deepEqual(desktop.options, { stdio: 'inherit', env })
    desktop.child.emit('exit', 7)
    assert.equal(state.runtime.exitCode, 7)
    assert.ok(state.calls.every((call) => call.child.kills === 1))
    assert.deepEqual(state.errors, [])
    assert.deepEqual(state.failures, [])
  })
}

test('development runtime rejection stops children before or after site readiness', async (t) => {
  for (const ready of [false, true]) {
    const state = fixture(t)
    assert.equal(state.calls.length, 2)
    if (ready) state.calls[0].child.emit('message', { ready: true })
    const error = new Error('runtime preparation failed')
    state.environment.reject(error)
    await nextTurn()
    state.calls[0].child.emit('message', { ready: true })
    await nextTurn()
    assert.equal(state.runtime.exitCode, 1)
    assert.equal(state.calls.length, 2)
    assert.ok(state.calls.every((call) => call.child.kills === 1))
    assert.deepEqual(state.errors, [error])
    assert.deepEqual(state.failures, [])
  }
})

test('development launcher reports a spawn failure and stops children', async (t) => {
  const error = new Error('desktop spawn failed')
  const state = fixture(t, error)
  state.calls[0].child.emit('message', { ready: true })
  state.calls[0].child.emit('message', { ready: true })
  state.environment.resolve({})
  await nextTurn()
  assert.equal(state.runtime.exitCode, 1)
  assert.equal(state.calls.length, 2)
  assert.ok(state.calls.every((call) => call.child.kills === 1))
  assert.deepEqual(state.errors, [error])
  assert.deepEqual(state.failures, [])
})

test('development launcher cannot start after a signal or child exit during preparation', async (t) => {
  for (const stop of ['SIGINT', 'SIGTERM', 'site', 'docs']) {
    const state = fixture(t)
    assert.equal(state.calls.length, 2)
    state.calls[0].child.emit('message', { ready: true })
    if (stop.startsWith('SIG')) state.runtime.emit(stop)
    else state.calls.find((call) => call.kind === stop).child.emit('exit', 9)
    state.environment.resolve({
      ELECTRON_EXEC_PATH: '/owned/hibi.app/Electron',
    })
    await nextTurn()
    state.calls[0].child.emit('message', { ready: true })
    await nextTurn()
    assert.equal(state.calls.length, 2)
    assert.equal(state.runtime.exitCode, stop.startsWith('SIG') ? 0 : 9)
    assert.ok(state.calls.every((call) => call.child.kills === 1))
    assert.deepEqual(state.errors, [])
    assert.deepEqual(state.failures, [])
  }
})
