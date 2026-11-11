import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { planChecks, shardTests, testWorkers } from '../scripts/ci.mjs'

// A check a test runs carries that test's own tag after its inherited ones, so
// whatever it leaves running is found when the test ends, stopped, and fails
// the test: the rule this check keeps for every file, kept by its own tests.
// Windows can't show another process's environment, so there it can't look.
const owns = (t) => {
  const probe = `ci-plan-${process.pid}-${Math.random().toString(36).slice(2)}`
  const left = () => {
    if (process.platform === 'darwin')
      return spawnSync(
        'python3',
        ['-I', resolve('scripts/ci-owned.py'), probe, '-1'],
        { encoding: 'utf8' },
      )
        .stdout.split('\n')
        .filter(Boolean)
        .map((line) => {
          // A process it couldn't read is named so, and isn't known to be ours.
          const [pid, name] = line.split('\t')
          return pid === 'unreadable' ? [name, pid] : [pid, name]
        })
    if (process.platform !== 'linux') return []
    return readdirSync('/proc')
      .filter((pid) => /^\d+$/.test(pid))
      .flatMap((pid) => {
        try {
          const owned = readFileSync(`/proc/${pid}/environ`, 'utf8')
            .split('\0')
            .some(
              (entry) =>
                entry.startsWith('HIBI_CI_FILE=') &&
                entry.slice(13).split(':').includes(probe),
            )
          return owned
            ? [[pid, readFileSync(`/proc/${pid}/comm`, 'utf8').trim()]]
            : []
        } catch {
          return []
        }
      })
  }
  t.after(async () => {
    // What's on its way out isn't left behind.
    let found = left()
    for (let look = 0; found.length && look < 20; look++) {
      await new Promise((done) => setTimeout(done, 100))
      found = left()
    }
    for (const [pid, name] of found)
      if (name !== 'unreadable')
        try {
          process.kill(Number(pid), 'SIGKILL')
        } catch {
          /* Gone already. */
        }
    assert.deepEqual(
      found.map(([pid, name]) => `${name} ${pid}`),
      [],
      `${t.name} left processes running`,
    )
  })
  return {
    HIBI_CI_FILE: [process.env.HIBI_CI_FILE, probe].filter(Boolean).join(':'),
  }
}

test('incremental checks select dependencies and fall back safely for cold, clean, config, and missing builds', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hibi-ci-plan-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const files = {
    'src/shared/one.ts': 'export const one = 1',
    'src/shared/two.ts': 'export const two = 2',
    'tests/one.test.mjs': "import '../src/shared/one.ts'",
    'tests/two.test.mjs': "import '../src/shared/two.ts'",
    'tests/desktop.test.mjs': "import './electron.mjs'",
    'tests/indirect.test.mjs': "import './desktop-helper.mjs'",
    'tests/desktop-helper.mjs': "import './electron.mjs'",
    'tests/browser.test.mjs': "import { chromium } from 'playwright'",
    'tests/timer.test.mjs': 'setTimeout(() => {}, 2000)',
    'tests/clock.test.mjs': 'const deadline = Date.now() + 2000',
    'tests/electron.mjs': "import { _electron } from 'playwright'",
    'tests/io.test.mjs': "import { readFile } from 'node:fs/promises'",
    'tests/helper.mjs': "export { one } from '../src/shared/one.ts'",
    'tests/helper.test.mjs': "import './helper.mjs'",
  }
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), source)
  }
  execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' })
  execFileSync('git', ['add', '.'], { cwd: root, stdio: 'pipe' })
  const previousTests = Object.keys(files)
    .filter((file) => file.endsWith('.test.mjs'))
    .sort()
  const plan = (changed, options = {}) =>
    planChecks(root, { changed, previousTests, ...options })
  const clean = plan([])
  assert.deepEqual(clean.tests, [])
  assert.equal(clean.build, false)
  assert.deepEqual(plan([], { force: true }).unitTests, [
    'tests/helper.test.mjs',
    'tests/io.test.mjs',
    'tests/one.test.mjs',
    'tests/two.test.mjs',
  ])
  const direct = plan(['tests/one.test.mjs'])
  assert.deepEqual(direct.tests, ['tests/one.test.mjs'])
  assert.deepEqual(direct.unitTests, ['tests/one.test.mjs'])
  assert.equal(direct.build, false)
  assert.equal(direct.typecheck, false)
  const standIn = plan(['tests/fixtures/local-diagnostics-off/runtime.ts'])
  assert.equal(standIn.typecheck, true)
  assert.equal(standIn.build, false)
  assert.ok(
    plan(['tests/fixtures/image.png']).tests.includes('tests/io.test.mjs'),
  )
  assert.deepEqual(plan(['tests/helper.mjs']).tests, ['tests/helper.test.mjs'])
  const source = plan(['src/shared/one.ts'])
  assert.deepEqual(source.tests, [
    'tests/desktop.test.mjs',
    'tests/helper.test.mjs',
    'tests/indirect.test.mjs',
    'tests/io.test.mjs',
    'tests/one.test.mjs',
  ])
  assert.equal(source.build, true)
  assert.deepEqual(source.unitTests, [
    'tests/helper.test.mjs',
    'tests/io.test.mjs',
    'tests/one.test.mjs',
  ])
  for (const total of [2, 4]) {
    for (const selected of [source, plan([], { force: true })]) {
      const shards = Array.from({ length: total }, (_, index) =>
        shardTests(selected.tests, selected.allTests, index, total),
      )
      assert.deepEqual(shards.flat().sort(), selected.tests)
    }
  }
  assert.deepEqual(
    plan([], {
      previousTests: previousTests.filter(
        (file) => file !== 'tests/two.test.mjs',
      ),
    }).tests,
    ['tests/two.test.mjs'],
  )
  for (const options of [
    { changed: undefined },
    { previousTests: undefined },
    { force: true },
    { outputAvailable: false },
    { changed: ['package-lock.json'] },
    { changed: ['.github/workflows/check.yml'] },
    { changed: ['unrecognized.config'] },
  ]) {
    const result = plan([], options)
    assert.equal(result.full, true)
    assert.equal(result.build, true)
    assert.deepEqual(result.tests, previousTests)
  }
  writeFileSync(
    join(root, 'tests/dynamic.test.mjs'),
    'const target = "./runtime.mjs"; await import(target)',
  )
  writeFileSync(join(root, 'tests/runtime.mjs'), 'export default true')
  execFileSync('git', ['add', 'tests/dynamic.test.mjs', 'tests/runtime.mjs'], {
    cwd: root,
    stdio: 'pipe',
  })
  const dynamic = plan(['tests/helper.mjs'], {
    previousTests: [...previousTests, 'tests/dynamic.test.mjs'],
  })
  assert.ok(dynamic.tests.includes('tests/dynamic.test.mjs'))
  assert.ok(!dynamic.unitTests.includes('tests/dynamic.test.mjs'))
  writeFileSync(join(root, 'src/shared/new.ts'), 'export const added = 3')
  const untracked = plan([])
  assert.equal(untracked.build, true)
  assert.ok(untracked.tests.includes('tests/desktop.test.mjs'))
})

test('docs-only checks rebuild bundled help and retain documentation tests without unrelated desktop work', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hibi-ci-docs-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const files = {
    'tests/electron.mjs': "import { _electron } from 'playwright'",
    'tests/desktop.test.mjs': "import './electron.mjs'",
    'tests/addon-readme.test.mjs': "import './electron.mjs'",
    'tests/addon-reference.test.mjs': "import './electron.mjs'",
    'tests/docs-export.test.mjs':
      "import { execFileSync } from 'node:child_process'",
  }
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), source)
  }
  execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' })
  execFileSync('git', ['add', '.'], { cwd: root, stdio: 'pipe' })
  const previousTests = Object.keys(files)
    .filter((file) => file.endsWith('.test.mjs'))
    .sort()
  const plan = (changed, options = {}) =>
    planChecks(root, { changed, previousTests, ...options })
  for (const changed of [
    ['docs/guides/editing.md'],
    ['docs/images/editor.png'],
    ['docs/development/addon-api-reference/Sidebar.md', 'docs/README.md'],
  ]) {
    const result = plan(changed)
    assert.equal(result.full, false)
    assert.equal(result.build, true)
    assert.deepEqual(result.tests, [
      'tests/addon-readme.test.mjs',
      'tests/addon-reference.test.mjs',
      'tests/docs-export.test.mjs',
    ])
  }
  for (const changed of [
    ['docs/licenses/typst-assets.md'],
    ['docs/guides/editing.md', 'src/shared/one.ts'],
    ['docs/config.js'],
    ['tests/fixtures/help.md'],
  ]) {
    assert.ok(plan(changed).tests.includes('tests/desktop.test.mjs'))
  }
  for (const options of [{ force: true }, { previousTests: undefined }]) {
    assert.deepEqual(
      plan(['docs/guides/editing.md'], options).tests,
      previousTests,
    )
  }
  assert.ok(
    plan(['docs/guides/editing.md'], {
      previousTests: previousTests.filter(
        (file) => file !== 'tests/desktop.test.mjs',
      ),
    }).tests.includes('tests/desktop.test.mjs'),
  )
})

