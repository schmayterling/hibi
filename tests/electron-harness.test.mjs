import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { electron, snapshotElectronProcesses } from './electron.mjs'

const fixture = 'tests/fixtures/launch-timeout.test.js'

const run = async (t, scenario, args = []) => {
  const prefix = `hibi-launch-timeout-${process.pid}-${scenario}-`
  // Under this variable, a child node runs no tests of its own.
  const { NODE_TEST_CONTEXT: _, ...env } = process.env
  const child = spawn(
    process.execPath,
    ['--test', '--test-reporter=tap', ...args, fixture],
    {
      env: {
        ...env,
        LAUNCH_TIMEOUT_PREFIX: prefix,
        LAUNCH_TIMEOUT_CASE: scenario,
      },
    },
  )
  let output = ''
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      output = (output + chunk).slice(-16384)
    })
  const apps = () =>
    execFileSync('ps', ['-axo', 'pgid=,command='], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.includes(prefix))
      .map((line) => Number(line.trim().split(/\s+/)[0]))
  t.after(async () => {
    child.kill('SIGKILL')
    for (const group of new Set(apps()))
      try {
        process.kill(-group, 'SIGKILL')
      } catch {}
    // The fixture's profile, removed only once its apps are gone.
    for (const name of await readdir(tmpdir()))
      if (name.startsWith(prefix))
        await rm(join(tmpdir(), name), { recursive: true, force: true })
  })
  const [code] = await Promise.race([
    once(child, 'exit'),
    setTimeout(90000, ['still running'], { ref: false }),
  ])
  return { code, output, left: apps() }
}

test('a file whose test times out during a launch still closes the app and exits', {
  timeout: 120000,
}, async (t) => {
  const { code, output, left } = await run(t, 'test')
  assert.equal(code, 1, output)
  assert.match(output, /test timed out after 200ms/)
  assert.deepEqual(left, [])
})

test('a launch a timed-out test left behind closes while a later test runs', {
  timeout: 120000,
}, async (t) => {
  const { code, output, left } = await run(t, 'later')
  assert.equal(code, 1, output)
  assert.match(output, /test timed out after 200ms/)
  assert.match(output, /the late app closed while a later test ran/)
  assert.deepEqual(left, [])
})

test('a launch a timed-out test in a describe block left behind closes while a later test runs', {
  timeout: 120000,
}, async (t) => {
  const { code, output, left } = await run(t, 'describe')
  assert.equal(code, 1, output)
  assert.match(output, /test timed out after 200ms/)
  assert.match(output, /the late app closed while a later test ran/)
  assert.deepEqual(left, [])
})

test('a launch a subtest left behind closes when its timed-out parent ends', {
  timeout: 120000,
}, async (t) => {
  const { code, output, left } = await run(t, 'nested')
  assert.equal(code, 1, output)
  assert.match(output, /test timed out after 200ms/)
  assert.match(output, /the late app closed while a later test ran/)
  assert.deepEqual(left, [])
})

test('a launch its test still awaits stays open when a subtest ends', {
  timeout: 120000,
}, async (t) => {
  const { code, output, left } = await run(t, 'subtest')
  assert.equal(code, 0, output)
  assert.match(output, /the parent kept its app after one subtest/)
  assert.match(output, /the parent kept its app alongside a subtest/)
  assert.deepEqual(left, [])
})

test("an app a before hook launches is still the file's after hook's to close", {
  timeout: 120000,
}, async (t) => {
  const { code, output, left } = await run(t, 'hook', [
    '--test-name-pattern=no test has this name',
  ])
  assert.equal(code, 0, output)
  assert.match(output, /after hook reached its app/)
  assert.deepEqual(left, [])
})

test('a slow quit names the profile files its processes still hold open', async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-snapshot-'))
  t.after(() => rm(profile, { recursive: true, force: true }))
  await mkdir(join(profile, 'Extension State'))
  const store = join(profile, 'Extension State', '000003.log')
  await writeFile(store, '')
  // Stands in for a process still writing a store when shutdown stalls.
  const holder = spawn(
    process.execPath,
    [
      '-e',
      `require('node:fs').openSync(${JSON.stringify(store)}, 'a'); console.log('open'); setInterval(() => {}, 1000)`,
    ],
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
  )
  t.after(() => holder.kill('SIGKILL'))
  await once(holder.stdout, 'data')
  const printed = []
  const error = console.error
  t.mock.method(console, 'error', (...args) => {
    printed.push(args.join(' '))
    error(...args)
  })
  await snapshotElectronProcesses(holder.pid, profile)
  assert.match(
    printed.join('\n'),
    /electron-shutdown-profile-files:\n\S+ \d+ Extension State\/000003\.log/,
  )
})

test('every launch traces its quit', { timeout: 60000 }, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-quit-trace-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  let open = true
  t.after(async () => {
    if (open) await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  await (await app.firstWindow()).locator('.titlebar').waitFor()
  // Holds quit past the helper's 3 s report, which then shows the trace.
  await app.evaluate(({ app }) => {
    let held = false
    app.on('before-quit', (event) => {
      if (held) return
      held = true
      event.preventDefault()
      setTimeout(() => app.quit(), 4000)
    })
  })
  const printed = []
  const error = console.error
  t.mock.method(console, 'error', (...args) => {
    printed.push(args.join(' '))
    error(...args)
  })
  open = false
  await app.close()
  const pending = printed.find((line) =>
    line.startsWith('electron-shutdown-pending '),
  )
  assert.ok(pending, printed.join('\n'))
  const { quit } = JSON.parse(
    pending.slice('electron-shutdown-pending '.length),
  )
  assert.equal(quit.notInstalled, false, pending)
  assert.equal(quit.beforeQuitSeen, true, pending)
})
