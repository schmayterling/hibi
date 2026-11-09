import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { fixtureVault } from './obsidian/harness.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
test('vault settings offers confirm global replacement, retain a backup and remember accepted or dismissed choices', {
  timeout: 90000,
}, async (t) => {
  const first = await fixtureVault(t, 'host-surface', { cleanup: false })
  const second = await fixtureVault(t, 'host-surface', { cleanup: false })
  const app = await electron.launch({
    args: [resolve('.'), '--user-data-dir=' + first.overlay],
  })
  t.after(async () => {
    try {
      await app.close()
      await first.assertUnchanged()
      await second.assertUnchanged()
    } finally {
      await first.dispose()
      await second.dispose()
    }
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(8000)
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [folder],
    })
    dialog.showMessageBox = async () => ({ response: 1 })
  }, first.folder)
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  await page
    .getByRole('button', {
      name: 'Install Obsidian plugin from folder',
      exact: true,
    })
    .click()
  const row = page.locator(
    '[data-setting-id="installed-obsidian-host-surface"]',
  )
  const enabled = row.getByRole('checkbox', {
    name: 'Enable Host surface',
    exact: true,
  })
  await enabled.waitFor()
  await page.evaluate(() =>
    window.hibi.invokeAddon('obsidian', 'saveData', {
      id: 'host-surface',
      value: { enabled: true, globalDefaults: true },
    }),
  )
  await enabled.click()
  await page.waitForFunction(() => window.__hibiHostFixture?.loaded)
  await page.evaluate(() => window.__hibiHostFixture.notice.hide())
  const state = join(
    first.overlay,
    'obsidian',
    'global',
    'state',
    'host-surface',
  )
  let original = await readFile(join(state, 'data.json'))
  async function openVault(folder) {
    await page.evaluate(() => {
      window.__previousHostFixture = window.__hibiHostFixture
    })
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [folder],
      })
    }, folder)
    await pressShortcut(app, mod + '+Shift+o')
    const warning = page.getByRole('dialog', {
      name: 'Back up this Obsidian vault',
      exact: true,
    })
    await warning
      .locator('.dialog-footer')
      .getByRole('button', { name: 'Continue', exact: true })
      .click()
    await warning.waitFor({ state: 'hidden' })
    await page.locator('.app[aria-busy="false"]').waitFor()
    await page.waitForFunction(
      () =>
        window.__hibiHostFixture !== window.__previousHostFixture &&
        window.__hibiHostFixture?.loaded,
    )
    await page.evaluate(() => window.__hibiHostFixture.notice.hide())
    await clickMenu(app, 'Settings')
    await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  }
  await openVault(first.vault)
  const useSettings = row.getByRole('button', {
    name: 'Use this vault’s settings',
    exact: true,
  })
  await useSettings.click()
  const prompt = page.getByRole('dialog', {
    name: 'Use this vault’s settings for Host surface?',
    exact: true,
  })
  await prompt
    .getByText(/replaces the plugin’s global settings for every folder/)
    .waitFor()
  await page.evaluate(() =>
    window.hibi.invokeAddon('obsidian', 'saveData', {
      id: 'host-surface',
      value: { enabled: true, globalDefaults: true, concurrentSave: true },
    }),
  )
  original = await readFile(join(state, 'data.json'))
  await prompt
    .getByRole('button', { name: 'Overwrite global settings', exact: true })
    .click()
  await prompt.waitFor({ state: 'hidden' })
  await row
    .getByRole('button', { name: 'Use this vault’s settings', exact: true })
    .waitFor()
  assert.deepEqual(
    await readFile(join(state, 'data.json')),
    original,
    'stale prompt preserves newer global data',
  )
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[role="alert"]')].some((element) =>
      /changed/i.test(element.textContent),
    ),
  )
  await useSettings.click()
  await prompt.getByRole('button', { name: 'Cancel', exact: true }).click()
  await prompt.waitFor({ state: 'hidden' })
  await useSettings.waitFor({ state: 'hidden' })
  assert.deepEqual(await readFile(join(state, 'data.json')), original)
  assert.equal(
    await page.evaluate(() =>
      window.hibi.queryAddon('obsidian', 'settingsOffer', {
        id: 'host-surface',
      }),
    ),
    false,
  )
  await openVault(second.vault)
  await useSettings.click()
  await page.evaluate(() => {
    window.__previousHostFixture = window.__hibiHostFixture
  })
  await prompt
    .getByRole('button', { name: 'Overwrite global settings', exact: true })
    .click()
  await prompt.waitFor({ state: 'hidden' })
  await useSettings.waitFor({ state: 'hidden' })
  assert.deepEqual(
    await page.evaluate(() =>
      window.hibi.queryAddon('obsidian', 'data', { id: 'host-surface' }),
    ),
    { enabled: false, seeded: true },
  )
  await page.waitForFunction(
    () =>
      window.__hibiHostFixture !== window.__previousHostFixture &&
      window.__hibiHostFixture?.loaded,
  )
  await page.evaluate(() => window.__hibiHostFixture.notice.hide())
  const backups = await readdir(join(state, 'data-backups'))
  assert.equal(backups.length, 1)
  assert.deepEqual(
    await readFile(join(state, 'data-backups', backups[0])),
    original,
  )
  const receipts = Object.values(
    JSON.parse(await readFile(join(state, 'settings-receipts.json'), 'utf8')),
  )
  assert.deepEqual(receipts.map((receipt) => receipt.action).sort(), [
    'accepted',
    'dismissed',
  ])
  await row
    .getByRole('button', { name: 'Settings for Host surface', exact: true })
    .click()
  const toggle = page.getByRole('checkbox', {
    name: 'Fixture toggle',
    exact: true,
  })
  await toggle.waitFor()
  assert.equal(
    await toggle.isChecked(),
    false,
    'accepted vault settings reload the enabled plugin',
  )
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  await page.evaluate(() =>
    window.hibi.invokeAddon('obsidian', 'saveData', {
      id: 'host-surface',
      value: { changedAfterImport: true },
    }),
  )
  assert.equal(
    await page.evaluate(() =>
      window.hibi.queryAddon('obsidian', 'settingsOffer', {
        id: 'host-surface',
      }),
    ),
    false,
  )
  assert.equal(await enabled.isChecked(), true)
  await first.assertUnchanged()
  await second.assertUnchanged()
})
