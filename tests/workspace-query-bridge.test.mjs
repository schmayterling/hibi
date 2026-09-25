import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'

test('installed addon queries workspace metadata through scoped bridge', {
  timeout: 45000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-query-bridge-'))
  const workspace = join(profile, 'notes')
  const folder = join(profile, 'installed-addons', 'query-probe')
  await mkdir(workspace)
  await mkdir(folder, { recursive: true })
  await writeFile(
    join(workspace, 'a.md'),
    '---\nstatus: done\n---\n# Alpha\n\n[Bravo](b.md)\n\n#topic\n',
  )
  await writeFile(join(workspace, 'b.md'), '# Bravo\n')
  await writeFile(
    join(folder, 'hibi-addon.json'),
    JSON.stringify({
      id: 'query-probe',
      name: 'Query probe',
      description: 'Workspace query bridge test addon.',
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
        window.queryProbe = {
          snapshot: () => context.workspace.changeSnapshot(),
          query: request => context.workspace.query(request),
        }
      },
      stop() { delete window.queryProbe },
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
    JSON.stringify({ 'query-probe': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, workspace)
  const page = await app.firstWindow()
  await page.waitForFunction(() => !!window.queryProbe)
  await page.evaluate(() => window.hibi.openWorkspace())
  const snapshot = await page.evaluate(() => window.queryProbe.snapshot())
  assert.ok(snapshot.target)
  const target = snapshot.target
  const links = await page.evaluate(
    (captured) =>
      window.queryProbe.query({
        target: captured,
        kind: 'links',
        path: 'a.md',
      }),
    target,
  )
  assert.equal(links.ok, true)
  assert.deepEqual(links.value.items, ['b.md'])
  const tags = await page.evaluate(
    (captured) =>
      window.queryProbe.query({ target: captured, kind: 'tag', tag: 'topic' }),
    target,
  )
  assert.equal(tags.ok, true)
  assert.deepEqual(tags.value.items, ['a.md'])
  const property = await page.evaluate(
    (captured) =>
      window.queryProbe.query({
        target: captured,
        kind: 'property',
        key: 'status',
        value: 'done',
      }),
    target,
  )
  assert.equal(property.ok, true)
  assert.deepEqual(property.value.items, ['a.md'])
  const text = await page.evaluate(
    (captured) =>
      window.queryProbe.query({
        target: captured,
        kind: 'search-text',
        query: 'Alpha',
      }),
    target,
  )
  assert.equal(text.ok, true)
  assert.deepEqual(text.value.items, ['a.md'])
})
