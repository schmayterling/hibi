// Runs a small red check like tests/ci-plan.test.mjs does, then removes its
// folder at once, and names what scripts/ci.mjs left running at its exit.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const check = resolve('scripts/ci.mjs')
const running = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const remove = (root) => {
  try {
    rmSync(root, { recursive: true, force: true })
    return 'removed'
  } catch (error) {
    return error.code
  }
}
const nodeFile = (name, ms, red) =>
  `import 'node:child_process'\nimport test from 'node:test'\ntest('${name}', async () => {\n  await new Promise((done) => setTimeout(done, ${ms}))\n  ${red ? "throw new Error('red')" : ''}\n})\n`
const tally = { runs: 0, pendingAtExit: 0, aliveAfterReturn: 0, eperm: 0, epermWithAlive: 0, epermWithoutPending: 0 }
for (let run = 1; run <= 60; run++) {
  const root = mkdtempSync(join(tmpdir(), 'red-exit-'))
  const repo = join(root, 'repo')
  const stub = join(root, 'npm.cjs')
  writeFileSync(stub, '')
  const files = {
    '.gitignore': 'out/\n.cache/\n',
    'tests/file-limit.mjs': '',
    'tests/one.test.mjs': nodeFile('one', Math.floor(Math.random() * 3000), false),
    'tests/two.test.mjs': nodeFile('two', Math.floor(Math.random() * 3000), true),
  }
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, file)), { recursive: true })
    writeFileSync(join(repo, file), source)
  }
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.name', 'ci')
  git('config', 'user.email', 'ci@example.com')
  git('add', '.')
  git('commit', '-qm', 'first')
  const { status, stderr } = spawnSync(process.execPath, [check], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      CI_BASE: '',
      CI_CLEAN: '',
      CI_FULL: 'true',
      CI_SHARD: '0/1',
      CI_WORKERS: '1',
      GITHUB_ACTIONS: '',
      GITHUB_OUTPUT: '',
      GITHUB_STEP_SUMMARY: '',
      npm_execpath: stub,
    },
  })
  const pending = (stderr.match(/PROBE pending at exit: (\S+)/)?.[1] ?? '')
    .split(',')
    .filter(Boolean)
    .map((entry) => ({ pid: Number(entry.split(':')[0]), command: entry.split(':').slice(1).join(':') }))
  const alive = pending.filter(({ pid }) => running(pid))
  const first = remove(root)
  tally.runs++
  if (pending.length) tally.pendingAtExit++
  if (alive.length) tally.aliveAfterReturn++
  if (first !== 'removed') {
    tally.eperm++
    if (alive.length) tally.epermWithAlive++
    if (!pending.length) tally.epermWithoutPending++
  }
  for (let wait = 0; wait < 100 && pending.some(({ pid }) => running(pid)); wait++)
    await new Promise((done) => setTimeout(done, 50))
  const second = first === 'removed' ? 'removed' : remove(root)
  console.log(
    `run ${run}: status ${status}, pending at exit [${pending.map(({ pid, command }) => `${pid} ${command}`).join(', ')}], alive after return [${alive.map(({ pid }) => pid).join(', ')}], rm ${first}, after they end ${second}`,
  )
}
console.log(`RED_EXIT ${JSON.stringify(tally)}`)
