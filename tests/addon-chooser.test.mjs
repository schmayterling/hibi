import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('addon chooser reviews every candidate, supports keyboard selection, and settles partial or canceled installs', {
  timeout: 45000,
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'hibi-addon-chooser-'))
  const source = join(temp, 'packages')
  const profile = join(temp, 'profile')
  const metadata = {
    name: 'Chooser fixture',
    description: 'A package for installation review.',
    apiVersion: 2,
    kind: 'extension',
    version: '1.0.0',
    authors: [{ displayName: 'Fixture author' }],
    capabilities: [],
    entry: 'index.js',
  }
  async function fixture(folder, fields) {
    const path = join(source, folder)
    await mkdir(path, { recursive: true })
    await writeFile(
      join(path, 'hibi-addon.json'),
      JSON.stringify({ ...metadata, ...fields }),
    )
    await writeFile(join(path, 'README.md'), '# Installation fixture')
    if (fields.kind !== 'theme' && folder !== 'b-invalid')
      await writeFile(
        join(path, 'index.js'),
        'export default () => ({ start() {} })',
      )
    return path
  }
  await fixture('a-consumer', {
    id: 'chooser-consumer',
    name: 'Chooser consumer',
    requires: { addons: [{ id: 'chooser-provider' }] },
    network: { origins: ['https://example.com'] },
  })
  await fixture('b-invalid', { id: 'chooser-invalid', name: 'Chooser invalid' })
  const independent = await fixture('m-independent', {
    id: 'chooser-independent',
    name: 'Chooser independent',
  })
  await fixture('n-theme', {
    id: 'chooser-theme',
    name: 'Chooser theme',
    kind: 'theme',
    capabilities: undefined,
    entry: undefined,
    themes: [
      {
        id: 'night',
        name: 'Chooser night',
        appearance: 'dark',
        author: 'Fixture author',
        license: { name: 'MIT', text: 'Fixture license notice.' },
        colors: {
          background: '#111111',
          surface: '#222222',
          ink: '#eeeeee',
          muted: '#aaaaaa',
          accent: '#88cccc',
          border: '#333333',
        },
      },
    ],
  })
  await fixture('x-reserved', { id: 'markdown', name: 'Chooser reserved' })
  await fixture('z-provider', {
    id: 'chooser-provider',
    name: 'Chooser provider',
  })
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      globalThis.releaseInstall?.()
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(temp, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  await waitForDocumentEditor(app, page)
  await page.evaluate(() =>
    window.hibi.setAddonTrustSettings({
      allowUnsigned: true,
      checkRevocations: false,
    }),
  )
  await app.evaluate(({ dialog, shell, ipcMain }, source) => {
    globalThis.packageSource = source
    globalThis.nativeReviews = 0
    globalThis.cancelCalls = 0
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [globalThis.packageSource],
    })
    dialog.showMessageBox = async () => {
      globalThis.nativeReviews++
      return { response: 1 }
    }
    const fs = process.getBuiltinModule('fs/promises')
    shell.trashItem = (path) => fs.rename(path, `${path}.trashed`)
    const selection = ipcMain._invokeHandlers.get('addons:install-selection')
    const cancel = ipcMain._invokeHandlers.get('addons:install-cancel')
    ipcMain.removeHandler('addons:install-selection')
    ipcMain.handle('addons:install-selection', async (...args) => {
      if (globalThis.installMode === 'cancel') {
        globalThis.installHeld = true
        return new Promise((resolve) => {
          globalThis.releaseInstall = () =>
            resolve(
              args[2].map((key) => ({
                key,
                status: 'failed',
                error: 'Addon installation canceled.',
              })),
            )
        })
      }
      const results = await selection(...args)
      if (globalThis.installMode === 'hold-results') {
        globalThis.installHeld = true
        await new Promise((resolve) => {
          globalThis.releaseInstall = resolve
        })
      }
      return results
    })
    ipcMain.removeHandler('addons:install-cancel')
    ipcMain.handle('addons:install-cancel', async (...args) => {
      globalThis.cancelCalls++
      await cancel(...args)
      if (globalThis.installMode === 'cancel') globalThis.releaseInstall?.()
    })
  }, source)
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^addon manager$/i }).click()
  const filter = page.getByRole('searchbox', { name: /^filter addons$/i })
  async function chooseFolder(path = source) {
    await app.evaluate((_electron, path) => {
      globalThis.packageSource = path
    }, path)
    await filter.focus()
    await clickMenu(app, 'Command palette')
    const input = page.getByRole('combobox', { name: /search commands/i })
    await input.fill('install addon')
    await page.getByRole('option').first().waitFor()
    await input.press('Enter')
    await page
      .getByRole('dialog', { name: /command palette/i })
      .waitFor({ state: 'hidden' })
  }
  const dialog = page.getByRole('dialog', { name: /^install addons$/i })
  const checkbox = (name) =>
    dialog.getByRole('checkbox', { name: `Chooser ${name}`, exact: true })
  const row = (name) =>
    dialog.locator('li').filter({
      has: page.getByRole('checkbox', { name: `Chooser ${name}`, exact: true }),
    })
  const install = dialog.getByRole('button', { name: /^install selected/i })
  const dismiss = async () => {
    await dialog.getByRole('button', { name: /^close$/i, exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await page.waitForFunction(
      () => document.activeElement?.id === 'addon-filter',
    )
  }
  await t.test(
    'preselects only installable rows and supports space, tab, and escape',
    async () => {
      await chooseFolder()
      await dialog.waitFor()
      assert.equal(await dialog.getByRole('checkbox').count(), 6)
      for (const name of ['consumer', 'independent', 'theme', 'provider'])
        assert.equal(await checkbox(name).isChecked(), true)
      for (const name of ['invalid', 'reserved']) {
        assert.equal(await checkbox(name).isDisabled(), true)
        assert.equal(await checkbox(name).isChecked(), false)
      }
      assert.match(
        await row('invalid').innerText(),
        /Invalid package.*README.md/s,
      )
      assert.match(
        await row('reserved').innerText(),
        /Blocked package.*built-in addon/s,
      )
      assert.match(
        await row('consumer').innerText(),
        /chooser-provider \(z-provider\)/,
      )
      assert.match(await row('consumer').innerText(), /https:\/\/example.com/)
      assert.match(await row('theme').innerText(), /Color data only/)
      assert.doesNotMatch(await row('theme').innerText(), /Can run code/)
      await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.unmaximize()
        window.setMinimumSize(360, 500)
        window.setSize(360, 640)
      })
      await page.waitForFunction(() => innerWidth === 360)
      await mkdir('test-results', { recursive: true })
      for (const appearance of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: appearance })
        await page.waitForFunction(
          (appearance) =>
            document.documentElement.dataset.colorscheme ===
            `hibi-${appearance}`,
          appearance,
        )
        assert.equal(
          await dialog
            .locator('.dialog-content')
            .evaluate((el) => el.scrollWidth <= el.clientWidth),
          true,
        )
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
        )
        // Actions stay outside the scrolling list, even on a short window.
        const actions = await install.evaluate((button) => ({
          inFooter: !!button.closest('.dialog-footer'),
          bottom: button.getBoundingClientRect().bottom,
        }))
        assert.equal(actions.inFooter, true)
        assert.ok(actions.bottom <= 640, JSON.stringify(actions))
        await checkbox('consumer').focus()
        await page.screenshot({
          path: `test-results/addon-chooser-${appearance}.png`,
        })
      }
      for (const name of ['consumer', 'independent', 'theme', 'provider']) {
        await checkbox(name).focus()
        await page.keyboard.press('Space')
      }
      assert.equal(await install.isDisabled(), true)
      assert.match(await install.innerText(), /\(0\)/)
      await page.keyboard.press('Tab')
      assert.equal(
        await dialog
          .getByRole('button', { name: /^cancel$/i })
          .evaluate((el) => el === document.activeElement),
        true,
      )
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden' })
      await page.waitForFunction(
        () => document.activeElement?.id === 'addon-filter',
      )
      assert.equal(
        (await page.evaluate(() => window.hibi.getInstalledAddons())).length,
        0,
      )
    },
  )
  await t.test(
    'unchecked providers disable consumers while independent rows install and the chooser can retry',
    async () => {
      await chooseFolder()
      await checkbox('provider').focus()
      await page.keyboard.press('Space')
      assert.equal(await checkbox('consumer').isDisabled(), true)
      assert.equal(await checkbox('provider').isChecked(), false)
      assert.match(
        await row('consumer').innerText(),
        /Select required providers: chooser-provider/,
      )
      await page.keyboard.press('Tab')
      await page.keyboard.press('Tab')
      assert.equal(
        await install.evaluate((el) => el === document.activeElement),
        true,
      )
      await page.keyboard.press('Enter')
      await row('independent')
        .getByText('Installed — disabled', { exact: true })
        .waitFor()
      assert.match(await row('theme').innerText(), /Installed — disabled/)
      assert.equal(await checkbox('consumer').isDisabled(), true)
      assert.equal(await checkbox('provider').isEnabled(), true)
      assert.match(await row('provider').innerText(), /Not selected/)
      assert.equal(
        await dialog
          .getByRole('button', { name: 'Close', exact: true })
          .evaluate((el) => el === document.activeElement),
        true,
      )
      assert.equal(
        await row('consumer').locator('[aria-live="polite"]').count(),
        1,
      )
      await checkbox('provider').check()
      assert.equal(await checkbox('consumer').isEnabled(), true)
      await install.focus()
      await page.keyboard.press('Enter')
      await row('consumer')
        .getByText('Installed — disabled', { exact: true })
        .waitFor()
      await row('provider')
        .getByText('Installed — disabled', { exact: true })
        .waitFor()
      assert.equal(
        await dialog
          .getByRole('button', { name: 'Close', exact: true })
          .evaluate((el) => el === document.activeElement),
        true,
      )
      await dismiss()
      assert.equal(
        (await page.evaluate(() => window.hibi.getInstalledAddons())).length,
        4,
      )
      await chooseFolder()
      await checkbox('provider').uncheck()
      assert.equal(await checkbox('consumer').isEnabled(), true)
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden' })
      await page.evaluate(async () => {
        for (const id of ['consumer', 'independent', 'provider', 'theme'])
          await window.hibi.removeAddon(`chooser-${id}`)
      })
    },
  )
  await t.test(
    'installs providers first, keeps successes after one failure, and hydrates disabled rows',
    async () => {
      await chooseFolder()
      const obstruction = join(
        profile,
        'installed-addons',
        'chooser-independent',
      )
      await mkdir(obstruction, { recursive: true })
      await install.click()
      await row('consumer')
        .getByText('Installed — disabled', { exact: true })
        .waitFor()
      await row('provider')
        .getByText('Installed — disabled', { exact: true })
        .waitFor()
      await row('theme')
        .getByText('Installed — disabled', { exact: true })
        .waitFor()
      await row('independent')
        .getByText(/Failed:.*unrecognized addon/i)
        .waitFor()
      assert.equal(await app.evaluate(() => globalThis.nativeReviews), 0)
      await dismiss()
      for (const name of ['consumer', 'provider', 'theme']) {
        await page.locator(`#addon-chooser-${name}`).waitFor()
        assert.equal(
          await page.locator(`#addon-chooser-${name}`).isChecked(),
          false,
        )
      }
      await rm(obstruction, { recursive: true, force: true })
    },
  )
  await t.test(
    'single candidates retain native review without opening chooser',
    async () => {
      await chooseFolder(independent)
      await page.locator('#addon-chooser-independent').waitFor()
      assert.equal(await dialog.count(), 0)
      assert.equal(await app.evaluate(() => globalThis.nativeReviews), 1)
      assert.equal(
        await page.locator('#addon-chooser-independent').isChecked(),
        false,
      )
    },
  )
  await t.test(
    'cancel during batch keeps per-row cancellation results visible',
    async () => {
      await app.evaluate(() => {
        globalThis.installMode = 'cancel'
        globalThis.installHeld = false
      })
      await chooseFolder()
      assert.match(
        await row('consumer').innerText(),
        /Replaces v1.0.0 \(local\) with v1.0.0 \(local\)/,
      )
      await install.click()
      await waitForAsync(app, () => globalThis.installHeld)
      await dialog.getByRole('button', { name: /^cancel$/i }).click()
      for (const name of ['consumer', 'provider', 'independent', 'theme'])
        await row(name)
          .getByText('Failed: Addon installation canceled.', { exact: true })
          .waitFor()
      assert.ok(await app.evaluate(() => globalThis.cancelCalls > 0))
      await dismiss()
      assert.equal(
        (await page.evaluate(() => window.hibi.getInstalledAddons())).length,
        4,
      )
    },
  )
  await t.test(
    'early dismissal waits for batch settlement before hydrating new packages',
    async () => {
      await fixture('y-late', { id: 'chooser-late', name: 'Chooser late' })
      await app.evaluate(() => {
        globalThis.installMode = 'hold-results'
        globalThis.installHeld = false
      })
      await chooseFolder()
      await install.click()
      await waitForAsync(app, () => globalThis.installHeld)
      assert.ok(
        (await page.evaluate(() => window.hibi.getInstalledAddons())).some(
          (addon) => addon.manifest.id === 'chooser-late',
        ),
      )
      assert.equal(await page.locator('#addon-chooser-late').count(), 0)
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden' })
      assert.equal(await page.locator('#addon-chooser-late').count(), 0)
      await app.evaluate(() => globalThis.releaseInstall())
      await page.locator('#addon-chooser-late').waitFor()
      assert.equal(await page.locator('#addon-chooser-late').isChecked(), false)
      await page.waitForFunction(
        () => document.activeElement?.id === 'addon-filter',
      )
    },
  )
})
