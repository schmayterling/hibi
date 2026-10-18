import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { stopElectronTree } from './electron.mjs'

test('closed windows discard visibility listeners without changing live pages', {
  timeout: 30000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-window-visibility-'))
  const output = join(root, 'visibility.json')
  const env = {
    ...process.env,
    HIBI_TEST_WINDOW_VISIBILITY_RESULT: output,
    HIBI_TEST_ADDON_REVOCATIONS_URL: new URL(
      './fixtures/no-addon-revocations.json',
      import.meta.url,
    ).href,
  }
  delete env.ELECTRON_RENDERER_URL
  const child = spawn(
    createRequire(import.meta.url)('electron'),
    [
      '--require',
      fileURLToPath(
        new URL('./fixtures/window-visibility.cjs', import.meta.url),
      ),
      resolve('.'),
      '--hibi-test',
      `--user-data-dir=${join(root, 'profile')}`,
      ...(process.platform === 'linux'
        ? ['--use-gl=angle', '--use-angle=swiftshader']
        : []),
    ],
    {
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const closed = once(child, 'close')
  let stderr = ''
  child.stdout.resume()
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-8192)
  })
  t.signal.addEventListener('abort', () => stopElectronTree(child), {
    once: true,
  })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null)
      stopElectronTree(child)
    await closed
    await rm(root, { recursive: true, force: true })
  })
  await closed
  assert.equal(child.exitCode, 0, stderr)
  const result = JSON.parse(await readFile(output, 'utf8'))
  assert.equal(result.error, undefined, result.error)
  assert.deepEqual(result.modals, [])
  assert.equal(result.late.length, 5)
  for (const row of result.late)
    await t.test(`late ${row.event} after destruction`, () => {
      assert.equal(row.destroyed, true)
      assert.equal(row.error, null)
    })
  await t.test(
    'native macOS page visibility still follows live windows',
    {
      skip: process.platform !== 'darwin',
    },
    () => {
      assert.equal(result.visibility.length, 5)
      for (const row of result.visibility) {
        assert.equal(row.sawEvent, true, row.operation)
        assert.equal(row.state, row.expected, row.operation)
      }
    },
  )
})
