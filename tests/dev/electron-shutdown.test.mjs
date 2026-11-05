import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { waitForElectronShutdown } from '../electron.mjs'

test('windows profile cleanup waits for electron transport closure', async () => {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
  })
  let closeTransport
  const transport = new Promise((resolve) => {
    closeTransport = resolve
  })
  let settled = false
  const shutdown = waitForElectronShutdown(child, transport, 'win32').then(
    () => {
      settled = true
    },
  )
  child.exitCode = 0
  child.emit('exit', 0, null)
  await Promise.resolve()
  assert.equal(settled, false)
  closeTransport()
  await shutdown
  assert.equal(settled, true)

  const crashed = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
  })
  const failure = waitForElectronShutdown(crashed, Promise.resolve(), 'win32')
  crashed.signalCode = 'SIGKILL'
  crashed.emit('exit', null, 'SIGKILL')
  await assert.rejects(failure, /signal SIGKILL/)
})