test('a test file change selects that test alone even though the harness starts processes', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hibi-ci-harness-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const files = {
    'src/shared/one.ts': 'export const one = 1',
    'tests/electron.mjs':
      "import { _electron } from 'playwright'; import 'node:child_process'",
    'tests/desktop.test.mjs': "import './electron.mjs'",
    'tests/other.test.mjs': "import './electron.mjs'",
    'tests/spawns.test.mjs': "import 'node:child_process'",
    'tests/helper.mjs': "import './electron.mjs'",
    'tests/helped.test.mjs': "import './helper.mjs'",
    'tests/formatted-engine-gaps.test.mjs': "import 'node:fs/promises'",
  }
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), source)
  }
  execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' })
  execFileSync('git', ['add', '.'], { cwd: root, stdio: 'pipe' })
  const previousTests = Object.keys(files)
    .filter((file) => file.endsWith('.test.mjs'))
    .sort()
  const plan = (changed) => planChecks(root, { changed, previousTests }).tests
  // Except the test that reads every test file against its ledger.
  assert.deepEqual(plan(['tests/desktop.test.mjs']), [
    'tests/desktop.test.mjs',
    'tests/formatted-engine-gaps.test.mjs',
  ])
  // A helper can reach what a process-starting test runs; a change to it still selects that test.
  assert.deepEqual(plan(['tests/helper.mjs']), [
    'tests/helped.test.mjs',
    'tests/spawns.test.mjs',
  ])
  assert.deepEqual(plan(['src/shared/one.ts']), [
    'tests/desktop.test.mjs',
    'tests/formatted-engine-gaps.test.mjs',
    'tests/helped.test.mjs',
    'tests/other.test.mjs',
    'tests/spawns.test.mjs',
  ])
})

test('check:ci never runs tests/dev, check:dev does, and neither takes the other for green', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hibi-ci-dev-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'repo')
  const ran = join(root, 'ran')
  const write = (file, text) => {
    mkdirSync(dirname(join(repo, file)), { recursive: true })
    writeFileSync(join(repo, file), text)
  }
  const git = (...args) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' })
  const testFile = (name) =>
    `import { appendFileSync } from 'node:fs'\nimport test from 'node:test'\ntest('${name}', () => appendFileSync(process.env.RAN, '${name} '))\n`
  write('.gitignore', 'out/\n.cache/\n')
  write('tests/file-limit.mjs', '')
  write('tests/one.test.mjs', testFile('hosted'))
  write('tests/dev/two.test.mjs', testFile('dev'))
  write('tests/dev/fixtures/held.mjs', '')
  write(
    'tests/spawns.test.mjs',
    "import 'node:child_process'\nimport test from 'node:test'\ntest('spawns', () => {})\n",
  )
  git('init', '-q')
  git('config', 'user.name', 'ci')
  git('config', 'user.email', 'ci@example.com')
  git('add', '.')
  git('commit', '-qm', 'first')
  for (const file of [
    'out/main/index.js',
    'out/preload/index.cjs',
    'out/renderer/index.html',
    'out/site/template.html',
  ])
    write(file, '')
  const hosted = 'tests/one.test.mjs'
  const dev = 'tests/dev/two.test.mjs'
  const spawns = 'tests/spawns.test.mjs'
  assert.deepEqual(planChecks(repo, { force: true }).allTests, [hosted, spawns])
  assert.deepEqual(planChecks(repo, { force: true, dev: true }).tests, [
    dev,
    hosted,
    spawns,
  ])
  const previousTests = [hosted, dev, spawns]
  const edited = { changed: [dev], previousTests }
  assert.deepEqual(planChecks(repo, edited).tests, [])
  assert.deepEqual(planChecks(repo, { ...edited, dev: true }).tests, [dev])
  // A test can find a dev fixture by its path, but no hosted test uses one.
  const fixture = { changed: ['tests/dev/fixtures/held.mjs'], previousTests }
  assert.deepEqual(planChecks(repo, fixture).tests, [])
  assert.deepEqual(planChecks(repo, { ...fixture, dev: true }).tests, [spawns])
  // Data kept there would otherwise count as data for every hosted test.
  const data = { changed: ['tests/dev/fixtures/held.json'], previousTests }
  assert.deepEqual(planChecks(repo, data).tests, [])
  assert.deepEqual(planChecks(repo, { ...data, dev: true }).tests, [
    dev,
    hosted,
    spawns,
  ])
  const stub = join(root, 'npm.cjs')
  writeFileSync(stub, '')
  const { NODE_TEST_CONTEXT: _, ...env } = process.env
  const check = (script) => {
    writeFileSync(ran, '')
    const output = execFileSync(process.execPath, [resolve(script)], {
      cwd: repo,
      encoding: 'utf8',
      stdio: 'pipe',
      env: {
        ...env,
        ...owns(t),
        RAN: ran,
        CI_BASE: '',
        CI_CLEAN: '',
        CI_FULL: '',
        CI_SHARD: '0/1',
        GITHUB_OUTPUT: '',
        GITHUB_STEP_SUMMARY: '',
        npm_execpath: stub,
      },
    })
    return {
      ran: readFileSync(ran, 'utf8').trim().split(' ').sort(),
      cold: output.includes('base=none'),
    }
  }
  // A green check:ci leaves check:dev cold, and the reverse.
  assert.deepEqual(check('scripts/ci.mjs'), { ran: ['hosted'], cold: true })
  assert.deepEqual(check('scripts/ci-dev.mjs'), {
    ran: ['dev', 'hosted'],
    cold: true,
  })
  rmSync(join(repo, '.cache/ci/success.json'))
  assert.deepEqual(check('scripts/ci.mjs'), { ran: ['hosted'], cold: true })
  rmSync(join(repo, '.cache/ci/success-dev.json'))
  assert.deepEqual(check('scripts/ci-dev.mjs'), {
    ran: ['dev', 'hosted'],
    cold: true,
  })
  // Each still trusts its own record.
  assert.equal(check('scripts/ci.mjs').cold, false)
  assert.equal(check('scripts/ci-dev.mjs').cold, false)
})

test('a test in a subfolder runs in the check its folder belongs to', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hibi-ci-nested-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const nested = 'tests/group/one.test.mjs'
  const nestedDev = 'tests/dev/group/two.test.mjs'
  for (const file of [nested, nestedDev]) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), '')
  }
  execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' })
  assert.deepEqual(planChecks(root, { force: true }).allTests, [nested])
  assert.deepEqual(planChecks(root, { force: true, dev: true }).allTests, [
    nestedDev,
    nested,
  ])
})

test('a pull request rebuilds an app the cache kept from another revision, and sees both ends of a move', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hibi-ci-stale-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'repo')
  const write = (file, text) => {
    mkdirSync(dirname(join(repo, file)), { recursive: true })
    writeFileSync(join(repo, file), text)
  }
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim()
  const commit = () => {
    git('add', '.')
    git('commit', '-qm', 'next')
    return git('rev-parse', 'HEAD')
  }
  write('.gitignore', 'out/\n.cache/\n')
  write('src/app.ts', 'export const version = 1\n')
  // Runs a test once it moves to tests/.
  write(
    'scripts/tool.mjs',
    `${'// a script the app build runs\n'.repeat(4)}import test from 'node:test'\ntest('tool', () => {})\n`,
  )
  write('tests/file-limit.mjs', '')
  write(
    'tests/one.test.mjs',
    "import test from 'node:test'\ntest('one', () => {})\n",
  )
  git('init', '-q')
  git('config', 'user.name', 'ci')
  git('config', 'user.email', 'ci@example.com')
  const built = commit()
  for (const file of [
    'out/main/index.js',
    'out/preload/index.cjs',
    'out/renderer/index.html',
    'out/site/template.html',
  ])
    write(file, '')
  const runtime = `${process.platform}/${process.arch}/${process.version}/${process.env.ImageVersion ?? 'local'}/0/1`
  const stub = join(root, 'npm.cjs')
  const calls = join(root, 'calls')
  writeFileSync(
    stub,
    "require('node:fs').appendFileSync(process.env.CALLS, process.argv.slice(2).join(' ') + '\\n')\n",
  )
  const check = (base, sha = built) => {
    write(
      '.cache/ci/success.json',
      JSON.stringify({
        version: 1,
        runtime,
        sha,
        tests: ['tests/one.test.mjs'],
      }),
    )
    writeFileSync(calls, '')
    execFileSync(process.execPath, [resolve('scripts/ci.mjs')], {
      cwd: repo,
      stdio: 'pipe',
      env: {
        ...process.env,
        ...owns(t),
        NODE_TEST_CONTEXT: undefined,
        CALLS: calls,
        CI_BASE: base,
        CI_CLEAN: '',
        CI_FULL: '',
        CI_SHARD: '0/1',
        GITHUB_OUTPUT: '',
        GITHUB_STEP_SUMMARY: '',
        npm_execpath: stub,
      },
    })
    return readFileSync(calls, 'utf8').includes('run build:app')
  }
  write('src/app.ts', 'export const version = 2\n')
  const base = commit()
  write(
    'tests/one.test.mjs',
    "import test from 'node:test'\ntest('two', () => {})\n",
  )
  commit()
  assert.equal(check(base), true)
  assert.equal(check(base, base), false)
  assert.equal(check(base, 'f'.repeat(40)), true)
  assert.equal(check(base, 'no revision'), true)
  renameSync(join(repo, 'scripts/tool.mjs'), join(repo, 'tests/tool.test.mjs'))
  const moved = commit()
  assert.equal(check(git('rev-parse', 'HEAD~1'), moved), true)
})

