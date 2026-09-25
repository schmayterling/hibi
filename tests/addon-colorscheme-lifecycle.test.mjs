import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

test('addon colorscheme subscriptions stop with their owner', async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-addon-colorscheme-'))
  for (const [id, source] of [
    [
      'color-control',
      `export default () => ({ start(context) {
        window.setAddonColor = mode => context.colorschemes.setPreferences({ mode });
      } });`,
    ],
    [
      'color-watch',
      `export default () => ({ start(context) {
        window.colorWatchStarts = (window.colorWatchStarts || 0) + 1;
        context.colorschemes.subscribe(() => {
          window.colorWatchCalls = (window.colorWatchCalls || 0) + 1;
        });
      }, stop() {
        window.colorWatchStops = (window.colorWatchStops || 0) + 1;
      } });`,
    ],
  ]) {
    const folder = join(profile, 'installed-addons', id)
    await mkdir(folder, { recursive: true })
    await writeFile(
      join(folder, 'hibi-addon.json'),
      JSON.stringify({
        id,
        name: id,
        description: 'Colorscheme lifecycle fixture',
        kind: 'extension',
        apiVersion: 2,
        version: '1.0.0',
        authors: [{ displayName: 'Test' }],
        entry: 'index.js',
        capabilities: [],
        startup: 'background',
      }),
    )
    await writeFile(join(folder, 'index.js'), source)
    await writeFile(
      join(folder, '.hibi-install.json'),
      JSON.stringify({
        hash: 'a'.repeat(64),
        files: ['hibi-addon.json', 'index.js'],
        source: 'local',
      }),
    )
  }
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'color-control': true, 'color-watch': true }),
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
    () => window.colorWatchStarts === 1 && !!window.setAddonColor,
  )
  await page.evaluate(() => window.setAddonColor('light'))
  const before = await page.evaluate(() => window.colorWatchCalls)
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  const enabled = page.locator('#addon-color-watch')
  await enabled.click()
  await page.waitForFunction(() => window.colorWatchStops === 1)
  await page.evaluate(() => window.setAddonColor('dark'))
  assert.equal(await page.evaluate(() => window.colorWatchCalls), before)

  await enabled.click()
  await page.waitForFunction(() => window.colorWatchStarts === 2)
  await page.evaluate(() => window.setAddonColor('light'))
  assert.equal(await page.evaluate(() => window.colorWatchCalls), before + 1)
})
