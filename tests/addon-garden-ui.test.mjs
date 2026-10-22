import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

const entry = (id, name, fields = {}) => ({
  id,
  name,
  description: `${name} from the garden.`,
  version: '2.0.0',
  apiVersion: 2,
  kind: 'extension',
  authors: [{ displayName: 'Garden author' }],
  license: 'MIT',
  path: `addons/${id}`,
  ...fields,
})
const entries = [
  entry('garden-hello', 'Garden hello'),
  entry('garden-theme', 'Garden theme', {
    kind: 'theme',
    path: undefined,
    repository: {
      url: 'https://github.com/example/garden-theme',
      commit: 'a'.repeat(40),
    },
  }),
  entry('garden-update', 'Garden update'),
  entry('vim', 'Vim'),
  entry('garden-later', 'Later addon'),
]

test('hibi garden tab, installs, and addon links', {
  timeout: 60000,
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'hibi-addon-garden-ui-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(temp, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(temp, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await waitForDocumentEditor(app, page)
  await app.evaluate(
    ({ ipcMain }, { entries }) => {
      globalThis.directoryCalls = []
      globalThis.installs = []
      globalThis.pendingLinks = []
      const replace = (channel, handler) => {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, handler)
      }
      replace('addons:directory', (_event, refresh) => {
        globalThis.directoryCalls.push(refresh)
        const calls = globalThis.directoryCalls.length
        if (calls === 1)
          return { entries: [], fetchedAt: null, error: 'Hibi is offline.' }
        // A manual refresh picks up entries published after the first load.
        return {
          entries:
            calls === 2
              ? entries.filter(({ id }) => id !== 'garden-later')
              : entries,
          fetchedAt: '2026-10-23T00:00:00.000Z',
        }
      })
      replace('addons:directory-install', async (_event, id, openSettings) => {
        globalThis.installs.push([id, openSettings])
        // Hold each install briefly so a queued link must wait for it.
        await new Promise((done) => setTimeout(done, 300))
        return null
      })
      replace('addons:garden-requests', () => globalThis.pendingLinks.splice(0))
      // After an install, the renderer re-reads installed packages from main.
      const installed = (id, name, version) => ({
        manifest: {
          id,
          name,
          description: `${name} from the garden.`,
          apiVersion: 2,
          kind: 'extension',
          version,
          authors: [{ displayName: 'Garden author' }],
          capabilities: [],
          entry: 'index.js',
        },
        url: null,
        themes: [],
        source: 'third-party',
      })
      globalThis.packages = [
        installed('garden-hello', 'Garden hello', '2.0.0'),
        installed('garden-update', 'Garden update', '1.0.0'),
      ]
      globalThis.removed = []
      replace('addons:installed', () => globalThis.packages)
      replace('addons:remove', (_event, id) => {
        globalThis.removed.push(id)
        globalThis.packages = globalThis.packages.filter(
          ({ manifest }) => manifest.id !== id,
        )
      })
    },
    { entries },
  )
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^addon manager$/i }).click()
  const addons = page.locator('#settings-addons')
  const installed = addons.getByRole('tab', { name: /^installed$/i })
  const garden = addons.getByRole('tab', { name: /^hibi garden$/i })

  await t.test(
    'the directory loads only when the garden tab opens',
    async () => {
      assert.equal(await installed.getAttribute('aria-selected'), 'true')
      assert.deepEqual(await app.evaluate(() => globalThis.directoryCalls), [])
      await installed.focus()
      await page.keyboard.press('ArrowRight')
      assert.equal(await garden.getAttribute('aria-selected'), 'true')
      assert.equal(
        await page.evaluate(() => document.activeElement?.textContent),
        'Hibi garden',
      )
      const failure = addons.getByRole('alert').filter({
        hasText: "Couldn't load Hibi garden",
      })
      await failure.waitFor()
      assert.match(await failure.innerText(), /Hibi is offline\./)
      await addons.getByRole('button', { name: /^try again$/i }).click()
      await addons.locator('[data-setting-id="garden-garden-hello"]').waitFor()
      assert.deepEqual(await app.evaluate(() => globalThis.directoryCalls), [
        false,
        true,
      ])
      const later = addons.locator('[data-setting-id="garden-garden-later"]')
      assert.equal(await later.count(), 0)
      await addons.getByRole('button', { name: /^refresh$/i }).click()
      await later.waitFor()
      assert.deepEqual(await app.evaluate(() => globalThis.directoryCalls), [
        false,
        true,
        true,
      ])
      // Search also matches addon IDs.
      const filter = addons.getByRole('searchbox', { name: /filter addons/i })
      await filter.fill('garden-theme')
      await addons.locator('[data-setting-id="garden-garden-theme"]').waitFor()
      assert.equal(
        await addons
          .locator('[data-setting-id="garden-garden-hello"]')
          .isVisible(),
        false,
      )
      await filter.fill('')
    },
  )

  await t.test('rows show metadata and the right action', async () => {
    const row = (id) => addons.locator(`[data-setting-id="garden-${id}"]`)
    assert.match(await row('garden-hello').innerText(), /MIT/)
    assert.match(await row('garden-hello').innerText(), /Garden author/)
    assert.match(await row('vim').innerText(), /Included with Hibi/)
    assert.equal(
      await row('vim')
        .getByRole('button', { name: /^install/i })
        .count(),
      0,
    )
    await addons.getByRole('button', { name: /^themes$/i }).click()
    assert.equal(await row('garden-theme').isVisible(), true)
    assert.equal(await row('garden-hello').isVisible(), false)
    await addons.getByRole('button', { name: /^all$/i }).click()
    await row('garden-update')
      .getByRole('button', { name: 'Install Garden update' })
      .waitFor()
    await row('garden-hello')
      .getByRole('button', { name: 'Install Garden hello' })
      .click()
    // The finished install re-reads installed packages, which updates every row.
    await row('garden-hello').getByText('Installed', { exact: true }).waitFor()
    await row('garden-update')
      .getByRole('button', { name: 'Replace Garden update' })
      .waitFor()
    const [[id, openSettings]] = await app.evaluate(() => globalThis.installs)
    assert.equal(id, 'garden-hello')
    assert.ok(Array.isArray(openSettings))
  })

  await t.test('installed garden addons can be uninstalled', async () => {
    const row = (id) => addons.locator(`[data-setting-id="garden-${id}"]`)
    await row('garden-update')
      .getByRole('button', { name: 'Uninstall Garden update' })
      .waitFor()
    assert.equal(
      await row('vim')
        .getByRole('button', { name: /^uninstall/i })
        .count(),
      0,
    )
    assert.equal(
      await row('garden-theme')
        .getByRole('button', { name: /^uninstall/i })
        .count(),
      0,
    )
    await row('garden-hello')
      .getByRole('button', { name: 'Uninstall Garden hello' })
      .click()
    await row('garden-hello')
      .getByRole('button', { name: 'Install Garden hello' })
      .waitFor()
    assert.deepEqual(await app.evaluate(() => globalThis.removed), [
      'garden-hello',
    ])
    // The installed tab uses the same label.
    await installed.click()
    await addons
      .locator('[data-setting-id="addon-garden-update"]')
      .getByRole('button', { name: /^uninstall$/i })
      .waitFor()
    await garden.click()
  })

  await t.test('addon links queue and run one at a time', async () => {
    await app.evaluate(({ BrowserWindow }) => {
      globalThis.installs = []
      globalThis.pendingLinks.push(
        { id: 'garden-theme', install: true },
        { id: 'garden-update', install: true },
        { id: 'vim', install: false },
      )
      for (const window of BrowserWindow.getAllWindows())
        window.webContents.send('addons:garden-pending')
    })
    await page.waitForFunction(
      () =>
        document.querySelector(
          '[role="tab"][aria-selected="true"]#addon-tab-installed',
        ) && document.activeElement?.closest('[data-setting-id="addon-vim"]'),
    )
    assert.deepEqual(
      (await app.evaluate(() => globalThis.installs)).map(([id]) => id),
      ['garden-theme', 'garden-update'],
    )
  })

  await t.test('an unknown garden ID explains itself', async () => {
    await app.evaluate(({ BrowserWindow }) => {
      globalThis.pendingLinks.push({ id: 'missing-addon', install: true })
      for (const window of BrowserWindow.getAllWindows())
        window.webContents.send('addons:garden-pending')
    })
    await page
      .getByText(
        `Hibi garden doesn't list an addon with the ID "missing-addon".`,
      )
      .waitFor()
    assert.equal(await garden.getAttribute('aria-selected'), 'true')
  })

  await t.test(
    'security toggles save through the real main process',
    async () => {
      // Other tests stub these handlers; this one keeps main's own validation.
      const allow = addons.getByRole('checkbox', {
        name: 'Allow unsigned addons',
      })
      await allow.click()
      await page
        .getByRole('dialog', { name: /^allow unsigned addons$/i })
        .getByRole('button', { name: /^allow unsigned addons$/i })
        .click()
      await addons.locator('#allow-unsigned-addons:checked:enabled').waitFor()
      await addons
        .getByRole('checkbox', { name: 'Check for revoked addons' })
        .click()
      await addons
        .locator('#check-revoked-addons:not(:checked):enabled')
        .waitFor()
      assert.deepEqual(
        await page.evaluate(() => window.hibi.getAddonTrustSettings()),
        { allowUnsigned: true, checkRevocations: false },
      )
      assert.equal(await addons.getByRole('alert').count(), 0)
    },
  )

  assert.deepEqual(errors, [])
})
