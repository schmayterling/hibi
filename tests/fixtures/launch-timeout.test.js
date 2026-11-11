// Run by electron-harness.test.mjs; whether this file exits is what that test
// checks. That test also removes the profile, once every app here has closed.
import { execFileSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { after, before, electron } from '../electron.mjs'

const temp = await mkdtemp(join(tmpdir(), process.env.LAUNCH_TIMEOUT_PREFIX))
const launch = () =>
  electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(temp, 'profile')}`],
  })
const scenario = process.env.LAUNCH_TIMEOUT_CASE
if (scenario === 'hook') {
  // A file's shared app, still launching when node runs the after hooks.
  let app
  before(async () => {
    app = await launch()
  })
  after(async () => {
    await app.evaluate(() => {})
    console.log('after hook reached its app')
    await app.close()
  })
  test('skipped by the name pattern', () => {})
} else if (scenario === 'subtest') {
  // A subtest ending says nothing about a launch its parent still waits on.
  const ready = async (app) => {
    await (await app.firstWindow()).locator('.titlebar').waitFor()
    await app.evaluate(() => {})
  }
  test('a parent awaits its launch after a subtest', async (t) => {
    const launching = launch()
    await t.test('a quick subtest', () => {})
    const app = await launching
    await ready(app)
    await app.close()
    console.log('the parent kept its app after one subtest')
  })
  test('a parent awaits its launch with a subtest', async (t) => {
    const [app] = await Promise.all([launch(), t.test('alongside', () => {})])
    await ready(app)
    await app.close()
    console.log('the parent kept its app alongside a subtest')
  })
} else {
  // The timeout lands while the app is still starting.
  test('a test that times out during a launch', { timeout: 200 }, async (t) => {
    let app
    t.after(() => app?.close())
    app = await launch()
    await new Promise(() => {})
  })
  if (scenario === 'later')
    test('a later test outlives that launch', { timeout: 60000 }, async () => {
      const running = () =>
        execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' }).includes(
          temp,
        )
      while (!running()) await setTimeout(200)
      // Until the late app has started and been closed again.
      while (running()) await setTimeout(200)
      console.log('the late app closed while a later test ran')
    })
}
