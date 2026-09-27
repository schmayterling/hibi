import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'

test('installed addon imports and exports only selected files', {
  timeout: 45000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-selected-io-bridge-'))
  const folder = join(profile, 'installed-addons', 'selected-io-probe')
  await mkdir(folder, { recursive: true })
  const directory = await realpath(profile)
  const input = join(directory, 'input.bin')
  const output = join(directory, 'output.bin')
  await writeFile(input, Buffer.from([0, 1, 2, 255]))
  await writeFile(
    join(folder, 'hibi-addon.json'),
    JSON.stringify({
      id: 'selected-io-probe',
      name: 'Selected IO probe',
      description: 'Selected file bridge test addon.',
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
        window.selectedIoProbe = context.host.selectedIo
      },
      stop() { delete window.selectedIoProbe },
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
    JSON.stringify({ 'selected-io-probe': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  await app.evaluate(
    ({ dialog }, paths) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [paths.input],
      })
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: paths.output,
      })
    },
    { input, output },
  )
  const page = await app.firstWindow()
  await page.waitForFunction(() => !!window.selectedIoProbe)

  const selectedImport = await page.evaluate(() =>
    window.selectedIoProbe.selectImport({ extensions: ['bin'] }),
  )
  assert.equal(selectedImport.ok, true)
  assert.equal(selectedImport.value.name, 'input.bin')
  assert.equal(selectedImport.value.handle.includes(directory), false)
  assert.deepEqual(
    await page.evaluate(async (handle) => {
      const result = await window.selectedIoProbe.readImport(handle)
      return result.ok ? Array.from(result.value) : result
    }, selectedImport.value.handle),
    [0, 1, 2, 255],
  )
  assert.equal(
    (
      await page.evaluate(
        (handle) => window.selectedIoProbe.readImport(handle),
        selectedImport.value.handle,
      )
    ).code,
    'not-found',
  )

  const selectedExport = await page.evaluate(() =>
    window.selectedIoProbe.selectExport({
      suggestedName: 'output.bin',
      extension: 'bin',
    }),
  )
  assert.equal(selectedExport.ok, true)
  assert.equal(selectedExport.value.name, 'output.bin')
  const written = await page.evaluate(
    (handle) =>
      window.selectedIoProbe.writeExport(handle, new Uint8Array([9, 0, 255])),
    selectedExport.value.handle,
  )
  assert.equal(written.ok, true)
  assert.equal(written.value.bytes, 3)
  assert.equal(written.value.atomicVisibility, true)
  assert.equal(typeof written.value.directorySynced, 'boolean')
  assert.deepEqual(await readFile(output), Buffer.from([9, 0, 255]))
  assert.equal(
    (
      await page.evaluate(
        (handle) =>
          window.selectedIoProbe.writeExport(handle, new Uint8Array([1])),
        selectedExport.value.handle,
      )
    ).code,
    'not-found',
  )
  assert.equal(
    (
      await page.evaluate(() =>
        window.selectedIoProbe.selectExport({ suggestedName: 'output.bin' }),
      )
    ).code,
    'conflict',
  )
  assert.deepEqual(await readFile(output), Buffer.from([9, 0, 255]))

  const pending = await page.evaluate(() =>
    window.selectedIoProbe.selectImport(),
  )
  assert.equal(pending.ok, true)
  await page.evaluate(() =>
    window.hibi.setAddonEnabled('selected-io-probe', false),
  )
  assert.equal(
    (
      await page.evaluate(
        (handle) => window.hibi.readHostImport('selected-io-probe', handle),
        pending.value.handle,
      )
    ).code,
    'not-found',
  )
})
