import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
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
import { planChecks, shardTests } from '../scripts/ci.mjs'

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
        CALLS: calls,
        CI_BASE: base,
        CI_CLEAN: '',
        CI_FULL: '',
        CI_SHARD: '0/1',
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
