import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { communityFixture } from './obsidian/community-fixture.mjs'
import { fixtureVault } from './obsidian/harness.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
test('native community tab installs globally without a folder, explains activation, integrates Installed rows, and preserves vault bytes', {
  timeout: 90000,
}, async (t) => {
  const vault = await fixtureVault(t, 'host-smoke', { cleanup: false })
  const transport = await communityFixture(t)
  const app = await electron.launch({
    args: [resolve('.'), '--user-data-dir=' + vault.overlay],
    env: {
      ...process.env,
      HIBI_TEST_OBSIDIAN_COMMUNITY_URL: await transport.server(),
    },
  })
  t.after(async () => {
    try {
      await app.close()
      await vault.assertUnchanged()
    } finally {
      await vault.dispose()
    }
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(8000)
  await waitForDocumentEditor(app, page)
  assert.equal(
    await page.evaluate(
      async () => (await window.hibi.getWorkspace())?.id ?? null,
    ),
    null,
  )
  const remoteImages = []
  await page.route('https://example.test/never-load.png', (route) => {
    remoteImages.push(route.request().url())
    return route.abort()
  })
  await app.evaluate(({ dialog }, folder) => {
    globalThis.__communityPrompts = []
    globalThis.__acceptCommunity = false
    globalThis.__resetPrompt = () => {
      globalThis.__communityNextPrompt = new Promise((resolve) => {
        globalThis.__communityPromptReady = resolve
      })
    }
    globalThis.__resetPrompt()
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [folder],
    })
    dialog.showMessageBox = async (options) => {
      globalThis.__communityPrompts.push(options)
      globalThis.__communityPromptReady()
      return { response: globalThis.__acceptCommunity ? 1 : 0 }
    }
  }, vault.vault)
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  const tabs = page.getByRole('tablist', { name: 'Addon sources' })
  assert.deepEqual(await tabs.getByRole('tab').allTextContents(), [
    'Installed',
    'Hibi garden',
    'Obsidian community',
  ])
  await tabs
    .getByRole('tab', { name: 'Obsidian community', exact: true })
    .click()
  const browser = page.getByRole('region', {
    name: 'Obsidian community directory',
    exact: true,
  })
  await browser
    .getByRole('button', { name: 'Details for Host smoke', exact: true })
    .waitFor()
  assert.equal(
    await page
      .getByRole('heading', { name: 'Obsidian community', exact: true })
      .count(),
    0,
  )
  assert.equal(await browser.locator('.addon-catalog-actions').count(), 1)
  assert.equal(await browser.locator('.settings-filter-bar').count(), 1)
  assert.equal(await browser.locator('.addon-categories').count(), 1)
  assert.equal(
    await browser
      .getByRole('button', {
        name: 'Turn on Obsidian plugins for Host smoke',
        exact: true,
      })
      .isEnabled(),
    true,
  )
  assert.equal(
    await page.evaluate(() => typeof HTMLElement.prototype.createEl),
    'undefined',
  )
  await browser.getByRole('button', { name: 'Themes', exact: true }).click()
  assert.equal(
    await browser
      .getByRole('button', {
        name: 'Turn on Obsidian themes for Fixture theme',
        exact: true,
      })
      .isEnabled(),
    true,
  )
  await browser.getByRole('button', { name: 'Plugins', exact: true }).click()
  await browser
    .getByRole('button', { name: 'Details for Fixture theme', exact: true })
    .waitFor({ state: 'hidden' })
  assert.equal(
    await browser
      .getByRole('button', { name: 'Plugins', exact: true })
      .getAttribute('aria-pressed'),
    'true',
  )
  assert.equal(
    await browser
      .getByRole('button', { name: 'Details for Host smoke', exact: true })
      .count(),
    1,
  )
  const search = browser.getByRole('searchbox', {
    name: 'Filter addons',
    exact: true,
  })
  await search.fill('portable')
  assert.equal(
    await browser
      .getByRole('button', { name: 'Details for Desktop fixture', exact: true })
      .count(),
    0,
  )
  await browser
    .getByRole('button', { name: 'Details for Host smoke', exact: true })
    .click()
  const details = page.getByRole('dialog', { name: 'Host smoke', exact: true })
  await details
    .getByRole('heading', { name: 'Fixture community readme', exact: true })
    .waitFor()
  assert.equal(await details.locator('img, script, [onerror]').count(), 0)
  assert.deepEqual(remoteImages, [])
  assert.equal(
    await page.evaluate(() => globalThis.__unsafeCommunityReadme),
    undefined,
  )
  await details.getByText(/Requires Obsidian 1.0.0/).waitFor()
  await details.getByText(/Turn on Obsidian plugins to install/).waitFor()
  await details
    .getByRole('button', {
      name: 'Turn on Obsidian plugins for Host smoke',
      exact: true,
    })
    .click()
  const install = details.getByRole('button', {
    name: 'Install Host smoke',
    exact: true,
  })
  await install.waitFor()
  const held = new Promise((resolve) => {
    transport.onHold = resolve
  })
  transport.holdNextMain = true
  await install.click()
  await held
  assert.deepEqual(
    await page.evaluate(() => window.hibi.queryAddon('obsidian', 'list')),
    [],
  )
  await details
    .getByRole('button', { name: 'Cancel install Host smoke', exact: true })
    .click()
  await install.waitFor()
  assert.equal(
    await app.evaluate(() => globalThis.__communityPrompts.length),
    0,
  )
  await install.click()
  await app.evaluate(() => globalThis.__communityNextPrompt)
  const prompt = await app.evaluate(() => globalThis.__communityPrompts[0])
  assert.equal(prompt.defaultId, 0)
  assert.match(prompt.detail, /Fixture author/)
  assert.match(prompt.detail, /fixture\/host-smoke/)
  assert.match(prompt.detail, /renderer access/)
  assert.match(prompt.detail, /SHA-256/)
  await install.waitFor()
  assert.deepEqual(
    await page.evaluate(() => window.hibi.queryAddon('obsidian', 'list')),
    [],
  )
  await app.evaluate(() => {
    globalThis.__acceptCommunity = true
  })
  await install.click()
  await details.getByText('Installed', { exact: true }).waitFor()
  await page.keyboard.press('Escape')
  await details.waitFor({ state: 'hidden' })
  await tabs.getByRole('tab', { name: 'Installed', exact: true }).click()
  await page
    .getByRole('group', { name: 'Addon categories', exact: true })
    .getByRole('button', { name: 'Obsidian', exact: true })
    .click()
  const row = page.locator('[data-setting-id="installed-obsidian-host-smoke"]')
  await row.getByText('Obsidian community', { exact: true }).waitFor()
  const enabled = row.getByRole('checkbox', {
    name: 'Enable Host smoke',
    exact: true,
  })
  assert.equal(await enabled.isChecked(), false)
  await page
    .getByRole('checkbox', { name: 'Obsidian plugins', exact: true })
    .click()
  await row
    .getByRole('button', { name: 'Turn on Obsidian plugins', exact: true })
    .waitFor()
  await row.getByText('Obsidian community', { exact: true }).waitFor()
  await row
    .getByRole('button', { name: 'Turn on Obsidian plugins', exact: true })
    .click()
  await enabled.waitFor()
  assert.equal(
    await page.evaluate(() => typeof HTMLElement.prototype.createEl),
    'undefined',
  )
  const installed = await page.evaluate(() =>
    window.hibi.queryAddon('obsidian', 'list'),
  )
  assert.equal(installed[0].source.release, '1.0.0')
  assert.match(installed[0].source.hashes.main, /^[a-f0-9]{64}$/)
  await enabled.click()
  await page.waitForFunction(
    () => typeof HTMLElement.prototype.createEl === 'function',
  )
  await clickMenu(app, 'Command palette')
  const palette = page.getByRole('dialog', { name: /^command palette$/i })
  await palette
    .getByRole('combobox', { name: /search commands/i })
    .fill('Count fixture runs')
  await palette.getByRole('option', { name: /Count fixture runs/i }).click()
  await palette.waitFor({ state: 'hidden' })
  await page.waitForFunction(
    async () =>
      (await window.hibi.queryAddon('obsidian', 'data', { id: 'host-smoke' }))
        ?.count === 1,
  )
  transport.version = '2.0.0'
  await row
    .getByRole('button', { name: 'Update Host smoke', exact: true })
    .click()
  await details
    .getByText('New release available: 2.0.0', { exact: true })
    .waitFor()
  await details
    .getByRole('button', { name: 'Update Host smoke', exact: true })
    .click()
  await page.waitForFunction(async () => {
    const plugins = await window.hibi.queryAddon('obsidian', 'list')
    return (
      plugins[0]?.manifest.version === '2.0.0' && plugins[0].enabled === false
    )
  })
  assert.equal(
    (
      await page.evaluate(() =>
        window.hibi.queryAddon('obsidian', 'data', { id: 'host-smoke' }),
      )
    ).count,
    1,
  )
  await page.keyboard.press('Escape')
  await details.waitFor({ state: 'hidden' })
  // Themes also install without a folder. Installation never changes the current colorscheme.
  await tabs
    .getByRole('tab', { name: 'Obsidian community', exact: true })
    .click()
  await browser.getByRole('button', { name: 'Themes', exact: true }).click()
  await browser
    .getByRole('button', {
      name: 'Turn on Obsidian themes for Fixture theme',
      exact: true,
    })
    .click()
  await browser
    .getByRole('button', { name: 'Install Fixture theme', exact: true })
    .click()
  await browser
    .getByText('Fixture theme was installed.', { exact: true })
    .waitFor()
  const preview = browser.getByRole('button', {
    name: 'Preview Fixture theme',
    exact: true,
  })
  await preview.click()
  await page.locator('[data-obsidian-themes-safe]').waitFor()
  assert.equal(
    await page
      .locator('[data-obsidian-themes-safe]')
      .evaluate((element) => element.matches(':popover-open')),
    true,
  )
  await tabs.getByRole('tab', { name: 'Installed', exact: true }).click()
  const theme = page.locator('[data-setting-id^="installed-obsidian-theme-"]')
  await page
    .getByRole('checkbox', { name: 'Obsidian themes', exact: true })
    .click()
  await theme
    .getByRole('button', { name: 'Turn on Obsidian themes', exact: true })
    .waitFor()
  await theme.getByText('Obsidian community', { exact: true }).waitFor()
  await theme
    .getByRole('button', { name: 'Turn on Obsidian themes', exact: true })
    .click()
  await theme
    .getByRole('button', { name: 'Preview Fixture theme', exact: true })
    .waitFor()
  await theme
    .getByRole('button', { name: 'Apply Fixture theme', exact: true })
    .click()
  await theme.getByText('Active', { exact: true }).waitFor()
  await theme
    .getByRole('button', { name: 'Remove Fixture theme', exact: true })
    .click()
  const remove = page.getByRole('dialog', {
    name: 'Remove Fixture theme?',
    exact: true,
  })
  await remove.getByRole('button', { name: 'Cancel', exact: true }).click()
  await remove.waitFor({ state: 'hidden' })
  await theme
    .getByRole('button', { name: 'Remove Fixture theme', exact: true })
    .click()
  await remove.getByRole('button', { name: 'Remove', exact: true }).click()
  await remove.waitFor({ state: 'hidden' })
  await theme.waitFor({ state: 'hidden' })
  // Switching into a vault keeps the global plugin/data; its own settings never seed implicitly.
  await enabled.click()
  await page.waitForFunction(
    () => typeof HTMLElement.prototype.createEl === 'function',
  )
  await pressShortcut(app, mod + '+Shift+o')
  const warning = page.getByRole('dialog', {
    name: 'Back up this Obsidian vault',
  })
  await warning
    .locator('.dialog-footer')
    .getByRole('button', { name: 'Continue', exact: true })
    .click()
  await warning.waitFor({ state: 'hidden' })
  await page.locator('.app[aria-busy="false"]').waitFor()
  assert.equal(
    (
      await page.evaluate(() =>
        window.hibi.queryAddon('obsidian', 'data', { id: 'host-smoke' }),
      )
    ).count,
    1,
  )
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  await tabs
    .getByRole('tab', { name: 'Obsidian community', exact: true })
    .click()
  await browser.getByRole('button', { name: 'Plugins', exact: true }).click()
  await browser
    .getByRole('searchbox', { name: 'Filter addons', exact: true })
    .fill('desktop')
  await browser
    .getByRole('button', { name: 'Details for Desktop fixture', exact: true })
    .click()
  const desktop = page.getByRole('dialog', {
    name: 'Desktop fixture',
    exact: true,
  })
  await desktop
    .getByText(
      'This desktop plugin needs full computer access before it can run. You will review its permissions when enabling it.',
      { exact: true },
    )
    .waitFor()
  assert.equal(
    await desktop
      .getByRole('button', {
        name: 'Install Desktop fixture',
        exact: true,
      })
      .isEnabled(),
    true,
  )
  await page.keyboard.press('Escape')
  await desktop.waitFor({ state: 'hidden' })
  await browser
    .getByRole('searchbox', { name: 'Filter addons', exact: true })
    .fill('absent fixture')
  await browser.getByText('No matching addons', { exact: true }).waitFor()
  await browser.getByRole('button', { name: 'Reset all', exact: true }).click()
  await browser
    .getByRole('button', { name: 'Details for Host smoke', exact: true })
    .waitFor()
  assert.equal(
    await browser
      .getByRole('button', { name: 'All', exact: true })
      .getAttribute('aria-pressed'),
    'true',
  )
  await browser
    .getByRole('button', { name: 'Details for Fixture theme', exact: true })
    .waitFor()
  await browser.getByRole('button', { name: 'Plugins', exact: true }).click()
  await browser
    .getByRole('button', { name: 'Details for Fixture theme', exact: true })
    .waitFor({ state: 'hidden' })
  assert.equal(
    await browser
      .getByRole('button', { name: 'Plugins', exact: true })
      .getAttribute('aria-pressed'),
    'true',
  )
  await page.screenshot({
    path: resolve('.scratch/obsidian-native-community.png'),
    animations: 'disabled',
  })
  await vault.assertUnchanged()
})
