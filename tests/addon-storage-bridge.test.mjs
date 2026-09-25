import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'

test('addon storage bridge retains global values and clears sessions on disable', {
  timeout: 45000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-storage-bridge-'))
  const folder = join(profile, 'installed-addons', 'storage-probe')
  await mkdir(folder, { recursive: true })
  await writeFile(
    join(folder, 'hibi-addon.json'),
    JSON.stringify({
      id: 'storage-probe',
      name: 'Storage probe',
      description: 'Storage bridge test addon.',
      kind: 'extension',
      apiVersion: 2,
      version: '1.0.0',
      defaultEnabled: true,
      startup: 'background',
      capabilities: [],
      authors: [{ displayName: 'Test' }],
      entry: 'index.js',
    }),
  )
  await writeFile(
    join(folder, 'index.js'),
    `export default () => ({
    start(context) {
      const global = () => context.storage.global('value', 1)
      const session = () => context.storage.session('value', 1)
      window.storageProbe = {
        readGlobal: async () => (await global()).snapshot(),
        setGlobal: async value => (await global()).set(value),
        readSession: async () => (await session()).snapshot(),
        setSession: async value => (await session()).set(value),
      }
    },
    stop() { delete window.storageProbe },
  })`,
  )
  await writeFile(
    join(folder, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['hibi-addon.json', 'index.js'],
      source: 'local',
    }),
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'storage-probe': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(8000)
  await page.waitForFunction(() => !!window.storageProbe)
  assert.deepEqual(
    await page.evaluate(() => window.storageProbe.readGlobal()),
    {
      status: 'missing',
      revision: 0,
    },
  )
  assert.deepEqual(
    await page.evaluate(() => window.storageProbe.setGlobal('retained')),
    {
      status: 'saved',
      revision: 1,
      value: 'retained',
    },
  )
  assert.equal(
    (await page.evaluate(() => window.storageProbe.setSession('temporary')))
      .status,
    'saved',
  )
  await assert.rejects(
    page.evaluate(() => window.hibi.readAddonStorage(null)),
    /Invalid addon storage request/,
  )

  await page.evaluate(() => window.hibi.setAddonEnabled('storage-probe', false))
  await page.reload()
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  assert.equal(await page.evaluate(() => !!window.storageProbe), false)
  await assert.rejects(
    page.evaluate(() =>
      window.hibi.readAddonStorage({
        owner: 'storage-probe',
        scope: { kind: 'global' },
        key: 'value',
        version: 1,
      }),
    ),
    /Enable this addon/,
  )
  await page.evaluate(() => window.hibi.setAddonEnabled('storage-probe', true))
  await page.reload()
  await page.waitForFunction(() => !!window.storageProbe)
  assert.deepEqual(
    await page.evaluate(() => window.storageProbe.readGlobal()),
    {
      status: 'ready',
      revision: 1,
      value: 'retained',
    },
  )
  assert.deepEqual(
    await page.evaluate(() => window.storageProbe.readSession()),
    {
      status: 'missing',
      revision: 0,
    },
  )
  assert.equal(
    JSON.parse(
      await readFile(
        join(profile, 'addon-storage', 'global', 'storage-probe.json'),
        'utf8',
      ),
    ).entries.value.value,
    'retained',
  )
})