test('test workers follow the machine and tests that share a machine resource run alone', (t) => {
  const GiB = 2 ** 30
  const workers = (cores, gib) =>
    testWorkers({ cores, memory: gib * GiB, override: '' })
  assert.deepEqual(workers(8, 24), { apps: 4, node: 4 })
  assert.deepEqual(workers(4, 16), { apps: 1, node: 2 })
  assert.deepEqual(workers(3, 7), { apps: 1, node: 1 })
  assert.deepEqual(workers(16, 8), { apps: 2, node: 8 })
  assert.deepEqual(workers(1, 2), { apps: 1, node: 1 })
  assert.equal(testWorkers({ override: '3' }).apps, 3)
  // Node reads 0 or a word as no limit, and would start an app per core.
  for (const override of ['0', 'two', '-1', '1.5'])
    assert.throws(() => testWorkers({ override }), /Invalid CI_WORKERS/)

  const root = mkdtempSync(join(tmpdir(), 'hibi-ci-alone-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const files = {
    'tests/electron.mjs': "import { _electron } from 'playwright'",
    'tests/plain.test.mjs': "import './electron.mjs'",
    'tests/reads.test.mjs':
      "import './electron.mjs'; clipboard.readText(); const copied = 'clipboard.'",
    'tests/keys.test.mjs': "import './electron.mjs'; press('ControlOrMeta+v')",
    'tests/shortcut.test.mjs':
      "import './electron.mjs'; globalShortcut.register",
    'tests/marked.test.mjs':
      "// ci: alone (asserts wall-clock time)\nimport './electron.mjs'",
    'tests/helped.test.mjs': "import './clipboard-helper.mjs'",
    'tests/clipboard-helper.mjs':
      "import './electron.mjs'; navigator.clipboard.readText()",
    'tests/stub.test.mjs': "import './electron.mjs'; const clipboardData = 1",
    'tests/unit.test.mjs': 'const unit = 1',
    // Starts the app through a test script it runs by path.
    'tests/gate.test.mjs':
      "import { spawnSync } from 'node:child_process'\nspawnSync(process.execPath, ['--test', 'tests/fixtures/gate.test.js'])\nconst gone = 'tests/fixtures/gone.js'",
    'tests/fixtures/gate.test.js': "import '../electron.mjs'",
    // Names a script without running it.
    'tests/named.test.mjs': "const script = 'tests/fixtures/gate.test.js'",
  }
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), source)
  }
  execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' })
  execFileSync('git', ['add', '.'], { cwd: root, stdio: 'pipe' })
  const plan = planChecks(root, { force: true })
  assert.deepEqual(plan.aloneTests, [
    'tests/helped.test.mjs',
    'tests/keys.test.mjs',
    'tests/marked.test.mjs',
    'tests/reads.test.mjs',
    'tests/shortcut.test.mjs',
  ])
  assert.deepEqual(plan.appTests, [
    'tests/gate.test.mjs',
    'tests/plain.test.mjs',
    'tests/stub.test.mjs',
  ])
  assert.ok(plan.unitTests.includes('tests/named.test.mjs'))
})

test('a red in any group leaves the others to run, fails the check, and names every red', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hibi-ci-red-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'repo')
  const ran = join(root, 'ran')
  const stub = join(root, 'npm.cjs')
  writeFileSync(stub, '')
  const testFile = (name, first = '') =>
    `${first}\nimport { appendFileSync } from 'node:fs'\nimport test from 'node:test'\ntest('${name}', async (t) => {\n  appendFileSync(process.env.RAN, '${name} ')\n  await t.test('${name}', () => {\n    if (process.env.RED === '${name}') throw new Error('red')\n  })\n})\n`
  const files = {
    '.gitignore': 'out/\n.cache/\n',
    'tests/file-limit.mjs': '',
    // Marks its importers as app tests without needing playwright to run.
    'tests/electron.mjs': "export const later = () => import('playwright')",
    'tests/unit.test.mjs': testFile('unit'),
    'tests/other.test.mjs': testFile('other', "import 'node:child_process'"),
    'tests/app.test.mjs': testFile('app', "import './electron.mjs'"),
    'tests/alone.test.mjs': testFile(
      'alone',
      "// ci: alone (why)\nimport './electron.mjs'",
    ),
  }
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, file)), { recursive: true })
    writeFileSync(join(repo, file), source)
  }
  const git = (...args) =>
    execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.name', 'ci')
  git('config', 'user.email', 'ci@example.com')
  git('add', '.')
  git('commit', '-qm', 'first')
  const { NODE_TEST_CONTEXT: _, ...env } = process.env
  const record = join(repo, '.cache/ci/success.json')
  const summary = join(root, 'summary.md')
  const check = (red, actions = false) => {
    writeFileSync(ran, '')
    writeFileSync(summary, '')
    rmSync(record, { force: true })
    const { status, stdout } = spawnSync(
      process.execPath,
      [resolve('scripts/ci.mjs')],
      {
        cwd: repo,
        stdio: 'pipe',
        env: {
          ...env,
          ...owns(t),
          RED: red,
          RAN: ran,
          CI_BASE: '',
          CI_CLEAN: '',
          CI_FULL: 'true',
          CI_SHARD: '0/1',
          CI_WORKERS: '1',
          GITHUB_ACTIONS: actions ? 'true' : '',
          GITHUB_OUTPUT: '',
          GITHUB_STEP_SUMMARY: actions ? summary : '',
          npm_execpath: stub,
        },
        encoding: 'utf8',
      },
    )
    return {
      status,
      ran: readFileSync(ran, 'utf8').trim().split(' ').sort(),
      recorded: existsSync(record),
      stdout,
    }
  }
  const all = ['alone', 'app', 'other', 'unit']
  const { stdout: greenOutput, ...green } = check('')
  assert.deepEqual(green, { status: 0, ran: all, recorded: true })
  assert.doesNotMatch(greenOutput, /failing tests/)
  const batch = { unit: 'unit', other: 'node', app: 'app', alone: 'alone' }
  for (const red of ['unit', 'other', 'app', 'alone']) {
    const { stdout, ...result } = check(red)
    assert.deepEqual(result, { status: 1, ran: all, recorded: false }, red)
    // One line per red at the end, after every group's own output.
    assert.match(
      stdout,
      new RegExp(
        `\\nci: 1 failing tests\\n  ${batch[red]}  tests/${red}\\.test\\.mjs:\\d+  ${red}: red\\n$`,
      ),
      red,
    )
  }
  // A hosted run puts each red on the run page and in the step summary.
  const hosted = check('app', true)
  assert.match(
    hosted.stdout,
    /^::error file=tests\/app\.test\.mjs,line=\d+,title=app%3A app::red$/m,
  )
  assert.match(
    readFileSync(summary, 'utf8'),
    /### 1 failing tests\n\n- app `tests\/app\.test\.mjs:\d+` app: red\n/,
  )
})

