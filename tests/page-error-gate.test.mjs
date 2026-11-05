import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const fixture = 'tests/fixtures/page-error-gate.test.js'
const run = (scenario) => {
  // Under this variable, a child node runs no tests of its own.
  const { NODE_TEST_CONTEXT: _, ...env } = process.env
  const { status, stdout } = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=tap', fixture],
    {
      encoding: 'utf8',
      env: { ...env, PAGE_ERROR_CASE: scenario },
      // A failed check that skips closing the app would hang the file.
      timeout: 45000,
    },
  )
  return { status, stdout }
}

for (const [scenario, message] of [
  ['unexpected', /unexpected renderer errors:[\s\S]*gate boom/],
  ['other allowed', /unexpected renderer errors:[\s\S]*gate boom/],
  ['never thrown', /no renderer error matched \/never thrown\//],
  ['widget', /unexpected renderer errors:[\s\S]*widget:.*gate boom/],
  ['plugin', /unexpected renderer errors:[\s\S]*plugin crashed:.*gate boom/],
  ['measure', /unexpected renderer errors:[\s\S]*editor exception:.*gate boom/],
])
  test(`a test fails on a renderer error: ${scenario}`, {
    timeout: 60000,
  }, () => {
    const { status, stdout } = run(scenario)
    assert.equal(status, 1, stdout)
    assert.match(stdout, message)
  })

test('an error left for the last root hook fails the file and skips no later hook', {
  timeout: 60000,
}, () => {
  const { status, stdout } = run('after the last test')
  assert.equal(status, 1, stdout)
  assert.doesNotMatch(stdout, /^not ok 1 - a renderer throw/m)
  assert.match(stdout, /unexpected renderer errors:[\s\S]*gate boom/)
  assert.match(stdout, /later hook ran/)
})

for (const scenario of ['allowed', 'widget allowed'])
  test(`a test passes on a renderer error it expects: ${scenario}`, {
    timeout: 60000,
  }, () => {
    const { status, stdout } = run(scenario)
    assert.equal(status, 0, stdout)
  })
