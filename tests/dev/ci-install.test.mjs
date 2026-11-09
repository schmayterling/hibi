import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nodeTest, { beforeEach } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { installDependencies } from '../../.github/actions/ci/install.mjs'
import { WORKER_HANG_TIMEOUT } from '../worker-progress.mjs'

const test = (name, options, run) =>
  nodeTest(
    name,
    {
      timeout: WORKER_HANG_TIMEOUT,
      ...(typeof options === 'function' ? {} : options),
    },
    run ?? options,
  )
beforeEach((t) => t.mock.timers.enable({ apis: ['setTimeout'] }))

function fixture(t, body) {
  const root = mkdtempSync(join(tmpdir(), 'hibi-ci-install-'))
  const state = join(root, 'attempts.json')
  const script = join(root, 'install.mjs')
  const messages = []
  t.mock.method(console, 'error', (...args) => messages.push(args.join(' ')))
  writeFileSync(
    script,
    `import { readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
const state = ${JSON.stringify(state)}
let attempts = []
try { attempts = JSON.parse(readFileSync(state, 'utf8')) } catch {}
attempts.push(process.pid)
writeFileSync(state, JSON.stringify(attempts))
const attempt = attempts.length
const ready = () => writeFileSync(state + '.ready', String(attempt))
process.on('exit', ready)
${body}
ready()
`,
  )
  const attempts = () => {
    try {
      return JSON.parse(readFileSync(state, 'utf8'))
    } catch {
      return []
    }
  }
  let ended = false
  const started = async (count) => {
    for (;;) {
      let ready = 0
      try {
        ready = Number(readFileSync(`${state}.ready`, 'utf8'))
      } catch {}
      if (ready >= count) return attempts()[count - 1]
      if (ended)
        throw new Error(`fixture exited before attempt ${count} was ready`)
      await delay(20)
    }
  }
  t.after(() => {
    for (const pid of attempts()) {
      try {
        if (process.platform === 'win32')
          spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
            stdio: 'ignore',
            timeout: 5000,
          })
        else process.kill(-pid, 'SIGKILL')
      } catch {}
    }
    rmSync(root, { recursive: true, force: true })
  })
  return {
    root,
    attempts,
    messages,
    started,
    run: (options) =>
      installDependencies({
        command: [process.execPath, script],
        timeoutMs: 3000,
        ...options,
      }).finally(() => {
        ended = true
      }),
  }
}

async function gone(pid) {
  // An orphan may briefly remain a zombie until the system reaps it.
  for (let tries = 0; tries < 100; tries++) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      assert.equal(error.code, 'ESRCH')
      return
    }
    if (process.platform !== 'win32') {
      const state = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], {
        encoding: 'utf8',
      })
      if (state.status === 1 || /^Z/.test(state.stdout.trim())) return
    }
    await delay(20)
  }
  assert.fail(`process ${pid} survived the watchdog`)
}

test('successful installs and ordinary failures settle once with their exit code', async (t) => {
  for (const code of [0, 7]) {
    const install = fixture(t, `process.exit(${code})`)
    assert.equal(await install.run(), code)
    assert.equal(install.attempts().length, 1)
    assert.deepEqual(install.messages, [])
  }
})

test('dependency download failures retry once and preserve the final exit code', async (t) => {
  for (const message of [
    'TypeError: fetch failed',
    'npm error code EAI_AGAIN',
    'HTTPError: Response code 504 (Gateway Timeout)',
  ])
    for (const repeated of [false, true]) {
      const install = fixture(
        t,
        `if (attempt === 1 || ${repeated}) {
  process.stderr.write(${JSON.stringify(message.slice(0, 12))})
  setTimeout(() => {
    console.log('checking cached files')
    setTimeout(() => {
      console.error(${JSON.stringify(message.slice(12))})
      process.exit(23)
    }, 10)
  }, 10)
}`,
      )
      assert.equal(await install.run(), repeated ? 23 : 0)
      assert.equal(install.attempts().length, 2)
      assert.match(
        install.messages.join('\n'),
        /download failed; retrying once/,
      )
    }
})