test('a group that fails to start or report in full is a red of its own, and the rest still run', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hibi-ci-faults-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'repo')
  const ran = join(root, 'ran')
  const stub = join(root, 'npm.cjs')
  const faults = join(root, 'faults.mjs')
  writeFileSync(stub, '')
  // Stands in for what the machine can do to the unit group's run or report.
  writeFileSync(
    faults,
    `import process from 'node:child_process'
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
const spawn = process.spawn
// Changes the report as the run ends, before the check hears it ended.
const edit = (child, change) => {
  const emit = child.emit.bind(child)
  child.emit = (event, ...rest) => emit(event, ...(event === 'close' ? change(...rest) : rest))
  return child
}
process.spawn = (command, args, options) => {
  const fault = globalThis.process.env.FAULT
  if (!args.includes('tests/unit.test.mjs')) return spawn(command, args, options)
  if (fault === 'spawn') return spawn('/nonexistent/ci-fault', [], options)
  if (fault === 'throw') throw new Error('EPERM, operation not permitted')
  const report = args.find((arg) => arg.startsWith('--test-reporter-destination=') && !arg.endsWith('=stdout')).slice(28)
  return edit(spawn(command, args, options), (status, signal) => {
    const result = { status, signal }
    const done = (outcome = result) => [outcome.status, outcome.signal]
  if (fault === 'missing') rmSync(report)
  if (fault === 'torn') appendFileSync(report, '{"name":')
  if (fault === 'cut') writeFileSync(report, '')
  if (fault === 'null') writeFileSync(report, 'null\\n')
  // Loses the failure line, keeps the count that names it.
  if (fault === 'dropped') writeFileSync(report, readFileSync(report, 'utf8').split('\\n').filter((line) => !line.includes('"name"')).join('\\n'))
  if (fault === 'killed') return done({ status: null, signal: 'SIGTERM' })
  if (!['typed', 'twice', 'unknown', 'files', 'footer', 'key', 'error'].includes(fault)) return done()
  const lines = readFileSync(report, 'utf8').split('\\n').filter(Boolean)
  const footer = JSON.parse(lines.at(-1))
  const write = (...rest) => writeFileSync(report, [...lines.slice(0, -1), ...rest].map((line) => typeof line === 'string' ? line : JSON.stringify(line)).join('\\n') + '\\n')
  if (fault === 'typed') write({ ...footer, failures: { toString: null } })
  if (fault === 'twice') write(lines.at(-1), ...lines)
  if (fault === 'unknown') write(lines.at(-1), { unexpected: true })
  if (fault === 'files') write({ ...footer, files: 0 })
  if (fault === 'footer') write({ ...footer, extra: 1 })
  if (fault === 'key') write({ name: 'x', error: 'e', extra: 1 }, { ...footer, failures: 1 })
  if (fault === 'error') write({ name: 'x', error: 1 }, { ...footer, failures: 1 })
  return done()
  })
}
syncBuiltinESMExports()
`,
  )
  const files = {
    '.gitignore': 'out/\n.cache/\n',
    'tests/file-limit.mjs': '',
    'tests/electron.mjs': "export const later = () => import('playwright')",
    'tests/unit.test.mjs': `import { appendFileSync } from 'node:fs'\nimport test from 'node:test'\nif (process.env.SHAPE !== 'empty') (process.env.SHAPE === 'skip' ? test.skip : test)('unit', () => {\n  appendFileSync(process.env.RAN, 'unit ')\n  if (process.env.RED) throw new Error('red')\n})\nif (process.env.SHAPE !== 'empty') test.todo('later', () => {\n  throw new Error('not yet')\n})\n`,
    'tests/app.test.mjs': `import './electron.mjs'\nimport { appendFileSync } from 'node:fs'\nimport test from 'node:test'\ntest('app', () => appendFileSync(process.env.RAN, 'app '))\n`,
  }
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, file)), { recursive: true })
    writeFileSync(join(repo, file), source)
  }
  const git = (...args) =>
    execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.name', 'ci')
  git('config', 'user.email', 'ci@example.com')
  git('add', '.')
  git('commit', '-qm', 'first')
  const { NODE_TEST_CONTEXT: _, ...env } = process.env
  const record = join(repo, '.cache/ci/success.json')
  const check = (fault, red = '', shape = '') => {
    writeFileSync(ran, '')
    rmSync(record, { force: true })
    const { status, stdout } = spawnSync(
      process.execPath,
      ['--import', faults, resolve('scripts/ci.mjs')],
      {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...env,
          ...owns(t),
          FAULT: fault,
          SHAPE: shape,
          RED: red,
          RAN: ran,
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
      },
    )
    return {
      status,
      ran: readFileSync(ran, 'utf8').trim().split(' ').sort(),
      recorded: existsSync(record),
      reds: stdout.slice(stdout.lastIndexOf('\nci: ') + 1).trimEnd(),
    }
  }
  // A todo that throws is no red.
  const { reds: green, ...clean } = check('')
  assert.deepEqual(clean, { status: 0, ran: ['app', 'unit'], recorded: true })
  assert.doesNotMatch(green, /failing tests/)
  const line = /tests\/unit\.test\.mjs:\d+/
  const cases = {
    spawn: [
      ['app'],
      /^ci: 1 failing tests\n {2}unit {2}tests\/unit\.test\.mjs {2}could not start: spawn \/nonexistent\/ci-fault ENOENT$/,
    ],
    throw: [
      ['app'],
      /^ci: 1 failing tests\n {2}unit {2}tests\/unit\.test\.mjs {2}could not start: EPERM, operation not permitted$/,
    ],
    null: [
      ['app', 'unit'],
      /^ci: 1 failing tests\n {2}unit {2}tests\/unit\.test\.mjs {2}did not finish: its report did not finish; 1 unreadable report lines$/,
    ],
    missing: [
      ['app', 'unit'],
      /^ci: 1 failing tests\n {2}unit {2}tests\/unit\.test\.mjs {2}did not finish: its report did not finish$/,
    ],
    cut: [
      ['app', 'unit'],
      /^ci: 1 failing tests\n {2}unit {2}tests\/unit\.test\.mjs {2}did not finish: its report did not finish$/,
    ],
  }
  for (const [fault, [ranGroups, reds]] of Object.entries(cases)) {
    const { reds: listed, ...result } = check(fault)
    assert.deepEqual(
      result,
      { status: 1, ran: ranGroups, recorded: false },
      fault,
    )
    assert.match(listed, reds, fault)
  }
  // With a real red, the records read before the fault are kept beside it.
  const torn = check('torn', 'red')
  assert.equal(torn.status, 1)
  assert.deepEqual(torn.ran, ['app', 'unit'])
  assert.match(
    torn.reds,
    new RegExp(
      `^ci: 2 failing tests\\n {2}unit {2}${line.source} {2}unit: red\\n {2}unit {2}tests/unit\\.test\\.mjs {2}did not finish: its report did not finish; 2 unreadable report lines$`,
    ),
  )
  // A group whose files skipped every test or registered none proved nothing,
  // and a report must be read exactly as the reporter wrote it.
  for (const [fault, shape, reds] of [
    [
      '',
      'skip',
      /^ci: 1 failing tests\n {2}unit {4}did not finish: ran no tests; 1 test files$/,
    ],
    [
      '',
      'empty',
      /^ci: 1 failing tests\n {2}unit {4}did not finish: ran no tests; 1 test files$/,
    ],
    [
      'typed',
      '',
      /^ci: 1 failing tests\n {2}unit {2}tests\/unit\.test\.mjs {2}did not finish: its report did not finish; 1 unreadable report lines$/,
    ],
    [
      'twice',
      '',
      /^ci: 1 failing tests\n {2}unit {2}tests\/unit\.test\.mjs {2}did not finish: 1 unreadable report lines$/,
    ],
    [
      'unknown',
      '',
      /^ci: 1 failing tests\n {2}unit {2}tests\/unit\.test\.mjs {2}did not finish: its report did not finish; 2 unreadable report lines$/,
    ],
    [
      'files',
      '',
      /^ci: 1 failing tests\n {2}unit {2}tests\/unit\.test\.mjs {2}did not finish: its runner heard nothing from it$/,
    ],
    [
      'footer',
      '',
      /^ci: 1 failing tests\n {2}unit {2}tests\/unit\.test\.mjs {2}did not finish: its report did not finish; 1 unreadable report lines$/,
    ],
    ...['key', 'error'].map((fault) => [
      fault,
      '',
      /^ci: 1 failing tests\n {2}unit {2}tests\/unit\.test\.mjs {2}did not finish: 1 unreadable report lines; its report counted 1 failures but held 0$/,
    ]),
  ]) {
    const { reds: listed, ...result } = check(fault, '', shape)
    assert.deepEqual(
      { ...result, ran: result.ran.includes('app') },
      { status: 1, ran: true, recorded: false },
      fault || shape,
    )
    assert.match(listed, reds, fault || shape)
  }
  const dropped = check('dropped', 'red')
  assert.equal(dropped.status, 1)
  assert.match(
    dropped.reds,
    /^ci: 1 failing tests\n {2}unit {2}tests\/unit\.test\.mjs {2}exited 1 with no failing test reported: its report counted 1 failures but held 0$/,
  )
  const killed = check('killed', 'red')
  assert.equal(killed.status, 1)
  assert.deepEqual(killed.ran, ['app', 'unit'])
  assert.match(
    killed.reds,
    new RegExp(
      `^ci: 2 failing tests\\n {2}unit {2}${line.source} {2}unit: red\\n {2}unit {2}tests/unit\\.test\\.mjs {2}did not finish: killed by SIGTERM$`,
    ),
  )
})

test('the report counts tests by the file that ran them, on every supported node', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hibi-ci-report-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const files = {
    // Tests a helper declares belong to the file that imports it.
    'helper.mjs':
      "import test from 'node:test'\nexport const register = (name) => test(name, () => {})\n",
    'one.test.mjs':
      "import { register } from './helper.mjs'\nregister('one')\n",
    'two.test.mjs':
      "import { register } from './helper.mjs'\nregister('two')\n",
    'skipped.test.mjs':
      "import test from 'node:test'\ntest.skip('skipped', () => {})\n",
    'empty.test.mjs': "import 'node:test'\n",
    'crash.test.mjs': 'process.exit(3)\n',
  }
  for (const [file, source] of Object.entries(files))
    writeFileSync(join(root, file), source)
  const owned = owns(t)
  const report = (node, tests) => {
    const destination = join(root, 'report.jsonl')
    rmSync(destination, { force: true })
    const { NODE_TEST_CONTEXT: _, ...env } = process.env
    spawnSync(
      node,
      [
        '--test',
        `--test-reporter=${new URL('../scripts/ci-failures.mjs', import.meta.url).href}`,
        `--test-reporter-destination=${destination}`,
        ...tests,
      ],
      { cwd: root, env: { ...env, ...owned } },
    )
    return JSON.parse(
      readFileSync(destination, 'utf8').trim().split('\n').at(-1),
    )
  }
  // package.json allows node 22.18 and later; each one installed here gets a run.
  const installed = join(homedir(), '.nvm/versions/node')
  const nodes = new Map([[process.version, process.execPath]])
  for (const version of existsSync(installed) ? readdirSync(installed) : []) {
    const [major, minor] = version.slice(1).split('.').map(Number)
    if (major > 22 || (major === 22 && minor >= 18))
      nodes.set(version, join(installed, version, 'bin/node'))
  }
  for (const major of [22, 24])
    if (![...nodes.keys()].some((version) => version.startsWith(`v${major}.`)))
      t.diagnostic(`no node ${major} installed: its run is skipped`)
  for (const [version, node] of nodes) {
    assert.deepEqual(
      report(node, ['one.test.mjs', 'two.test.mjs']),
      { done: true, failures: 0, ran: 2, files: 2 },
      version,
    )
    assert.deepEqual(
      report(node, ['skipped.test.mjs', 'empty.test.mjs']),
      { done: true, failures: 0, ran: 0, files: 2 },
      version,
    )
    assert.deepEqual(
      report(node, ['crash.test.mjs', 'one.test.mjs']),
      { done: true, failures: 1, ran: 1, files: 2 },
      version,
    )
  }
})

