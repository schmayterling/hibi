import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { electron } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'

async function pressAddonShortcut(app, shortcut) {
  // Retry only if Electron never delivered the injected key to main.
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await app.evaluate(() => globalThis.commandTestInputs)
    await pressShortcut(app, shortcut)
    for (let check = 0; check < 20; check++) {
      if ((await app.evaluate(() => globalThis.commandTestInputs)) > before)
        return
      await delay(10)
    }
  }
  throw new Error('Native addon shortcut input did not reach Electron.')
}

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
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.commandTestInputs = 0
    BrowserWindow.getAllWindows()[0].webContents.on(
      'before-input-event',
      (_event, input) => {
        if (input.type === 'keyDown' && input.key.toLowerCase() === 'j')
          globalThis.commandTestInputs++
      },
    )
  })
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
  await page.waitForFunction(
    () =>
      document
        .querySelector('[aria-label="Rebind Example action"]')
        ?.getAttribute('aria-pressed') === 'true',
  )
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
  await page.waitForFunction(
    () =>
      document
        .querySelector('[aria-label="Rebind Example action"]')
        ?.getAttribute('aria-pressed') === 'true',
  )
  await page.getByRole('button', { name: 'Back to app' }).click()
  await pressAddonShortcut(app, `${modifier}+Alt+Shift+J`)
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
  await app.evaluate(async ({ Menu }) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const addons = Menu.getApplicationMenu()?.items.find(
        ({ label }) => label.toLowerCase() === 'addons',
      )
      if (
        !addons?.submenu?.items.some(({ label }) => label === 'Example action')
      )
        return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error('Addon menu item remained after disable.')
  })
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
  await pressAddonShortcut(app, `${modifier}+Alt+Shift+J`)
  await page.waitForFunction(() => window.commandProbeSources?.length === 4)
  assert.equal(
    (await page.evaluate(() => window.commandProbeSources)).at(-1),
    'shortcut',
  )

  await enabled.click()
  await page.waitForFunction(
    () => document.querySelector('#addon-command-probe')?.checked === false,
  )
  await page.waitForFunction(
    async () =>
      !(await window.hibi.getAddonHotkeys()).some(
        ({ id }) => id === 'command-probe.run',
      ),
  )
  await enabled.click()
  await page.waitForFunction(async () =>
    (await window.hibi.getAddonHotkeys()).some(
      ({ id, effectiveShortcut }) =>
        id === 'command-probe.run' &&
        effectiveShortcut ===
          `${navigator.platform.startsWith('Mac') ? 'meta' : 'ctrl'}+alt+shift+j`,
    ),
  )
  await pressAddonShortcut(app, `${modifier}+Alt+Shift+J`)
  await page.waitForFunction(() => window.commandProbeSources?.length === 5)

  await page.getByRole('tab', { name: 'Hotkeys', exact: true }).click()
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('hotkeys:record')
    ipcMain.handle('hotkeys:record', async (_event, recording) => {
      if (recording)
        await new Promise((resolve) => {
          globalThis.releaseAddonRecording = resolve
        })
    })
  })
  await rebind.click()
  await page.getByText('Preparing shortcut…', { exact: true }).waitFor()
  assert.equal(await rebind.getAttribute('aria-pressed'), 'false')
  assert.equal(
    await page
      .getByRole('button', { name: 'Reset shortcut for Example action' })
      .isDisabled(),
    true,
  )
  await app.evaluate(async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (typeof globalThis.releaseAddonRecording === 'function') {
        globalThis.releaseAddonRecording()
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error('Shortcut recording request did not reach main process.')
  })
  await page.waitForFunction(
    () =>
      document
        .querySelector('[aria-label="Rebind Example action"]')
        ?.getAttribute('aria-pressed') === 'true',
  )
  await page.getByRole('button', { name: 'Cancel rebinding' }).click()
  await page.getByRole('button', { name: 'Back to app' }).click()
  await clickMenu(app, 'Command palette')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette
    .getByRole('combobox', { name: /search commands/i })
    .fill('Example action')
  await palette.getByRole('option', { name: /Example action/i }).press('Enter')
  await page.waitForFunction(() => window.commandProbeSources?.length === 6)
  assert.equal(
    (await page.evaluate(() => window.commandProbeSources)).at(-1),
    'palette',
  )
})
