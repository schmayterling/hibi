import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'

test('addon menu and configurable in-app shortcut use one lazy command', {
  timeout: 60000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-addon-command-hotkeys-'))
  const directory = join(profile, 'installed-addons', 'command-probe')
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'hibi-addon.json'),
    JSON.stringify({
      id: 'command-probe',
      name: 'Command probe',
      description: 'Command transport fixture',
      kind: 'extension',
      apiVersion: 2,
      version: '1.0.0',
      authors: [{ displayName: 'Test' }],
      entry: 'index.js',
      capabilities: [],
      activation: 'command',
      commands: [
        {
          id: 'run',
          label: 'Example action',
          defaultShortcut: 'mod+shift+f10',
          menu: { location: 'app', group: 'example' },
        },
      ],
    }),
  )
  await writeFile(
    join(directory, 'index.js'),
    `export default () => ({ start(context) {
      window.commandProbeStarts = (window.commandProbeStarts || 0) + 1;
      context.commands.register({
        id: 'run', label: 'Example action',
        run(invocation) {
          window.commandProbeSources = [...(window.commandProbeSources || []), invocation.source];
        },
      });
    } });`,
  )
  await writeFile(
    join(directory, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['hibi-addon.json', 'index.js'],
      source: 'local',
    }),
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'command-probe': true }),
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
  await page.locator('.titlebar').waitFor()
  await page.waitForFunction(async () =>
    (await window.hibi.getAddonHotkeys()).some(
      ({ id }) => id === 'command-probe.run',
    ),
  )
  assert.equal(await page.evaluate(() => window.commandProbeStarts), undefined)

  await clickMenu(app, 'Example action')
  await page.waitForFunction(() => window.commandProbeSources?.length === 1)
  assert.deepEqual(await page.evaluate(() => window.commandProbeSources), [
    'menu',
  ])

  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  await pressShortcut(app, `${modifier}+Shift+F10`)
  await page.waitForFunction(() => window.commandProbeSources?.length === 2)
  assert.deepEqual(await page.evaluate(() => window.commandProbeSources), [
    'menu',
    'shortcut',
  ])

  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Hotkeys', exact: true }).click()
  const rebind = page.getByRole('button', { name: 'Rebind Example action' })
  await rebind.waitFor()
  await rebind.click()
  await rebind.press(`${modifier}+Alt+Shift+J`)
  await page
    .getByRole('button', { name: 'Save shortcut for Example action' })
    .click()
  assert.equal(
    (await page.evaluate(() => window.hibi.getAddonHotkeys())).find(
      ({ id }) => id === 'command-probe.run',
    )?.effectiveShortcut,
    `${modifier === 'Meta' ? 'meta' : 'ctrl'}+alt+shift+j`,
  )

  await rebind.click()
  await page.getByRole('button', { name: 'Back to app' }).click()
  await pressShortcut(app, `${modifier}+Alt+Shift+J`)
  await page.waitForFunction(() => window.commandProbeSources?.length === 3)

  await clickMenu(app, 'Settings')

  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  const enabled = page.locator('#addon-command-probe')
  await enabled.click()
  await page.waitForFunction(
    async () =>
      !(await window.hibi.getAddonHotkeys()).some(
        ({ id }) => id === 'command-probe.run',
      ),
  )
  await assert.rejects(clickMenu(app, 'Example action'), /unavailable/)

  await enabled.click()
  await page.waitForFunction(async () =>
    (await window.hibi.getAddonHotkeys()).some(
      ({ id, effectiveShortcut }) =>
        id === 'command-probe.run' &&
        effectiveShortcut ===
          `${navigator.platform.startsWith('Mac') ? 'meta' : 'ctrl'}+alt+shift+j`,
    ),
  )
  await pressShortcut(app, `${modifier}+Alt+Shift+J`)
  await page.waitForFunction(() => window.commandProbeSources?.length === 4)
  assert.equal(
    (await page.evaluate(() => window.commandProbeSources)).at(-1),
    'shortcut',
  )
})
