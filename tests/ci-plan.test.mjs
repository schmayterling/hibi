import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
    'tests/dev-reload.test.mjs': "import './electron.mjs'",
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

test('development reload checks follow tooling scope on linux and macos while full checks retain every platform', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hibi-ci-dev-reload-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const reload = 'tests/dev-reload.test.mjs'
  const production = 'tests/dev-bridge-production.test.mjs'
  const files = {
    'src/shared/one.ts': 'export const one = 1',
    'tests/electron.mjs': "import { _electron } from 'playwright'",
    [reload]:
      "import './electron.mjs'; import { spawn } from 'node:child_process'",
    [production]: "import { readFile } from 'node:fs/promises'",
  }
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), source)
  }
  execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' })
  execFileSync(
    'git',
    ['add', reload, production, 'tests/electron.mjs', 'src/shared/one.ts'],
    {
      cwd: root,
      stdio: 'pipe',
    },
  )
  const previousTests = [production, reload]
  const plan = (changed, options = {}) =>
    planChecks(root, { changed, previousTests, ...options })
  const tooling = [
    'scripts/dev.mjs',
    'scripts/dev-preview.mjs',
    'electron.vite.config.ts',
    'electron.vite.config.mjs',
    'scripts/addon-development.ts',
    'scripts/addon-packages.ts',
    'scripts/patch-electron-vite.mjs',
    'scripts/resolve-own.mjs',
    'scripts/electron-runtime.mjs',
    'scripts/build-site.mjs',
    'scripts/docs.mjs',
    'scripts/addon-reference.mjs',
    'src/main/addon-development.ts',
    'src/renderer/src/addon-development.ts',
    'src/renderer/src/addon-reload.ts',
    'src/shared/addon-development.ts',
    reload,
  ]
  for (const platform of ['linux', 'darwin', 'win32']) {
    for (const changed of [
      [],
      ['src/shared/one.ts'],
      ['src/main/index.ts'],
      ['src/preload/index.ts'],
      ['src/renderer/src/addons.ts'],
      ['src/renderer/src/addon-registry.ts'],
      ['src/addons/typing-speed/index.ts'],
      ['scripts/benchmark-startup.mjs'],
      ['scripts/development/other.mjs'],
      ['docs/guides/editing.md'],
    ]) {
      const result = plan(changed, { platform })
      assert.equal(result.full, false)
      assert.ok(!result.tests.includes(reload), `${platform}: ${changed}`)
    }
    const app = plan(['src/shared/one.ts'], { platform })
    assert.ok(app.tests.includes(production))
    assert.ok(app.unitTests.includes(production))
    for (const file of tooling) {
      const result = plan([file], { platform })
      if (!file.startsWith('electron.vite.config.'))
        assert.equal(result.full, false)
      assert.equal(
        result.tests.includes(reload),
        result.full || platform !== 'win32',
        `${platform}: ${file}`,
      )
    }
    for (const options of [
      { force: true },
      { previousTests: undefined },
      { outputAvailable: false },
      { changed: undefined },
      { changed: ['scripts/ci.mjs'] },
      { changed: ['package.json'] },
      { changed: ['package-lock.json'] },
      { changed: ['.github/actions/ci/action.yml'] },
      { changed: ['.github/actions/ci/install.mjs'] },
    ]) {
      const result = plan(['src/shared/one.ts'], { platform, ...options })
      assert.equal(result.full, true)
      assert.ok(result.tests.includes(reload))
    }
    assert.equal(
      plan(['src/shared/one.ts'], {
        platform,
        previousTests: [production],
      }).tests.includes(reload),
      false,
    )
    assert.equal(
      plan(['scripts/dev.mjs'], {
        platform,
        previousTests: [production],
      }).tests.includes(reload),
      platform !== 'win32',
    )
  }
  const untracked = 'scripts/dev-untracked.mjs'
  mkdirSync(join(root, 'scripts'), { recursive: true })
  writeFileSync(join(root, untracked), 'export default true')
  assert.ok(plan([], { platform: 'linux' }).tests.includes(reload))
  assert.ok(!plan([], { platform: 'win32' }).tests.includes(reload))
})
