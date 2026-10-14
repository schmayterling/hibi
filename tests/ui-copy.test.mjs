import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

test('UI copy includes notification calls and error and notice records', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hibi-ui-copy-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await mkdir(join(directory, 'src'))
  await writeFile(
    join(directory, 'src', 'fixture.ts'),
    [
      "context.notify('Notification text.')",
      "context.notify(ok ? 'Success text.' : 'Failure text.')",
      "contexts.get(key)?.notify('Optional notification.')",
      "const state = { error: invalid ? 'Invalid value.' : '', notice: 'Saved value.' }",
      "const internal = { path: 'private path', id: 'private-id', color: 'status-danger' }",
      "export const HISTORY_CHANNELS = { notice: 'document:notice' } as const",
    ].join('\n'),
  )
  await promisify(execFile)(
    process.execPath,
    [resolve('scripts/ui-copy.mjs')],
    {
      cwd: directory,
    },
  )
  const catalog = JSON.parse(
    await readFile(join(directory, 'locales', 'en.json'), 'utf8'),
  )
  assert.deepEqual(Object.values(catalog).sort(), [
    'Failure text.',
    'Invalid value.',
    'Notification text.',
    'Optional notification.',
    'Saved value.',
    'Success text.',
  ])
})
