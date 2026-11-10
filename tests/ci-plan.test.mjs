import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { planChecks, shardTests, testWorkers } from '../scripts/ci.mjs'

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
  write('tests/spawns.test.mjs', "import 'node:child_process'\n")
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
  write('scripts/tool.mjs', '// a script the app build runs\n'.repeat(4))
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
const spawnSync = process.spawnSync
process.spawnSync = (command, args, options) => {
  const fault = globalThis.process.env.FAULT
  if (!args.includes('tests/unit.test.mjs')) return spawnSync(command, args, options)
  if (fault === 'spawn') return { error: new Error('spawnSync ENOMEM'), status: null, signal: null }
  if (fault === 'throw') throw new Error('EPERM, operation not permitted')
  const result = spawnSync(command, args, options)
  const report = args.find((arg) => arg.startsWith('--test-reporter-destination=') && !arg.endsWith('=stdout')).slice(28)
  if (fault === 'missing') rmSync(report)
  if (fault === 'torn') appendFileSync(report, '{"name":')
  if (fault === 'cut') writeFileSync(report, '')
  if (fault === 'null') writeFileSync(report, 'null\\n')
  // Loses the failure line, keeps the count that names it.
  if (fault === 'dropped') writeFileSync(report, readFileSync(report, 'utf8').split('\\n').slice(1).join('\\n'))
  if (fault === 'killed') return { ...result, status: null, signal: 'SIGTERM' }
  return result
}
syncBuiltinESMExports()
`,
  )
  const files = {
    '.gitignore': 'out/\n.cache/\n',
    'tests/file-limit.mjs': '',
    'tests/electron.mjs': "export const later = () => import('playwright')",
    'tests/unit.test.mjs': `import { appendFileSync } from 'node:fs'\nimport test from 'node:test'\ntest('unit', () => {\n  appendFileSync(process.env.RAN, 'unit ')\n  if (process.env.RED) throw new Error('red')\n})\ntest.todo('later', () => {\n  throw new Error('not yet')\n})\n`,
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
  const check = (fault, red = '') => {
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
          FAULT: fault,
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
      /^ci: 1 failing tests\n {2}unit {4}exited early with no failing test reported: spawnSync ENOMEM; its report did not finish; 1 test files$/,
    ],
    throw: [
      ['app'],
      /^ci: 1 failing tests\n {2}unit {4}exited early with no failing test reported: EPERM, operation not permitted; its report did not finish; 1 test files$/,
    ],
    null: [
      ['app', 'unit'],
      /^ci: 1 failing tests\n {2}unit {4}did not finish: its report did not finish; 1 unreadable report lines; 1 test files$/,
    ],
    missing: [
      ['app', 'unit'],
      /^ci: 1 failing tests\n {2}unit {4}did not finish: its report did not finish; 1 test files$/,
    ],
    cut: [
      ['app', 'unit'],
      /^ci: 1 failing tests\n {2}unit {4}did not finish: its report did not finish; 1 test files$/,
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
      `^ci: 2 failing tests\\n {2}unit {2}${line.source} {2}unit: red\\n {2}unit {4}did not finish: 1 unreadable report lines; 1 test files$`,
    ),
  )
  const dropped = check('dropped', 'red')
  assert.equal(dropped.status, 1)
  assert.match(
    dropped.reds,
    /^ci: 1 failing tests\n {2}unit {4}exited 1 with no failing test reported: its report counted 1 failures but held 0; 1 test files$/,
  )
  const killed = check('killed', 'red')
  assert.equal(killed.status, 1)
  assert.deepEqual(killed.ran, ['app', 'unit'])
  assert.match(
    killed.reds,
    new RegExp(
      `^ci: 2 failing tests\\n {2}unit {2}${line.source} {2}unit: red\\n {2}unit {4}did not finish: killed by SIGTERM; 1 test files$`,
    ),
  )
})