test('a file that runs past its time is stopped and named, and every other file still runs', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hibi-ci-watchdog-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'repo')
  const ran = join(root, 'ran')
  const stub = join(root, 'npm.cjs')
  writeFileSync(stub, '')
  // Named apart, so the check for a process left behind finds only this one.
  const spin = `tests/spin-${process.pid}-${Date.now()}.test.mjs`
  const testFile = (name, body, first = "import 'node:child_process'") =>
    `${first}\nimport { appendFileSync } from 'node:fs'\nimport test from 'node:test'\ntest('${name}', async () => {\n  appendFileSync(process.env.RAN, '${name} ')\n  ${body}\n})\n`
  const files = {
    '.gitignore': 'out/\n.cache/\n',
    'tests/file-limit.mjs': '',
    'tests/electron.mjs': "export const later = () => import('playwright')",
    // Starts a process that outlives it in its group, as Electron's launcher
    // does, then leaves.
    'tests/leader.cjs': `const { spawn } = require('node:child_process')
const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
require('node:fs').writeFileSync(\`\${process.env.HELD}/helper\`, String(helper.pid))
setTimeout(() => process.exit(0), 1500)
`,
    // Starts a process in a new session and leaves at once, as a crash
    // handler's launcher does: its child belongs to no one but init.
    'tests/daemon.cjs': `const { spawn } = require('node:child_process')
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
require('node:fs').writeFileSync(\`\${process.env.HELD}/daemon\`, String(child.pid))
process.exit(0)
`,
    // Starts processes in groups of their own while it's being stopped.
    'tests/breeder.cjs': `const { spawn } = require('node:child_process')
const { appendFileSync } = require('node:fs')
let bred = 0
setTimeout(() => {
  const timer = setInterval(() => {
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    appendFileSync(\`\${process.env.HELD}/bred\`, \`\${child.pid}\\n\`)
    if (++bred === 250) clearInterval(timer)
  }, 3)
}, 1200)
`,
    // node:test can't time out a synchronous loop. This one gives up after a
    // minute, so a broken check fails instead of hanging. First it starts
    // processes in groups of their own, as Playwright does with Electron.
    [spin]: `// ci: timeout 2 s (spins)\n${testFile(
      'spin',
      "const { spawn } = await import('node:child_process')\n  const { writeFileSync } = await import('node:fs')\n  const held = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })\n  writeFileSync(`${process.env.HELD}/held`, String(held.pid))\n  spawn(process.execPath, ['tests/leader.cjs'], { detached: true, stdio: 'ignore' })\n  spawn(process.execPath, ['tests/breeder.cjs'], { detached: true, stdio: 'ignore' })\n  spawn(process.execPath, ['tests/daemon.cjs'], { detached: true, stdio: 'ignore' })\n  const bare = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: {}, stdio: 'ignore' })\n  writeFileSync(`${process.env.HELD}/bare`, String(bare.pid))\n  for (const end = Date.now() + 60000; Date.now() < end; );",
    )}`,
    // Its runner dies under it, and leaves what it started behind.
    'tests/orphan.test.mjs': testFile(
      'orphan',
      "const { spawn } = await import('node:child_process')\n  const { writeFileSync } = await import('node:fs')\n  const held = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })\n  writeFileSync(`${process.env.HELD}/orphan`, String(held.pid))\n  await new Promise((done) => setTimeout(done, 1500))\n  process.kill(process.ppid, 'SIGKILL')\n  await new Promise((done) => setTimeout(done, 60000))",
    ),
    // Runs beside the spin, and on after it's stopped.
    'tests/mate.test.mjs': testFile(
      'mate',
      "await new Promise((done) => setTimeout(done, 8000))\n  appendFileSync(process.env.RAN, 'mate-done ')",
    ),
    // Slow, but within the time it asks for.
    'tests/slow.test.mjs': `// ci: timeout 4 s (sleeps)\n${testFile('slow', 'appendFileSync(process.env.RAN, `limit:${process.env.CI_FILE_LIMIT_MS} `)\n  await new Promise((done) => setTimeout(done, 1500))')}`,
    'tests/app.test.mjs': testFile(
      'app',
      "throw new Error('app-red')",
      "import './electron.mjs'",
    ),
    // Passes, but leaves a process running.
    'tests/leak.test.mjs': testFile(
      'leak',
      "const { spawn } = await import('node:child_process')\n  const { writeFileSync } = await import('node:fs')\n  const left = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })\n  left.unref()\n  writeFileSync(`${process.env.HELD}/leak`, String(left.pid))",
    ),
    // A red beside a stopped file stays a red.
    'tests/red.test.mjs': testFile('red', "throw new Error('red')"),
    // Only the comments a file opens with set its time.
    'tests/quoted.test.mjs': testFile(
      'quoted',
      'const text = `\n// ci: timeout 1 s\n`\n  await new Promise((done) => setTimeout(done, 1500 + text.length))',
    ),
    // Runs next in the app group's one slot: the red before it must not repeat.
    'tests/zero.test.mjs': `// ci: timeout 0 s (no time)\n${testFile('zero', '', "import './electron.mjs'")}`,
  }
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, file)), { recursive: true })
    writeFileSync(join(repo, file), source)
  }
  const git = (...args) =>
    execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.name', 'ci')
  git('config', 'user.email', 'ci@example.com')
  git('add', '.')
  git('commit', '-qm', 'first')
  const { NODE_TEST_CONTEXT: _, ...env } = process.env
  const started = Date.now()
  const held = join(root, 'held')
  mkdirSync(held)
  let heldPids = []
  // Registered first, so it runs first: before what's noted is stopped below.
  const owned = owns(t)
  // A broken check would leave them running.
  t.after(() => {
    for (const pid of heldPids)
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* Stopped, as it should be. */
      }
  })
  const { status, stdout } = spawnSync(
    process.execPath,
    [resolve('scripts/ci.mjs')],
    {
      cwd: repo,
      encoding: 'utf8',
      timeout: 120000,
      env: {
        ...env,
        ...owned,
        // A red exits 1 even where a rejection only warns.
        NODE_OPTIONS: '--unhandled-rejections=warn',
        HELD: held,
        RAN: ran,
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
    },
  )
  heldPids = readdirSync(held).flatMap((name) =>
    readFileSync(join(held, name), 'utf8').trim().split('\n').map(Number),
  )
  assert.equal(status, 1)
  // Stopped, not waited out: the spin alone would take a minute.
  assert.ok(Date.now() - started < 45000, `took ${Date.now() - started} ms`)
  assert.equal(existsSync(join(repo, '.cache/ci/success.json')), false)
  const runs = readFileSync(ran, 'utf8').trim().split(' ')
  // Each file ran once: stopping one stops nothing else.
  assert.deepEqual(runs.sort(), [
    'app',
    // The file's own limit leaves this check the first word.
    'leak',
    'limit:64000',
    'mate',
    'mate-done',
    'orphan',
    'quoted',
    'red',
    'slow',
    'spin',
  ])
  const reds = stdout.slice(stdout.lastIndexOf('\nci: ') + 1).trimEnd()
  const quote = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  assert.match(
    reds,
    new RegExp(
      `^${[
        'ci: 7 failing tests',
        '  node  tests/leak.test.mjs  did not stop what it started: left node(?:\\.exe)? \\d+ running',
        '  node  tests/orphan.test.mjs  exited SIGKILL with no failing test reported: killed by SIGKILL; its report did not finish',
        // What a runner that died left behind is named, then stopped.
        '  node  tests/orphan.test.mjs  did not stop what it started: left node(?:\\.exe)? \\d+, node(?:\\.exe)? \\d+ running',
        quote('  node  tests/red.test.mjs:4  red: red'),
        quote(
          `  node  ${spin}  did not finish within 2 s: stopped with everything it started`,
        ),
        quote('  app  tests/app.test.mjs:4  app: app-red'),
        quote(
          '  app  tests/zero.test.mjs  could not start: ci: timeout 0 s is not 1 to 86400 seconds',
        ),
      ].join('\n')}$`,
    ),
  )
  // Stopping a file stops what it started, in its group or out of it, and
  // so does its runner dying.
  if (process.platform !== 'win32') {
    assert.equal(spawnSync('pgrep', ['-f', spin]).status, 1)
    assert.ok(heldPids.length > 3, String(heldPids.length))
    for (const pid of heldPids)
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, String(pid))
  }
})

