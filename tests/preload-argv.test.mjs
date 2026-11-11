import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const dropPreload = createRequire(import.meta.url)(
  './fixtures/preload-argv.cjs',
)

async function fixture(t) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'hibi-preload-argv-')),
  )
  t.after(() => rm(root, { recursive: true, force: true }))
  const checkout = join(root, 'checkout')
  await mkdir(join(checkout, 'tests', 'fixtures'), { recursive: true })
  const file = join(checkout, 'tests', 'fixtures', 'x.cjs')
  await writeFile(file, '')
  return { root, checkout, file }
}

test('a preload fixture removes only its own -r pair', async (t) => {
  const { file, checkout } = await fixture(t)
  assert.deepEqual(
    dropPreload(['electron', '-r', file, checkout, '--user-data-dir=/p'], file),
    ['electron', checkout, '--user-data-dir=/p'],
  )
})

test('a preload path through a symlinked checkout still removes its pair', async (t) => {
  const { file, root, checkout } = await fixture(t)
  const link = join(root, 'link')
  await symlink(checkout, link)
  const linked = join(link, 'tests', 'fixtures', 'x.cjs')
  assert.deepEqual(
    dropPreload(['electron', '-r', linked, link, '--hibi-test'], file),
    ['electron', link, '--hibi-test'],
  )
})

test('a -r path to another file, or the file without -r, leaves every argument in place', async (t) => {
  const { file, checkout } = await fixture(t)
  const other = join(checkout, 'tests', 'fixtures', 'other.cjs')
  await writeFile(other, '')
  for (const argv of [
    ['electron', '-r', other, checkout, '--hibi-test'],
    ['electron', '-r', '/missing/x.cjs', checkout, '--hibi-test'],
    ['electron', checkout, file],
  ])
    assert.deepEqual(dropPreload([...argv], file), argv)
})
