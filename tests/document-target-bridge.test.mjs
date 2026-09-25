import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

test('installed addon edits an inactive document without changing focus', {
  timeout: 45000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-target-bridge-'))
  const folder = join(profile, 'installed-addons', 'target-probe')
  await mkdir(folder, { recursive: true })
  const first = join(profile, 'first.md')
  const second = join(profile, 'second.md')
  await writeFile(first, '# one')
  await writeFile(second, '# two')
  await writeFile(
    join(folder, 'hibi-addon.json'),
    JSON.stringify({
      id: 'target-probe',
      name: 'Target probe',
      description: 'Document target bridge test addon.',
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
        window.targetProbe = {
          list: () => context.documents.listOpen(),
          read: target => context.documents.readSource(target),
          edit: request => context.documents.applyEdits(request),
        }
      },
      stop() { delete window.targetProbe },
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
    JSON.stringify({ 'target-probe': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await page.waitForFunction(() => !!window.targetProbe)
  async function open(file) {
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selected],
      })
    }, file)
    await clickMenu(app, 'Open…')
  }
  await open(first)
  await page.waitForFunction(() =>
    window.targetProbe.list().some(({ name }) => name === 'first.md'),
  )
  const firstTarget = await page.evaluate(
    () =>
      window.targetProbe.list().find(({ name }) => name === 'first.md').target,
  )
  await open(second)
  await page.waitForFunction(() =>
    window.targetProbe.list().some(({ name }) => name === 'second.md'),
  )
  const source = await page.evaluate(
    (target) => window.targetProbe.read(target),
    firstTarget,
  )
  assert.equal(source.status, 'read')
  assert.equal(source.source, '# one')
  const result = await page.evaluate(
    (target) =>
      window.targetProbe.edit({
        requestId: 'inactive-first',
        target,
        changes: [{ from: 2, to: 5, expectedText: 'one', insert: 'ONE' }],
      }),
    source.target,
  )
  assert.equal(result.status, 'applied')
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).name,
    'second.md',
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    '# two',
  )
  await page.getByRole('tab', { name: 'first.md' }).click()
  await page.waitForFunction(
    async () => (await window.hibi.getDocument()).markdown === '# ONE',
  )
})