test('an interrupted check stops its files, starts no more, and names its reds so far', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hibi-ci-interrupt-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'repo')
  const ran = join(root, 'ran')
  const stub = join(root, 'npm.cjs')
  writeFileSync(stub, '')
  // Twice as many as run at once, so some wait their turn.
  const waves = testWorkers().node
  const files = {
    '.gitignore': 'out/\n.cache/\n',
    'tests/file-limit.mjs': '',
    // Starts no process, so its group runs and ends before the waits'.
    'tests/a-red.test.mjs':
      "import test from 'node:test'\ntest('red', () => {\n  throw new Error('red before the interrupt')\n})\n",
  }
  for (let index = 0; index < waves * 2; index++)
    files[`tests/wait-${index}.test.mjs`] =
      `import 'node:child_process'\nimport { appendFileSync } from 'node:fs'\nimport test from 'node:test'\ntest('wait', async () => {\n  appendFileSync(process.env.RAN, 'started ')\n  await new Promise((done) => setTimeout(done, ${index < waves ? 30000 : 0}))\n})\n`
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, file)), { recursive: true })
    writeFileSync(join(repo, file), source)
  }
  const git = (...args) =>
    execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.name', 'ci')
  git('config', 'user.email', 'ci@example.com')
  git('add', '.')
  git('commit', '-qm', 'first')
  writeFileSync(ran, '')
  const { NODE_TEST_CONTEXT: _, ...env } = process.env
  const check = spawn(process.execPath, [resolve('scripts/ci.mjs')], {
    cwd: repo,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: {
      ...env,
      ...owns(t),
      RAN: ran,
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
  t.after(() => check.kill('SIGKILL'))
  let stdout = ''
  check.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  const started = () => readFileSync(ran, 'utf8').split(' ').filter(Boolean)
  for (let wait = 0; started().length < waves && wait < 300; wait++)
    await new Promise((done) => setTimeout(done, 100))
  assert.equal(started().length, waves)
  const closed = new Promise((done) =>
    check.once('close', (status, signal) => done({ status, signal })),
  )
  check.kill('SIGINT')
  assert.deepEqual(await closed, { status: null, signal: 'SIGINT' })
  assert.match(
    stdout,
    /\nci: \d+ failing tests\n {2}unit {2}tests\/a-red\.test\.mjs:\d+ {2}red: red before the interrupt\n/,
  )
  // The files waiting their turn never ran, then or after: one started late
  // would outlive the check.
  await new Promise((done) => setTimeout(done, 2000))
  assert.equal(started().length, waves)
})

test("on macOS, a process's arguments read only in the kernel's own layout, and any other is named unreadable", {
  skip: process.platform === 'win32' && 'no python3 on the Windows runner',
}, () => {
  // KERN_PROCARGS2: argc, the exec path and its NUL, zeros to the next 8-byte
  // boundary, then argv and the environment, each NUL-ended.
  const record = ({ argc, path, padding = '', strings }) => {
    const head = Buffer.alloc(4)
    head.writeInt32LE(argc)
    const named = Buffer.concat([head, Buffer.from(`${path}\0${padding}`)])
    const zeros = Buffer.alloc((8 - ((named.length - 4) % 8)) % 8)
    return Buffer.concat([
      named,
      zeros,
      Buffer.from(strings.map((entry) => `${entry}\0`).join('')),
    ]).toString('hex')
  }
  const records = [
    record({
      argc: 2,
      path: '/bin/node',
      strings: ['node', 'x', 'HIBI_CI_FILE=a:tag', 'OTHER=1'],
    }),
    // An empty argv[0] right after the zeros is an argument, not more zeros.
    record({
      argc: 2,
      path: '/bin/nod',
      strings: ['', 'x', 'HIBI_CI_FILE=tag'],
    }),
    // Tags in an argument or inside another variable aren't the file's.
    record({
      argc: 2,
      path: '/bin/node',
      strings: ['node', 'HIBI_CI_FILE=tag', 'X=HIBI_CI_FILE=tag'],
    }),
    // Not zeros between the path and the arguments.
    record({ argc: 1, path: '/bin/node', padding: 'x', strings: ['node'] }),
    // Fewer strings than argc says.
    record({ argc: 9, path: '/bin/node', strings: ['node', 'x'] }),
    // No end to the path.
    Buffer.concat([Buffer.alloc(4), Buffer.from('/bin/node')]).toString('hex'),
  ]
  const { status, stdout, stderr } = spawnSync(
    'python3',
    [
      '-I',
      '-c',
      "import importlib.util, json, sys\nspec = importlib.util.spec_from_file_location('owned', sys.argv[1])\nowned = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(owned)\nfor hexed in json.load(sys.stdin):\n    parsed = owned.parse(bytes.fromhex(hexed))\n    print(json.dumps(parsed and [parsed[0].decode(), [entry.decode() for entry in parsed[1]], owned.tagged(parsed[1], 'tag')]))",
      resolve('scripts/ci-owned.py'),
    ],
    { input: JSON.stringify(records), encoding: 'utf8' },
  )
  assert.equal(status, 0, stderr)
  assert.deepEqual(
    stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
    [
      ['/bin/node', ['HIBI_CI_FILE=a:tag', 'OTHER=1'], true],
      ['/bin/nod', ['HIBI_CI_FILE=tag'], true],
      ['/bin/node', ['X=HIBI_CI_FILE=tag'], false],
      null,
      null,
      null,
    ],
  )
})

test('a cleanup that cannot be checked is a red, and the check still ends', {
  skip:
    process.platform !== 'darwin' &&
    'only macOS looks for processes with python3',
}, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hibi-ci-hung-ps-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'repo')
  const bin = join(root, 'bin')
  const stub = join(root, 'npm.cjs')
  writeFileSync(stub, '')
  mkdirSync(bin)
  // A process scan that never answers.
  writeFileSync(join(bin, 'python3'), '#!/bin/sh\nexec sleep 60\n', {
    mode: 0o755,
  })
  const files = {
    '.gitignore': 'out/\n.cache/\n',
    'tests/file-limit.mjs': '',
    'tests/one.test.mjs':
      "import 'node:child_process'\nimport test from 'node:test'\ntest('one', () => {})\n",
  }
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, file)), { recursive: true })
    writeFileSync(join(repo, file), source)
  }
  const git = (...args) =>
    execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.name', 'ci')
  git('config', 'user.email', 'ci@example.com')
  git('add', '.')
  git('commit', '-qm', 'first')
  const { NODE_TEST_CONTEXT: _, ...env } = process.env
  const started = Date.now()
  const { status, stdout } = spawnSync(
    process.execPath,
    [resolve('scripts/ci.mjs')],
    {
      cwd: repo,
      encoding: 'utf8',
      timeout: 60000,
      env: {
        ...env,
        ...owns(t),
        PATH: `${bin}:${process.env.PATH}`,
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
    },
  )
  assert.equal(status, 1)
  assert.ok(Date.now() - started < 30000, `took ${Date.now() - started} ms`)
  assert.equal(
    stdout.slice(stdout.lastIndexOf('\nci: ') + 1).trimEnd(),
    'ci: 1 failing tests\n  node  tests/one.test.mjs  did not stop what it started: could not verify cleanup: python3 took over 5 s',
  )
  // One that answers with something that isn't a process list.
  writeFileSync(join(bin, 'python3'), '#!/bin/sh\necho "pid\tname"\n', {
    mode: 0o755,
  })
  const garbled = spawnSync(process.execPath, [resolve('scripts/ci.mjs')], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...env,
      ...owns(t),
      PATH: `${bin}:${process.env.PATH}`,
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
  assert.equal(
    garbled.stdout.slice(garbled.stdout.lastIndexOf('\nci: ') + 1).trimEnd(),
    'ci: 1 failing tests\n  node  tests/one.test.mjs  did not stop what it started: could not verify cleanup: python3 gave an unreadable line: pid\tname',
  )
})

test('what a file owns is found exactly, through a check it runs itself', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hibi-ci-owned-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'repo')
  const ran = join(root, 'ran')
  const held = join(root, 'held')
  mkdirSync(held)
  const stub = join(root, 'npm.cjs')
  writeFileSync(stub, '')
  const live = (body) =>
    `import { spawn } from 'node:child_process'\nimport { appendFileSync, writeFileSync } from 'node:fs'\nimport test from 'node:test'\n${body}`
  const files = {
    '.gitignore': 'out/\n.cache/\n',
    'tests/file-limit.mjs': '',
    // Passes, after starting two processes that only look like its own: one
    // names its tag in a command line, one inside another variable.
    'tests/decoys.test.mjs': live(
      "test('decoys', () => {\n  const tag = process.env.HIBI_CI_FILE\n  const words = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', `HIBI_CI_FILE=${tag}`], { detached: true, stdio: 'ignore', env: {} })\n  const value = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', env: { NOTE: `x HIBI_CI_FILE=${tag}` } })\n  words.unref()\n  value.unref()\n  writeFileSync(`${process.env.HELD}/decoys`, `${words.pid}\\n${value.pid}`)\n  appendFileSync(process.env.RAN, 'decoys ')\n})\n",
    ),
    // Passes, leaving a process whose first argument is empty and whose tag is
    // its only setting.
    'tests/blank.test.mjs': live(
      "test('blank', () => {\n  const blank = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { argv0: '', detached: true, stdio: 'ignore', env: { HIBI_CI_FILE: process.env.HIBI_CI_FILE } })\n  blank.unref()\n  writeFileSync(`${process.env.HELD}/blank`, String(blank.pid))\n  appendFileSync(process.env.RAN, 'blank ')\n})\n",
    ),
    // Passes, leaving a process with no tag in its runner's process group.
    'tests/bare.test.mjs': live(
      "test('bare', () => {\n  const bare = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', env: {} })\n  bare.unref()\n  writeFileSync(`${process.env.HELD}/bare`, String(bare.pid))\n  appendFileSync(process.env.RAN, 'bare ')\n})\n",
    ),
    // Runs this check on a repo of its own, whose one test starts a process
    // and never ends; stopped first, it takes the inner check's files along.
    'tests/nested.test.mjs': `// ci: timeout 8 s (runs a check)\n${live(
      `import { execFileSync, spawnSync } from 'node:child_process'\nimport { mkdirSync } from 'node:fs'\nimport { join } from 'node:path'\ntest('nested', () => {\n  appendFileSync(process.env.RAN, 'nested ')\n  const inner = join(process.env.NESTED, 'repo')\n  mkdirSync(join(inner, 'tests'), { recursive: true })\n  writeFileSync(join(inner, '.gitignore'), 'out/\\n.cache/\\n')\n  writeFileSync(join(inner, 'tests/file-limit.mjs'), '')\n  writeFileSync(join(inner, 'tests/deep.test.mjs'), "import { spawn } from 'node:child_process'\\nimport { writeFileSync } from 'node:fs'\\nimport test from 'node:test'\\ntest('deep', async () => {\\n  const deep = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })\\n  writeFileSync(process.env.HELD + '/deep', String(deep.pid))\\n  await new Promise(() => {})\\n})\\n")\n  for (const args of [['init', '-q'], ['config', 'user.name', 'ci'], ['config', 'user.email', 'ci@example.com'], ['add', '.'], ['commit', '-qm', 'first']]) execFileSync('git', args, { cwd: inner })\n  const { NODE_TEST_CONTEXT, ...outer } = process.env\n  spawnSync(process.execPath, [process.env.CHECK], { cwd: inner, stdio: 'ignore', env: outer })\n})\n`,
    )}`,
  }
  // Windows can't show a process's environment, so there a file owns every
  // process it started, look-alikes included.
  if (process.platform === 'win32') delete files['tests/decoys.test.mjs']
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, file)), { recursive: true })
    writeFileSync(join(repo, file), source)
  }
  const git = (...args) =>
    execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.name', 'ci')
  git('config', 'user.email', 'ci@example.com')
  git('add', '.')
  git('commit', '-qm', 'first')
  const nested = join(root, 'nested')
  mkdirSync(nested)
  let pids = []
  // Registered first, so it runs first: before what's noted is stopped below.
  const owned = owns(t)
  t.after(() => {
    for (const pid of pids)
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* Stopped, as it should be. */
      }
  })
  writeFileSync(ran, '')
  const { NODE_TEST_CONTEXT: _, ...env } = process.env
  const { status, stdout } = spawnSync(
    process.execPath,
    [resolve('scripts/ci.mjs')],
    {
      cwd: repo,
      encoding: 'utf8',
      timeout: 120000,
      env: {
        ...env,
        ...owned,
        CHECK: resolve('scripts/ci.mjs'),
        HELD: held,
        NESTED: nested,
        RAN: ran,
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
    },
  )
  pids = readdirSync(held).flatMap((name) =>
    readFileSync(join(held, name), 'utf8').trim().split('\n').map(Number),
  )
  assert.equal(status, 1)
  assert.deepEqual(
    readFileSync(ran, 'utf8').trim().split(' ').sort(),
    process.platform === 'win32'
      ? ['bare', 'blank', 'nested']
      : ['bare', 'blank', 'decoys', 'nested'],
  )
  assert.match(
    stdout.slice(stdout.lastIndexOf('\nci: ') + 1).trimEnd(),
    /^ci: 3 failing tests\n {2}node {2}tests\/bare\.test\.mjs {2}did not stop what it started: left node(?:\.exe)? \d+ running\n {2}node {2}tests\/blank\.test\.mjs {2}did not stop what it started: left node(?:\.exe)? \d+ running\n {2}node {2}tests\/nested\.test\.mjs {2}did not finish within 8 s: stopped with everything it started$/,
  )
  // Only look-alikes: left alone.
  if (process.platform !== 'win32')
    for (const pid of readFileSync(join(held, 'decoys'), 'utf8')
      .split('\n')
      .map(Number))
      process.kill(pid, 0)
  // What was the files' own is stopped, the inner check's too.
  for (const name of ['bare', 'blank', 'deep']) {
    const pid = Number(readFileSync(join(held, name), 'utf8'))
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, name)
  }
})

