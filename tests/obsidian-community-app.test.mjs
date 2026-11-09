import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { communityFixture } from './obsidian/community-fixture.mjs'
import { fixtureVault } from './obsidian/harness.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
test('community browser searches official-shaped fixtures, sanitizes readmes and installs trusted updates disabled outside the vault', {
  timeout: 90000,
}, async (t) => {
  const vault = await fixtureVault(t, 'host-smoke', { cleanup: false })
  const transport = await communityFixture(t)
  const server = await transport.server()
  const app = await electron.launch({
    args: [resolve('.'), '--user-data-dir=' + vault.overlay],
    env: { ...process.env, HIBI_TEST_OBSIDIAN_COMMUNITY_URL: server },
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
  const remoteImages = []
  await page.route('https://example.test/never-load.png', (route) => {
    remoteImages.push(route.request().url())
    return route.abort()
  })
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ dialog }, folder) => {
    globalThis.__communityPrompts = []
    globalThis.__communityNextPrompt = new Promise((resolve) => {
      globalThis.__communityPromptReady = resolve
    })
    globalThis.__acceptCommunity = false
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
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  await page
    .getByRole('button', {
      name: 'Browse community plugins and themes',
      exact: true,
    })
    .click()
  const browser = page.getByRole('region', {
    name: 'Obsidian community directory',
    exact: true,
  })
  await browser.getByText('3 matching plugins', { exact: true }).waitFor()
  const enabled = page.getByRole('checkbox', {
    name: 'Obsidian plugins',
    exact: true,
  })
  assert.equal(await enabled.isChecked(), false)
  assert.equal(
    await page.evaluate(() => typeof HTMLElement.prototype.createEl),
    'undefined',
  )
  await browser.getByRole('tab', { name: 'Themes', exact: true }).click()
  await browser.getByText('Fixture theme', { exact: true }).waitFor()
  assert.equal(
    await browser
      .getByRole('button', {
        name: 'Turn on Obsidian themes to install',
        exact: true,
      })
      .count(),
    1,
  )
  await browser.getByRole('tab', { name: 'Plugins', exact: true }).click()
  const search = browser.getByRole('textbox', {
    name: 'Search Obsidian community',
    exact: true,
  })
  await search.fill('portable')
  await browser.getByText('1 matching plugins', { exact: true }).waitFor()
  assert.equal(
    await browser
      .getByRole('button', { name: 'Details for Desktop fixture', exact: true })
      .count(),
    0,
  )
  await browser
    .getByRole('button', { name: 'Details for Host smoke', exact: true })
    .click()
  const details = browser.getByRole('region', {
    name: 'Host smoke details',
    exact: true,
  })
  await details
    .getByRole('heading', { name: 'Fixture community readme', exact: true })
    .waitFor()
  assert.equal(await details.locator('img, script, [onerror]').count(), 0)
  assert.equal(
    await page.evaluate(() => globalThis.__unsafeCommunityReadme),
    undefined,
  )
  assert.equal(
    transport.requests.some((request) =>
      request.url.includes('never-load.png'),
    ),
    false,
  )
  assert.deepEqual(remoteImages, [])
  assert.equal(await enabled.isChecked(), false)
  await details.getByText(/Requires Obsidian 1.0.0/).waitFor()
  await browser
    .getByRole('button', {
      name: 'Turn on Obsidian plugins to install',
      exact: true,
    })
    .click()
  await page.waitForFunction(
    () =>
      document.querySelector('input[aria-label="Obsidian plugins"]')?.checked,
  )
  const held = new Promise((resolve) => {
    transport.onHold = resolve
  })
  transport.holdNextMain = true
  await details
    .getByRole('button', { name: 'Install Host smoke', exact: true })
    .click()
  await held
  // A network transfer must not hold the file-operation queue used by this query.
  assert.equal(
    await page.evaluate(async () => {
      const workspace = await window.hibi.getWorkspace()
      return (
        await window.hibi.queryAddon('obsidian', 'list', {
          vaultId: workspace.id,
        })
      ).length
    }),
    0,
  )
  await browser
    .getByRole('button', { name: 'Cancel community request', exact: true })
    .click()
  await details
    .getByRole('button', { name: 'Install Host smoke', exact: true })
    .waitFor({ state: 'visible' })
  await page.waitForFunction(
    () =>
      !document.querySelector(
        '[aria-label="Obsidian community directory"] button:disabled',
      ),
  )
  assert.equal(
    await app.evaluate(() => globalThis.__communityPrompts.length),
    0,
  )
  await details
    .getByRole('button', { name: 'Install Host smoke', exact: true })
    .click()
  // Wait for the positive native-dialog event; an empty install list can precede a download.
  await app.evaluate(() => globalThis.__communityNextPrompt)
  const prompts = await app.evaluate(() => globalThis.__communityPrompts)
  assert.equal(prompts.length, 1, await browser.textContent())
  assert.equal(prompts[0].defaultId, 0)
  assert.match(prompts[0].detail, /Fixture author/)
  assert.match(prompts[0].detail, /fixture\/host-smoke/)
  assert.match(prompts[0].detail, /renderer access/)
  assert.match(prompts[0].detail, /SHA-256/)
  await app.evaluate(() => {
    globalThis.__acceptCommunity = true
  })
  await details
    .getByRole('button', { name: 'Install Host smoke', exact: true })
    .click()
  await browser
    .getByText(/Host smoke was installed and starts disabled/)
    .waitFor()
  const installed = await page.evaluate(async () => {
    const workspace = await window.hibi.getWorkspace()
    const list = await window.hibi.queryAddon('obsidian', 'list', {
      vaultId: workspace.id,
    })
    await window.hibi.invokeAddon('obsidian', 'saveData', {
      vaultId: workspace.id,
      id: 'host-smoke',
      value: { preserved: true },
    })
    return list
  })
  assert.equal(installed.length, 1)
  assert.equal(installed[0].enabled, false)
  assert.equal(installed[0].source.repo, 'fixture/host-smoke')
  assert.equal(installed[0].source.release, '1.0.0')
  assert.match(installed[0].source.hashes.main, /^[a-f0-9]{64}$/)
  assert.equal(
    await page.evaluate(() => typeof HTMLElement.prototype.createEl),
    'undefined',
  )
  transport.version = '2.0.0'
  await browser
    .getByRole('button', { name: 'Details for Host smoke', exact: true })
    .click()
  await details
    .getByText('New release available: 2.0.0', { exact: true })
    .waitFor()
  await details
    .getByRole('button', { name: 'Update Host smoke', exact: true })
    .click()
  await page.waitForFunction(async () => {
    const workspace = await window.hibi.getWorkspace()
    const list = await window.hibi.queryAddon('obsidian', 'list', {
      vaultId: workspace.id,
    })
    return list[0]?.source?.release === '2.0.0' && list[0].enabled === false
  })
  assert.deepEqual(
    await page.evaluate(async () => {
      const workspace = await window.hibi.getWorkspace()
      return window.hibi.queryAddon('obsidian', 'data', {
        vaultId: workspace.id,
        id: 'host-smoke',
      })
    }),
    { preserved: true },
  )
  await search.fill('')
  await browser
    .getByRole('combobox', { name: 'Sort Obsidian community', exact: true })
    .selectOption('name')
  assert.deepEqual(
    await browser
      .getByRole('button', { name: /^Details for / })
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('aria-label')),
      ),
    [
      'Details for Desktop fixture',
      'Details for Host smoke',
      'Details for Mismatch fixture',
    ],
  )
  await browser
    .getByRole('button', { name: 'Details for Desktop fixture', exact: true })
    .click()
  const desktop = browser.getByRole('region', {
    name: 'Desktop fixture details',
    exact: true,
  })
  await desktop
    .getByText(/Desktop-only plugins requiring Node.js or Electron/)
    .waitFor()
  assert.equal(
    await desktop
      .getByRole('button', { name: 'Install Desktop fixture', exact: true })
      .isDisabled(),
    true,
  )
  await vault.assertUnchanged()
})
