// ci: alone (starts apps with a process of its own, and waits on real time)
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const runFile = (file, env) => {
  const { NODE_TEST_CONTEXT: _, ...parent } = process.env
  const started = performance.now()
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      './tests/file-limit.mjs',
      '--test',
      '--test-reporter=tap',
      file,
    ],
    { encoding: 'utf8', timeout: 120000, env: { ...parent, ...env } },
  )
  return { ...result, seconds: (performance.now() - started) / 1000 }
}
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('a file that never ends fails by name and lets the run go on', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hibi-file-limit-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, 'never.test.mjs')
  writeFileSync(
    file,
    `import test from 'node:test'
test('never', () => new Promise(() => setInterval(() => {}, 1000)))`,
  )
  const result = runFile(file, { CI_FILE_LIMIT_MS: '500' })
  assert.notEqual(result.status, 0)
  assert.ok(result.seconds < 60, `${result.seconds} s`)
  assert.match(
    result.stdout + result.stderr,
    /never\.test\.mjs did not finish within 0\.5 s/,
  )
})

test('a page that never answers can neither hold its close nor outlive its file', {
  timeout: 120000,
}, () => {
  const closes = runFile(resolve('tests/fixtures/hung-page.mjs'), {
    CI_FILE_LIMIT_MS: '90000',
    HUNG_PAGE_CLOSE: '1',
  })
  const closed = closes.stdout + closes.stderr
  assert.match(closed, /hung-page-detached/)
  assert.doesNotMatch(closed, /did not finish within/)
  assert.equal(alive(Number(/hung-page-app (\d+)/.exec(closed)[1])), false)
  const limited = runFile(resolve('tests/fixtures/hung-page.mjs'), {
    CI_FILE_LIMIT_MS: '4000',
  })
  const output = limited.stdout + limited.stderr
  assert.notEqual(limited.status, 0)
  assert.match(output, /hung-page\.mjs did not finish within 4 s/)
  const app = Number(/hung-page-app (\d+)/.exec(output)[1])
  assert.equal(alive(app), false, 'the app outlived its file')
})