// Windows can't run here: its process look stands in, reading this machine's
// process table in the shape Win32_Process gives. A test can rewrite what it
// shows through $ROOT/rewrite.json: {parent: {pid: parent}, created: {pid: ms},
// rows: [[pid, parent, created, name]]}.
const windowsLook = `const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const start = Date.now()
fs.appendFileSync(process.env.LOOKS, 'look\\n')
if (process.env.LOOK_FAILS) process.exit(1)
if (process.env.LOOK_GARBLED) {
  console.log('x\ty\tz\tw')
  process.exit(0)
}
let rewrite = {}
try {
  rewrite = JSON.parse(fs.readFileSync(process.env.ROOT + '/rewrite.json', 'utf8'))
} catch {}
const seconds = (elapsed) => elapsed.split(/[-:]/).map(Number).reduce((sum, part, index, parts) => sum + part * [86400, 3600, 60, 1].slice(-parts.length)[index], 0)
const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,etime=,comm='], { encoding: 'utf8' }).trim().split('\\n').map((line) => line.trim().split(/\\s+/))
fs.appendFileSync(process.env.ROOT + '/listed', JSON.stringify({ start, pids: rows.map(([pid]) => pid) }) + '\\n')
const listed = fs.readFileSync(process.env.ROOT + '/listed', 'utf8').trim().split('\\n').map((line) => JSON.parse(line))
for (const [pid, parent, elapsed, ...name] of rows) {
  let created = rewrite.created?.[pid] ?? Date.now() - seconds(elapsed) * 1000
  let named = rewrite.parent?.[pid] ?? parent
  // Said to be its parent's child, started a while after the last look that
  // saw the parent began.
  const late = rewrite.late?.[pid]
  const seen = late && listed.findLast((look) => look.pids.includes(String(late.parent)))
  if (seen) {
    named = late.parent
    created = seen.start + late.after
  }
  console.log([pid, named, created, name.join(' ').split('/').at(-1)].join('\\t'))
}
for (const row of rewrite.rows ?? []) console.log(row.join('\\t'))
// A slow look: what it read is as old as when it started.
if (process.env.LOOK_DELAY) execFileSync('sleep', [String(process.env.LOOK_DELAY / 1000)])
`
// taskkill /T as Windows has it: the tree is walked from a live root, and a
// root that's already gone is exit 128 with nothing killed.
const windowsKill = `const { execFileSync } = require('node:child_process')
const root = Number(process.argv[process.argv.indexOf('/pid') + 1])
try {
  process.kill(root, 0)
} catch {
  process.exit(128)
}
const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\\n').map((line) => line.trim().split(/\\s+/).map(Number))
const kill = (pid) => {
  for (const [child, parent] of rows) if (parent === pid) kill(child)
  try {
    process.kill(pid, 'SIGKILL')
  } catch {}
}
kill(root)
`
const onWindows = async (
  t,
  files,
  { lookFails = false, garbled = false, lookDelay, during } = {},
) => {
  const root = mkdtempSync(join(tmpdir(), 'hibi-ci-windows-'))
  const repo = join(root, 'repo')
  const bin = join(root, 'bin')
  const notes = join(root, 'notes')
  const looks = join(root, 'looks')
  const stub = join(root, 'npm.cjs')
  const windows = join(root, 'windows.mjs')
  const pids = new Set()
  // Registered first, so it runs first: before what's noted is stopped below.
  const owned = owns(t)
  t.after(() => {
    for (const pid of pids)
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* Stopped, as it should be. */
      }
    rmSync(root, { recursive: true, force: true })
  })
  writeFileSync(stub, '')
  writeFileSync(notes, '')
  writeFileSync(looks, '')
  mkdirSync(bin)
  writeFileSync(
    windows,
    "Object.defineProperty(process, 'platform', { value: 'win32' })\n",
  )
  writeFileSync(join(root, 'look.cjs'), windowsLook)
  writeFileSync(join(root, 'kill.cjs'), windowsKill)
  writeFileSync(
    join(bin, 'taskkill'),
    `#!/bin/sh\nexec "${process.execPath}" "${join(root, 'kill.cjs')}" "$@"\n`,
    { mode: 0o755 },
  )
  // A shell wrapper: a #! line can't hold a node path with a space in it.
  writeFileSync(
    join(bin, 'powershell.exe'),
    `#!/bin/sh\nexec "${process.execPath}" "${join(root, 'look.cjs')}" "$@"\n`,
    { mode: 0o755 },
  )
  for (const [file, source] of Object.entries({
    '.gitignore': 'out/\n.cache/\n',
    'tests/file-limit.mjs': '',
    ...files,
  })) {
    mkdirSync(dirname(join(repo, file)), { recursive: true })
    writeFileSync(join(repo, file), source)
  }
  const git = (...args) =>
    execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.name', 'ci')
  git('config', 'user.email', 'ci@example.com')
  git('add', '.')
  git('commit', '-qm', 'first')
  const read = () =>
    readFileSync(notes, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  const note = (key) => read().find((entry) => entry.key === key)?.value
  const noted = async (key) => {
    for (let wait = 0; wait < 600 && note(key) === undefined; wait++)
      await new Promise((done) => setTimeout(done, 50))
    return note(key)
  }
  const { NODE_TEST_CONTEXT: _, ...env } = process.env
  const started = Date.now()
  const check = spawn(
    process.execPath,
    ['--import', windows, resolve('scripts/ci.mjs')],
    {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {
        ...env,
        ...owned,
        PATH: `${bin}:${process.env.PATH}`,
        ROOT: root,
        NOTES: notes,
        LOOKS: looks,
        LOOK_FAILS: lookFails ? '1' : '',
        LOOK_GARBLED: garbled ? '1' : '',
        LOOK_DELAY: lookDelay ? String(lookDelay) : '',
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
    },
  )
  t.after(() => check.kill('SIGKILL'))
  let stdout = ''
  check.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  const timer = setTimeout(() => check.kill('SIGKILL'), 120000)
  const closed = new Promise((done) =>
    check.once('close', (status) => done(status)),
  )
  await during?.({ root, noted, pids })
  const status = await closed
  clearTimeout(timer)
  for (const { value } of read()) if (Number.isInteger(value)) pids.add(value)
  return {
    status,
    ms: Date.now() - started,
    reds: stdout.slice(stdout.lastIndexOf('\nci: ') + 1).trimEnd(),
    looked: readFileSync(looks, 'utf8').length > 0,
    listed: existsSync(join(root, 'listed'))
      ? readFileSync(join(root, 'listed'), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : [],
    note,
  }
}
// A test file that can note what it started, in the shape onWindows reads.
const noting = (body, first = '') =>
  `${first}\nimport { spawn } from 'node:child_process'\nimport { appendFileSync, existsSync } from 'node:fs'\nimport test from 'node:test'\nconst note = (key, value) => appendFileSync(process.env.NOTES, JSON.stringify({ key, value }) + '\\n')\nconst hold = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })\ntest('file', async () => {\n${body}\n})\n`
const gone = (pid) => {
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}
const off = process.platform === 'win32' ? 'runs natively there' : false

test('on Windows, a file owns its process tree, and what it had to stop is named', {
  skip: off,
}, async (t) => {
  const run = await onWindows(t, {
    // Passes, leaving behind a process it started a while before.
    'tests/leak.test.mjs': noting(
      "const left = hold()\nleft.unref()\nnote('leak', left.pid)\nawait new Promise((done) => setTimeout(done, 3000))",
    ),
    'tests/spin.test.mjs': noting(
      "note('held', hold().pid)\nfor (const end = Date.now() + 60000; Date.now() < end; );",
      '// ci: timeout 2 s (spins)',
    ),
  })
  assert.equal(run.status, 1)
  assert.ok(run.ms < 45000, `took ${run.ms} ms`)
  // The Windows look ran, not the one this machine has.
  assert.ok(run.looked)
  assert.match(
    run.reds,
    /^ci: 2 failing tests\n {2}node {2}tests\/leak\.test\.mjs {2}did not stop what it started: left node \d+ running\n {2}node {2}tests\/spin\.test\.mjs {2}did not finish within 2 s: stopped with everything it started$/,
  )
  for (const key of ['leak', 'held']) assert.ok(gone(run.note(key)), key)
})

test('on Windows, a leak is learned while its file runs, with no other file to look', {
  skip: off,
}, async (t) => {
  const run = await onWindows(t, {
    'tests/leak.test.mjs': noting(
      "const left = hold()\nleft.unref()\nnote('leak', left.pid)\nawait new Promise((done) => setTimeout(done, 3000))",
    ),
  })
  assert.match(
    run.reds,
    /^ci: 1 failing tests\n {2}node {2}tests\/leak\.test\.mjs {2}did not stop what it started: left node \d+ running$/,
  )
  assert.ok(gone(run.note('leak')))
})

test("on Windows, a process that took a used id is not the file's, nor its child", {
  skip: off,
}, async (t) => {
  // A worker is learned and exits; an unrelated process takes its id and
  // starts a child after the file did.
  let decoy
  const reused = await onWindows(
    t,
    {
      'tests/reuse.test.mjs': noting(
        "const worker = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3500)'], { stdio: 'ignore' })\nnote('worker', worker.pid)\nawait new Promise((done) => worker.once('exit', done))\nnote('gone', 1)\nwhile (!existsSync(process.env.ROOT + '/rewrite.json')) await new Promise((done) => setTimeout(done, 50))\nawait new Promise((done) => setTimeout(done, 5000))",
      ),
    },
    {
      during: async ({ root, noted, pids }) => {
        await noted('gone')
        const worker = await noted('worker')
        const child = spawn(
          process.execPath,
          ['-e', 'setInterval(() => {}, 1000)'],
          { detached: true, stdio: 'ignore' },
        )
        child.unref()
        pids.add(child.pid)
        decoy = child.pid
        writeFileSync(
          join(root, 'rewrite.json'),
          JSON.stringify({
            parent: { [decoy]: worker },
            rows: [[worker, 1, Date.now(), 'unrelated.exe']],
          }),
        )
      },
    },
  )
  assert.equal(reused.status, 0, reused.reds)
  assert.ok(!gone(decoy), 'the reused id claimed an unrelated child')
  // With the worker gone from the table, a process named as its child still
  // isn't one if it started after the worker was last seen, or before it.
  for (const late of [true, false]) {
    let stranger
    const orphaned = await onWindows(
      t,
      {
        'tests/reuse.test.mjs': noting(
          `${late ? '' : "note('early', 1)\nwhile (!existsSync(process.env.ROOT + '/stranger')) await new Promise((done) => setTimeout(done, 50))\nawait new Promise((done) => setTimeout(done, 4000))\n"}const worker = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3500)'], { stdio: 'ignore' })\nnote('worker', worker.pid)\nawait new Promise((done) => worker.once('exit', done))\nnote('gone', 1)\nwhile (!existsSync(process.env.ROOT + '/rewrite.json')) await new Promise((done) => setTimeout(done, 50))\nawait new Promise((done) => setTimeout(done, 5000))`,
        ),
      },
      {
        during: async ({ root, noted, pids }) => {
          const start = () => {
            const child = spawn(
              process.execPath,
              ['-e', 'setInterval(() => {}, 1000)'],
              { detached: true, stdio: 'ignore' },
            )
            child.unref()
            pids.add(child.pid)
            return child.pid
          }
          if (!late) {
            await noted('early')
            stranger = start()
            writeFileSync(join(root, 'stranger'), '')
          }
          await noted('gone')
          // Two looks after the worker left, so its last sighting is old.
          await new Promise((done) => setTimeout(done, 4500))
          if (late) stranger = start()
          writeFileSync(
            join(root, 'rewrite.json'),
            JSON.stringify({ parent: { [stranger]: await noted('worker') } }),
          )
        },
      },
    )
    assert.equal(
      orphaned.status,
      0,
      `${late ? 'late' : 'early'}: ${orphaned.reds}`,
    )
    assert.ok(!gone(stranger), late ? 'started after' : 'started before')
  }
  // A learned helper later seen with another start time is another process.
  const renewed = await onWindows(
    t,
    {
      'tests/renewed.test.mjs': noting(
        "const left = hold()\nleft.unref()\nnote('held', left.pid)\nawait new Promise((done) => setTimeout(done, 3000))\nnote('learned', 1)\nwhile (!existsSync(process.env.ROOT + '/rewrite.json')) await new Promise((done) => setTimeout(done, 50))",
      ),
    },
    {
      during: async ({ root, noted }) => {
        await noted('learned')
        writeFileSync(
          join(root, 'rewrite.json'),
          JSON.stringify({
            created: { [await noted('held')]: Date.now() + 5000 },
          }),
        )
      },
    },
  )
  assert.equal(renewed.status, 0, renewed.reds)
  assert.ok(!gone(renewed.note('held')), 'a reused id was killed')
})

test("on Windows, a look's rows are as old as its start, however long it takes", {
  skip: off,
}, async (t) => {
  let stranger
  const run = await onWindows(
    t,
    {
      // Its worker outlives it, so the check's own looks see the worker too.
      'tests/slow.test.mjs': noting(
        "const worker = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'ignore' })\nworker.unref()\nnote('worker', worker.pid)\nawait new Promise((done) => setTimeout(done, 6000))\nnote('ending', String(Date.now()))",
      ),
    },
    {
      lookDelay: 2000,
      during: async ({ root, noted, pids }) => {
        const worker = await noted('worker')
        const child = spawn(
          process.execPath,
          ['-e', 'setInterval(() => {}, 1000)'],
          { detached: true, stdio: 'ignore' },
        )
        child.unref()
        pids.add(child.pid)
        stranger = child.pid
        // Said to start 2 s after the last look that saw the worker began: a
        // second past when the worker was last seen, but before that look
        // ended.
        writeFileSync(
          join(root, 'rewrite.json'),
          JSON.stringify({
            late: { [stranger]: { parent: worker, after: 2000 } },
          }),
        )
      },
    },
  )
  assert.equal(run.status, 0, run.reds)
  assert.ok(
    !gone(stranger),
    'a process started after its parent was last seen was claimed',
  )
  // Looks while the file ran and the check's own after it ended both saw it.
  const worker = String(run.note('worker'))
  const ending = Number(run.note('ending'))
  const saw = run.listed
    .filter(({ pids }) => pids.includes(worker))
    .map(({ start }) => start - ending)
  assert.ok(
    saw.some((at) => at < 0) && saw.some((at) => at > 0),
    `looks that saw the worker, from the file's end: ${saw.join(', ')} ms`,
  )
})

test('on Windows, a look that fails still stops a file past its time', {
  skip: off,
}, async (t) => {
  const run = await onWindows(
    t,
    {
      'tests/spin.test.mjs': noting(
        "note('worker', process.pid)\nfor (const end = Date.now() + 40000; Date.now() < end; );",
        '// ci: timeout 2 s (spins)',
      ),
    },
    { lookFails: true },
  )
  assert.ok(run.ms < 30000, `the check waited ${run.ms} ms`)
  // Not only the runner: the process running the file stops too.
  assert.ok(gone(run.note('worker')), 'the spinning file kept running')
  assert.match(
    run.reds,
    /^ci: 2 failing tests\n {2}node {2}tests\/spin\.test\.mjs {2}did not finish within 2 s: stopped, but what it started could not be checked\n {2}node {2}tests\/spin\.test\.mjs {2}did not stop what it started: could not verify cleanup: powershell\.exe exited 1$/,
  )
})

test('on Windows, an unreadable look is a red, and a late child of a live parent is owned', {
  skip: off,
}, async (t) => {
  const garbled = await onWindows(
    t,
    { 'tests/one.test.mjs': noting("note('one', 1)") },
    { garbled: true },
  )
  assert.equal(
    garbled.reds,
    'ci: 1 failing tests\n  node  tests/one.test.mjs  did not stop what it started: could not verify cleanup: powershell.exe gave an unreadable line: x\ty\tz\tw',
  )
  // A parent seen at many looks starts a child well after its first: the
  // child is still the file's.
  const late = await onWindows(t, {
    'tests/late.test.mjs': noting(
      "const parent = spawn(process.execPath, ['-e', \"setTimeout(() => { const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); require('node:fs').appendFileSync(process.env.NOTES, JSON.stringify({ key: 'child', value: child.pid }) + '\\\\n') }, 4500); setInterval(() => {}, 1000)\"], { detached: true, stdio: 'ignore' })\nparent.unref()\nnote('parent', parent.pid)\nawait new Promise((done) => setTimeout(done, 7000))",
    ),
  })
  assert.match(
    late.reds,
    /^ci: 1 failing tests\n {2}node {2}tests\/late\.test\.mjs {2}did not stop what it started: left node \d+, node \d+ running$/,
  )
  for (const key of ['parent', 'child']) assert.ok(gone(late.note(key)), key)
})
