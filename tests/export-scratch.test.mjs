import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createSiteScratch,
  sweepSiteScratch,
} from '../src/main/export-scratch.ts'

test('startup and next export remove only the owning profile scratch', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-export-scratch-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const first = join(root, 'first')
  const second = join(root, 'second')
  const abandoned = await createSiteScratch(first)
  await writeFile(join(abandoned, 'pages.jsonl'), 'PRIVATE-DRAFT')
  await writeFile(join(abandoned, 'media'), 'PRIVATE-MEDIA')
  const running = await createSiteScratch(second)
  await mkdir(join(first, 'site-exports', 'keep'))
  await symlink(
    running,
    join(first, 'site-exports', 'hibi-site-link'),
    'junction',
  )
  await Promise.all([sweepSiteScratch(first), sweepSiteScratch(first)])
  assert.deepEqual((await readdir(join(first, 'site-exports'))).sort(), [
    'hibi-site-link',
    'keep',
  ])
  assert.deepEqual(await readdir(running), [])
  const next = await createSiteScratch(first)
  await writeFile(join(next, 'pages.jsonl'), 'PRIVATE-DRAFT')
  const latest = await createSiteScratch(first)
  assert.notEqual(latest, next)
  await assert.rejects(readdir(next), /ENOENT/)
  assert.deepEqual(await readdir(running), [])
  const linkedProfile = join(root, 'linked')
  await mkdir(linkedProfile)
  await symlink(
    join(first, 'site-exports'),
    join(linkedProfile, 'site-exports'),
    'junction',
  )
  await assert.rejects(sweepSiteScratch(linkedProfile))
})
