import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const dropPreload = createRequire(import.meta.url)(
  './fixtures/preload-argv.cjs',
)

test('a preload fixture removes only its own -r pair', () => {
  assert.deepEqual(
    dropPreload(
      [
        'electron',
        '-r',
        '/wt/tests/fixtures/x.cjs',
        '/wt',
        '--user-data-dir=/p',
      ],
      '/wt/tests/fixtures/x.cjs',
    ),
    ['electron', '/wt', '--user-data-dir=/p'],
  )
})

test('a preload path written differently leaves every argument in place', () => {
  const argv = [
    'electron',
    '-r',
    '/link/tests/fixtures/x.cjs',
    '/wt',
    '--hibi-test',
  ]
  assert.deepEqual(dropPreload([...argv], '/wt/tests/fixtures/x.cjs'), argv)
  // A match not preceded by -r is an argument the app should still see.
  const opened = ['electron', '/wt', '/wt/tests/fixtures/x.cjs']
  assert.deepEqual(dropPreload([...opened], '/wt/tests/fixtures/x.cjs'), opened)
})
