import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'

test('installed addon reads one user-selected text grant', {
  timeout: 45000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-selected-bridge-'))
  const folder = join(profile, 'installed-addons', 'selected-probe')
  await mkdir(folder, { recursive: true })
  const file = join(await realpath(profile), 'selected.txt')
  await writeFile(file, 'selected content\n')
  await writeFile(
    join(folder, 'hibi-addon.json'),
    JSON.stringify({
      id: 'selected-probe',
      name: 'Selected probe',
      description: 'Selected text bridge test addon.',
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
        window.selectedProbe = {
          select: () => context.host.selectedText.select(),
          read: handle => context.host.selectedText.read(handle),
        }
      },
      stop() { delete window.selectedProbe },
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
    JSON.stringify({ 'selected-probe': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [selected],
    })
  }, file)
  const page = await app.firstWindow()
  await page.waitForFunction(() => !!window.selectedProbe)
  const selection = await page.evaluate(() => window.selectedProbe.select())
  assert.equal(selection.ok, true)
  assert.equal(typeof selection.value.handle, 'string')
  assert.equal(selection.value.handle.includes(file), false)
  assert.deepEqual(
    await page.evaluate(
      (handle) => window.selectedProbe.read(handle),
      selection.value.handle,
    ),
    { ok: true, value: 'selected content\n' },
  )
  assert.equal(
    (
      await page.evaluate(
        (handle) => window.selectedProbe.read(handle),
        selection.value.handle,
      )
    ).code,
    'not-found',
  )
  const pending = await page.evaluate(() => window.selectedProbe.select())
  assert.equal(pending.ok, true)
  await page.evaluate(() =>
    window.hibi.setAddonEnabled('selected-probe', false),
  )
  assert.equal(
    (
      await page.evaluate(
        (handle) => window.selectedProbe.read(handle),
        pending.value.handle,
      )
    ).ok,
    false,
  )
})
