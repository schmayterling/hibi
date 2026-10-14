import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import test from 'node:test'
import { stopElectronTree } from './electron.mjs'

test('electron cleanup stops descendants after the process group leader exits', {
  skip: process.platform === 'win32',
  timeout: 5000,
}, async (t) => {
  const parent = spawn(
    process.execPath,
    [
      '-e',
      `const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 1, 2] });
child.unref();`,
    ],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const cleanup = () => {
    try {
      process.kill(-parent.pid, 'SIGKILL')
    } catch {}
  }
  t.after(cleanup)
  const closed = once(parent, 'close')
  await once(parent, 'exit')
  assert.equal(parent.exitCode, 0)
  let rescued = false
  const watchdog = setTimeout(() => {
    rescued = true
    cleanup()
  }, 2000)
  try {
    stopElectronTree(parent)
    await closed
    assert.equal(
      rescued,
      false,
      'cleanup must stop descendants without the watchdog',
    )
  } finally {
    clearTimeout(watchdog)
  }
})
