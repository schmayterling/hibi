import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

test('editing awaits required addon startup and disabled pending addons cannot register late commands', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-addon-readiness-'))
  for (const id of ['delayed-editor', 'delayed-background']) {
    const directory = join(profile, 'installed-addons', id)
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'hibi-addon.json'),
      JSON.stringify({
        id,
        name: id,
        description: 'Readiness fixture',
        kind: 'extension',
        apiVersion: 1,
        version: '1.0.0',
        authors: [{ displayName: 'Test' }],
        entry: 'index.js',
        ...(id.endsWith('background') ? { startup: 'background' } : {}),
      }),
    )
    await writeFile(
      join(directory, '.hibi-install.json'),
      JSON.stringify({
        hash: 'a'.repeat(64),
        files: ['index.js', 'hibi-addon.json'],
        source: 'local',
      }),
    )
    await writeFile(
      join(directory, 'index.js'),
      `export default () => ({async start(context) {
      document.documentElement.setAttribute('data-${id}', 'waiting');
      await new Promise(resolve => window.addEventListener('release-${id}', resolve, {once:true}));
      context.commands.register({id:'late',label:'After ${id}',run() {}});
      document.documentElement.setAttribute('data-${id}', 'settled');
    }});`,
    )
  }
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'delayed-editor': true, 'delayed-background': true }),
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
  await page.waitForFunction(
    () =>
      document.documentElement.getAttribute('data-delayed-editor') ===
      'waiting',
  )
  assert.equal(await page.locator('.titlebar').isVisible(), true)
  assert.equal(await page.locator('.tiptap').count(), 0)
  await page.evaluate(() =>
    window.dispatchEvent(new Event('release-delayed-editor')),
  )
  const editor = page.getByRole('textbox', {
    name: 'Document editor',
    exact: true,
  })
  await editor.waitFor()
  await editor.fill('Preserve these edits')
  await page.waitForFunction(
    () =>
      document.documentElement.getAttribute('data-delayed-background') ===
      'waiting',
  )
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  await page.locator('#addon-delayed-background').click()
  await page.waitForFunction(
    () =>
      document.querySelector('#addon-delayed-background')?.checked === false,
  )
  await page.evaluate(() =>
    window.dispatchEvent(new Event('release-delayed-background')),
  )
  await page.waitForFunction(
    () =>
      document.documentElement.getAttribute('data-delayed-background') ===
      'settled',
  )
  await clickMenu(app, 'Command palette')
  await page
    .getByRole('combobox', { name: /search commands/i })
    .fill('After delayed-background')
  assert.equal(
    await page
      .getByRole('option', { name: /After delayed-background/i })
      .count(),
    0,
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'Preserve these edits',
  )
})