test('a download failure followed by a hang still stops after two attempts', async (t) => {
  const install = fixture(
    t,
    `if (attempt === 1) {
  console.error('TypeError: fetch failed')
  process.exit(23)
}
setInterval(() => {}, 1000)`,
  )
  const running = install.run()
  await install.started(2)
  t.mock.timers.tick(3000)
  assert.equal(await running, 124)
  assert.equal(install.attempts().length, 2)
  await gone(install.attempts()[1])
  assert.match(install.messages.at(-1), /hung on its final attempt/)
})

test('a recovered download warning does not retry a successful install', async (t) => {
  const install = fixture(t, "console.error('npm warn EAI_AGAIN recovered')")
  assert.equal(await install.run(), 0)
  assert.equal(install.attempts().length, 1)
  assert.deepEqual(install.messages, [])
})

test('a missing install command fails without retrying', async (t) => {
  const messages = []
  t.mock.method(console, 'error', (message) => messages.push(message))
  assert.equal(
    await installDependencies({
      command: [join(tmpdir(), 'missing-hibi-npm')],
    }),
    1,
  )
  assert.equal(messages.length, 1)
  assert.match(messages[0], /could not start/)
})

test('a post-summary hang kills the descendant tree and retries once', async (t) => {
  const install = fixture(
    t,
    `if (attempt === 1) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' })
  writeFileSync(state + '.child', String(child.pid))
  console.log('added 873 packages')
  setInterval(() => {}, 1000)
}`,
  )
  const running = install.run()
  await install.started(1)
  t.mock.timers.tick(3000)
  assert.equal(await running, 0)
  assert.equal(install.attempts().length, 2)
  await gone(install.attempts()[0])
  await gone(
    Number(readFileSync(join(install.root, 'attempts.json.child'), 'utf8')),
  )
  assert.match(install.messages.join('\n'), /npm ci hung.*attempt 1\/2/)
  assert.match(install.messages.join('\n'), /retrying once/)
  if (process.platform !== 'win32') {
    assert.match(install.messages.join('\n'), /pid ppid pgid elapsed command/)
    assert.match(
      install.messages.join('\n'),
      new RegExp(String(install.attempts()[0])),
    )
  }
})

test('two hung installs stop with 124 after exactly one retry', async (t) => {
  const install = fixture(t, 'setInterval(() => {}, 1000)')
  const running = install.run()
  await install.started(1)
  t.mock.timers.tick(2999)
  assert.equal(install.messages.length, 0)
  t.mock.timers.tick(1)
  await install.started(2)
  t.mock.timers.tick(3000)
  assert.equal(await running, 124)
  assert.equal(install.attempts().length, 2)
  for (const pid of install.attempts()) await gone(pid)
  assert.match(install.messages.at(-1), /hung on its final attempt/)
})

test('a descendant retaining output after npm exits still times out and is killed', {
  skip: process.platform === 'win32',
}, async (t) => {
  const install = fixture(
    t,
    `if (attempt === 1) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' })
  writeFileSync(state + '.child', String(child.pid))
  process.exit(0)
}`,
  )
  const running = install.run()
  await install.started(1)
  t.mock.timers.tick(3000)
  assert.equal(await running, 0)
  assert.equal(install.attempts().length, 2)
  await gone(
    Number(readFileSync(join(install.root, 'attempts.json.child'), 'utf8')),
  )
  assert.match(install.messages.join('\n'), /retrying once/)
})

test('unavailable snapshot commands cannot prevent termination or retry', {
  skip: process.platform === 'win32',
}, async (t) => {
  const install = fixture(t, 'if (attempt === 1) setInterval(() => {}, 1000)')
  const path = process.env.PATH
  try {
    process.env.PATH = ''
    const running = install.run()
    await install.started(1)
    t.mock.timers.tick(3000)
    assert.equal(await running, 0)
  } finally {
    process.env.PATH = path
  }
  assert.equal(install.attempts().length, 2)
  await gone(install.attempts()[0])
  assert.match(install.messages.join('\n'), /snapshot unavailable/)
})

test('cancellation kills the install and does not retry', async (t) => {
  const install = fixture(t, 'setInterval(() => {}, 1000)')
  const running = install.run()
  try {
    await install.started(1)
    assert.equal(install.attempts().length, 1)
  } finally {
    process.emit('SIGTERM')
  }
  assert.equal(await running, 143)
  assert.equal(install.attempts().length, 1)
  await gone(install.attempts()[0])
})
