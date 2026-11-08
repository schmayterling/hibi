import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Only hand-written fixtures under this directory may be executed by tests. */
export async function readFixturePlugin(id) {
  assert.match(id, /^[a-z0-9-]+$/)
  const folder = new URL(`./fixtures/plugins/${id}/`, import.meta.url)
  return {
    manifest: JSON.parse(
      await readFile(new URL('manifest.json', folder), 'utf8'),
    ),
    main: await readFile(new URL('main.js', folder), 'utf8'),
  }
}

export async function fixtureVault(t, id = 'host-smoke') {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'hibi-obsidian-host-')),
  )
  t.after(() => rm(root, { recursive: true, force: true }))
  const vault = join(root, 'vault')
  const overlay = join(root, 'profile')
  const plugin = await readFixturePlugin(id)
  const folder = join(vault, '.obsidian', 'plugins', id)
  await mkdir(folder, { recursive: true })
  await mkdir(overlay)
  await writeFile(
    join(folder, 'manifest.json'),
    JSON.stringify(plugin.manifest),
  )
  await writeFile(join(folder, 'main.js'), plugin.main)
  await writeFile(
    join(folder, 'data.json'),
    '{"enabled":false,"seeded":true}\r\n',
  )
  await writeFile(
    join(vault, 'untouched.md'),
    '\ufeff# Keep\r\n\r\nUntouched  \r\n',
  )
  const before = await snapshot(vault)
  return {
    root,
    vault,
    overlay,
    folder,
    plugin,
    assertUnchanged: async () =>
      assert.deepEqual(await snapshot(vault), before),
  }
}

async function snapshot(root, prefix = '') {
  const result = {}
  for (const entry of await readdir(join(root, prefix), {
    withFileTypes: true,
  })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) Object.assign(result, await snapshot(root, path))
    else result[path] = (await readFile(join(root, path))).toString('hex')
  }
  return result
}
