// Run by electron-harness.test.mjs; whether this file exits is what that test checks.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { after, before, electron } from '../electron.mjs'

const temp = await mkdtemp(join(tmpdir(), process.env.LAUNCH_TIMEOUT_PREFIX))
const launch = () =>
  electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(temp, 'profile')}`],
  })
if (process.env.LAUNCH_TIMEOUT_CASE === 'hook') {
  // A file's shared app, still launching when node runs the after hooks.
  let app
  before(async () => {
    app = await launch()
  })
  after(async () => {
    await app.evaluate(() => {})
    console.log('after hook reached its app')
    await app.close()
    await rm(temp, { recursive: true, force: true })
  })
  test('skipped by the name pattern', () => {})
} else {
  // The timeout lands while the app is still starting.
  test('a test that times out during a launch', { timeout: 200 }, async (t) => {
    let app
    t.after(async () => {
      await app?.close()
      await rm(temp, { recursive: true, force: true })
    })
    app = await launch()
    await new Promise(() => {})
  })
}
