import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

test('native workspace headers reject entries access while explicit snapshots retain it', async (t) => {
  await mkdir('out', { recursive: true })
  const directory = await mkdtemp(resolve('out/workspace-types-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const source = join(directory, 'consumer.ts')
  await writeFile(
    source,
    `
    import { getWorkspace } from '../../src/main/workspace.ts'
    import type { WorkspaceState } from '../../src/shared/workspace.ts'
    const header = getWorkspace()
    if (header) {
      header.name.toLowerCase()
      // @ts-expect-error native headers do not expose tree entries
      header.entries
    }
    const explicitHeader = getWorkspace(undefined, false)
    // @ts-expect-error explicit headers do not expose tree entries
    explicitHeader?.entries
    const full: WorkspaceState | null = getWorkspace(undefined, true)
    full?.entries.map(entry => entry.path)
  `,
  )
  const config = join(directory, 'tsconfig.json')
  await writeFile(
    config,
    JSON.stringify({
      extends: '../../tsconfig.node.json',
      files: [source],
    }),
  )
  const result = await promisify(execFile)(process.execPath, [
    resolve('node_modules/typescript/bin/tsc'),
    '--noEmit',
    '-p',
    config,
  ]).catch((error) => error)
  assert.equal(result.code, undefined, result.stdout || result.stderr)
})
