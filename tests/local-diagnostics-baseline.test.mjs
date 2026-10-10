import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import electron from 'electron'

test('native error branding and stack descriptor inspection do not invoke custom formatting', () => {
  const result = spawnSync(
    electron,
    [
      '-e',
      `let calls = 0;
       const error = new Error('private');
       Error.prepareStackTrace = () => { calls++; throw new Error('must not run'); };
       const descriptor = Object.getOwnPropertyDescriptor(error, 'stack');
       const proxy = new Proxy(error, { get() { throw 1 }, getOwnPropertyDescriptor() { throw 1 } });
       console.log(JSON.stringify({ calls, accessor: !!descriptor.get, proxy: Error.isError(proxy) }));`,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 10000,
    },
  )
  assert.equal(result.status, 0)
  assert.deepEqual(JSON.parse(result.stdout), {
    calls: 0,
    accessor: true,
    proxy: false,
  })
})

test('diagnostics must coexist with journal barriers and the existing recovery UI', () => {
  const preload = readFileSync(
    new URL('../src/preload/index.ts', import.meta.url),
    'utf8',
  )
  const recovery = readFileSync(
    new URL('../src/renderer/src/RecoveryScreen.tsx', import.meta.url),
    'utf8',
  )
  assert.match(preload, /journal\.hasPending\(\)/)
  assert.match(preload, /journal\.flush\(\)/)
  assert.match(recovery, /Save a copy/i)
  assert.match(recovery, /Reload/)
  assert.match(recovery, /componentDidCatch/)
})
