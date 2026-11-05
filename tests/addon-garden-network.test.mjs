import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

// Downloads real packages from GitHub. Run with HIBI_NETWORK_TESTS=1.
const github = (repository, commit) =>
  `https://github.com/hibigarden/${repository}/tree/${commit}`
const ADDON_STARTER = github(
  'addon-starter',
  'cb8d3b78d1fdc1fb7ebfb9ca9dd9cf49b5961272',
)
// These immutable API 2 packages must stay blocked, even with unsigned opt-in.
const THEME_STARTER = github(
  'theme-starter',
  'ea985167e2c0c6d3effd4b642d32d1ac6707a1a9',
)
// Before the split, the addon starter held an extension and a theme side by side.
const TWO_PACKAGES = github(
  'addon-starter',
  '895502a3644390230e47055fea4e74a417622ffd',
)

test('hibi garden installs real packages through the addon manager', {
  skip: !process.env.HIBI_NETWORK_TESTS && 'set HIBI_NETWORK_TESTS=1',
  timeout: 300000,
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'hibi-addon-garden-network-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(temp, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(temp, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(60000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await waitForDocumentEditor(app, page)
  assert.deepEqual(
    await page.evaluate(() => window.hibi.getAddonTrustSettings()),
    {
      allowUnsigned: false,
      checkRevocations: true,
    },
  )
  // Capture native install confirmations; `answer` picks Cancel (0) or Install (1).
  await app.evaluate(({ dialog }) => {
    globalThis.confirmations = []
    globalThis.answer = 0
    dialog.showMessageBox = async (_window, options) => {
      globalThis.confirmations.push({
        message: options.message,
        detail: options.detail,
      })
      return { response: globalThis.answer, checkboxChecked: false }
    }
  })
  const confirmations = () => app.evaluate(() => globalThis.confirmations)
  const answer = (value) =>
    app.evaluate((_electron, value) => {
      globalThis.answer = value
    }, value)
  const link = (url) =>
    app.evaluate(({ app }, url) => {
      app.emit('open-url', { preventDefault() {} }, url)
    }, url)
  const installed = async () =>
    (await page.evaluate(() => window.hibi.getInstalledAddons())).map(
      ({ manifest }) => manifest.id,
    )

  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^addon manager$/i }).click()
  const addons = page.locator('#settings-addons')
  const gardenTab = addons.getByRole('tab', { name: /^hibi garden$/i })
  const installedTab = addons.getByRole('tab', { name: /^installed$/i })
  const garden = (id) => addons.locator(`[data-setting-id="garden-${id}"]`)
  const row = (id) => addons.locator(`[data-setting-id="addon-${id}"]`)
  const toggle = (id) => addons.locator(`input#addon-${id}`)
  let typing, catalogTheme
  // Each step depends on the previous one. Stop on its failure, before stale UI
  // produces unrelated locator failures and consumes the file's time limit.
  const step = async (name, run) => {
    let completed = false
    await t.test(name, async () => {
      await run()
      completed = true
    })
    assert.ok(completed, `Stopped after "${name}" failed.`)
  }
  const palette = async (label) => {
    await clickMenu(app, 'Command palette')
    const input = page.getByRole('combobox', { name: /search commands/i })
    await input.fill(label)
    const option = page.getByRole('option', { name: new RegExp(label, 'i') })
    await option.first().waitFor()
    return { input, option }
  }
  // The Settings menu item toggles settings, so only open them when closed.
  const openAddonManager = async () => {
    const back = page.getByRole('button', { name: /^back to app$/i })
    if (!(await back.isVisible())) {
      await clickMenu(app, 'Settings')
      await back.waitFor()
    }
    await page.getByRole('tab', { name: /^addon manager$/i }).click()
  }
  // Resolves once the manager is idle again; it stays busy for the whole install.
  const installFromUrl = async (url, { wait = true } = {}) => {
    const button = addons.getByRole('button', { name: /^install from url$/i })
    await button.click()
    const prompt = page.getByRole('dialog', { name: /^install from url$/i })
    await prompt.getByRole('textbox').fill(url)
    await prompt.getByRole('button', { name: /^download$/i }).click()
    if (!wait) return
    await button.and(page.locator(':disabled')).waitFor()
    await button.and(page.locator(':enabled')).waitFor()
  }
  await step(
    'the live directory shows compatible catalog metadata',
    async () => {
      await gardenTab.click()
      await garden('typing-speed').waitFor()
      const directory = await page.evaluate(() =>
        window.hibi.getAddonDirectory(),
      )
      assert.equal(directory.error, undefined)
      for (const entry of directory.entries) {
        assert.equal(entry.apiVersion, 3)
        const metadata = await garden(entry.id).textContent()
        assert.ok(metadata.includes(`v${entry.version}`), metadata)
        assert.ok(metadata.includes(entry.license), metadata)
      }
      typing = directory.entries.find(({ id }) => id === 'typing-speed')
      catalogTheme = directory.entries.find(({ kind }) => kind === 'theme')
      assert.ok(
        typing && catalogTheme,
        'The live catalog needs typing speed and a compatible theme.',
      )
    },
  )

  await step('cancelling the confirmation installs nothing', async () => {
    await answer(0)
    await garden('typing-speed')
      .getByRole('button', { name: `Install ${typing.name}` })
      .click()
    await addons.locator('#garden-typing-speed-install:enabled').waitFor()
    const [box] = await confirmations()
    assert.equal(box.message, `Install ${typing.name} ${typing.version}?`)
    assert.match(box.detail, /Signed by Hibi\./)
    assert.ok(!(await installed()).includes('typing-speed'))
  })

  await step(
    'an install link asks, then installs the signed package',
    async () => {
      await answer(1)
      await link('hibi://addons/install?id=typing-speed')
      await garden('typing-speed')
        .getByText('Installed', { exact: true })
        .waitFor()
      const boxes = await confirmations()
      assert.equal(boxes.length, 2)
      assert.equal(
        boxes[1].message,
        `Install ${typing.name} ${typing.version}?`,
      )
      assert.match(boxes[1].detail, /Signed by Hibi\./)
      assert.ok((await installed()).includes('typing-speed'))
    },
  )

  await step(
    'an open link reveals the installed addon without enabling it',
    async () => {
      await link('hibi://addons/open?id=typing-speed')
      await page.waitForFunction(() =>
        window.document.activeElement?.closest(
          '[data-setting-id="addon-typing-speed"]',
        ),
      )
      assert.equal(await installedTab.getAttribute('aria-selected'), 'true')
      assert.equal(await toggle('typing-speed').isChecked(), false)
      assert.equal((await confirmations()).length, 2)
    },
  )

  await step(
    'typing speed reports while enabled and cleans up when disabled',
    async () => {
      await toggle('typing-speed').click()
      await addons.locator('input#addon-typing-speed:checked:enabled').waitFor()
      await page.getByRole('button', { name: /^back to app$/i }).click()
      const editor = page.getByRole('textbox', {
        name: 'Document editor',
        exact: true,
      })
      await editor.click()
      await page.keyboard.type('the quick brown fox jumps over the lazy dog ', {
        delay: 40,
      })
      const wpm = page.locator('[data-status-id$="wpm"]')
      await page.waitForFunction(() => {
        const label = window.document.querySelector('[data-status-id$="wpm"]')
        return /≈[1-9]\d* wpm/i.test(label?.textContent ?? '')
      })
      assert.match(
        await page.locator('[data-status-id$="cpm"]').innerText(),
        /≈[1-9]\d* cpm/i,
      )
      await openAddonManager()
      await installedTab.click()
      await toggle('typing-speed').click()
      await addons
        .locator('input#addon-typing-speed:not(:checked):enabled')
        .waitFor()
      await wpm.waitFor({ state: 'detached' })
    },
  )

  await step(
    'a compatible garden theme installs signed and falls back when uninstalled',
    async () => {
      await openAddonManager()
      await gardenTab.click()
      const before = (await confirmations()).length
      await garden(catalogTheme.id)
        .getByRole('button', { name: `Install ${catalogTheme.name}` })
        .click()
      await garden(catalogTheme.id)
        .getByText('Installed', { exact: true })
        .waitFor()
      const boxes = await confirmations()
      assert.equal(boxes.length, before + 1)
      assert.equal(
        boxes.at(-1).message,
        `Install ${catalogTheme.name} ${catalogTheme.version}?`,
      )
      assert.match(boxes.at(-1).detail, /Signed by Hibi\./)
      await installedTab.click()
      assert.equal(await toggle(catalogTheme.id).isChecked(), false)
      await toggle(catalogTheme.id).click()
      await toggle(catalogTheme.id)
        .and(page.locator(':checked:enabled'))
        .waitFor()
      const theme = await page.evaluate(
        async (id) =>
          (await window.hibi.getInstalledAddons()).find(
            ({ manifest }) => manifest.id === id,
          ),
        catalogTheme.id,
      )
      const scheme = theme.themes[0]
      assert.ok(scheme)
      const schemeId = `${catalogTheme.id}.${scheme.id}`
      await page.getByRole('tab', { name: /^appearance$/i }).click()
      const appearance = page.locator('#settings-appearance')
      await appearance
        .locator('select#theme-mode')
        .selectOption(scheme.appearance)
      await appearance
        .locator(`select#theme-${scheme.appearance}`)
        .selectOption(schemeId)
      await page.waitForFunction(
        (id) => document.documentElement.dataset.colorscheme === id,
        schemeId,
      )
      await openAddonManager()
      await installedTab.click()
      await row(catalogTheme.id)
        .getByRole('button', { name: /^uninstall$/i })
        .click()
      await row(catalogTheme.id).waitFor({ state: 'detached' })
      await page.waitForFunction(
        (id) => document.documentElement.dataset.colorscheme === id,
        `hibi-${scheme.appearance}`,
      )
      await page.getByRole('tab', { name: /^appearance$/i }).click()
      await appearance.locator('select#theme-mode').selectOption('system')
    },
  )

  await step(
    'uncurated packages stay unsigned and blocked by default',
    async () => {
      await openAddonManager()
      const before = (await confirmations()).length
      await installFromUrl(ADDON_STARTER)
      await page
        .getByText(/Turn on "Allow unsigned addons"/)
        .first()
        .waitFor()
      await installFromUrl(THEME_STARTER)
      await page
        .getByText(/made for an earlier version of Hibi/)
        .first()
        .waitFor()
      // A repository with several packages opens the chooser instead.
      await installFromUrl(TWO_PACKAGES, { wait: false })
      const chooser = page.getByRole('dialog', { name: /^install addons$/i })
      await chooser.waitFor()
      const choices = chooser.getByRole('checkbox')
      assert.equal(await choices.count(), 2)
      for (const choice of await choices.all()) {
        assert.equal(await choice.isEnabled(), false)
        assert.match(
          await choice.evaluate(
            (input) =>
              document.getElementById(input.getAttribute('aria-describedby'))
                .textContent,
          ),
          /made for an earlier version of Hibi/,
        )
      }
      await chooser.getByRole('button', { name: /^cancel$/i }).click()
      await chooser.waitFor({ state: 'hidden' })
      assert.equal((await confirmations()).length, before)
      const ids = await installed()
      assert.ok(!ids.includes('hello') && !ids.includes('hello-theme'))
    },
  )

  await step(
    'unsigned opt-in installs the API 3 starter and still rejects API 2',
    async () => {
      await openAddonManager()
      const allow = addons.getByRole('checkbox', {
        name: 'Allow unsigned addons',
      })
      await allow.scrollIntoViewIfNeeded()
      await allow.click()
      await page
        .getByRole('dialog', { name: /^allow unsigned addons$/i })
        .getByRole('button', { name: /^allow unsigned addons$/i })
        .click()
      // Report why the setting did not stick instead of only timing out.
      const settled = await Promise.race([
        addons
          .locator('#allow-unsigned-addons:checked')
          .waitFor({ state: 'attached', timeout: 15000 })
          .then(() => 'checked'),
        addons
          .getByRole('alert')
          .first()
          .waitFor({ timeout: 15000 })
          .then(() => addons.getByRole('alert').first().innerText()),
      ]).catch(async (error) => {
        await page.screenshot({ path: join(temp, 'allow-unsigned.png') })
        return `${error.message}; trust settings: ${JSON.stringify(
          await page.evaluate(() => window.hibi.getAddonTrustSettings()),
        )}`
      })
      assert.equal(settled, 'checked')
      await answer(1)
      const before = (await confirmations()).length
      await installFromUrl(ADDON_STARTER)
      assert.ok(
        (await installed()).includes('hello'),
        'hello was not installed',
      )
      const boxes = await confirmations()
      assert.equal(boxes.length, before + 1)
      assert.equal(boxes.at(-1).message, 'Install Hello 1.0.0?')
      assert.match(boxes.at(-1).detail, /Unsigned\./)
      await installFromUrl(THEME_STARTER)
      await page
        .getByText(/made for an earlier version of Hibi/)
        .first()
        .waitFor()
      assert.ok(!(await installed()).includes('hello-theme'))
      assert.equal((await confirmations()).length, before + 1)
    },
  )

  await step(
    'the starter extension greets and remembers its count',
    async () => {
      await openAddonManager()
      await installedTab.click()
      await toggle('hello').click()
      await addons.locator('input#addon-hello:checked:enabled').waitFor()
      for (const message of [
        'Hello from your Hibi addon.',
        'Hello again. You have said hello 2 times.',
      ]) {
        const { input } = await palette('Say hello')
        await input.press('Enter')
        await page.getByText(message, { exact: true }).first().waitFor()
      }
    },
  )

  await step('garden rows uninstall and offer the install again', async () => {
    await openAddonManager()
    await gardenTab.click()
    await garden('typing-speed')
      .getByRole('button', { name: `Uninstall ${typing.name}` })
      .click()
    await garden('typing-speed')
      .getByRole('button', { name: `Install ${typing.name}` })
      .and(page.locator(':enabled'))
      .waitFor()
    assert.ok(!(await installed()).includes('typing-speed'))
  })

  assert.deepEqual(errors, [])
})
