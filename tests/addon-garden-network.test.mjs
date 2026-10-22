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
  '422be6feaf5cd0edea8d45deac6938b71210567a',
)
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
  const until = async (check, message) => {
    for (const deadline = Date.now() + 15000; Date.now() < deadline; ) {
      if (await check()) return
      await new Promise((done) => setTimeout(done, 200))
    }
    assert.fail(message)
  }

  await t.test('the live directory lists signed typing speed', async () => {
    await gardenTab.click()
    await garden('typing-speed').waitFor()
    await garden('hibi-doom').waitFor()
    assert.match(await garden('typing-speed').innerText(), /GPL-3\.0-only/)
  })

  await t.test('cancelling the confirmation installs nothing', async () => {
    await answer(0)
    await garden('typing-speed')
      .getByRole('button', { name: 'Install Typing speed' })
      .click()
    await addons.locator('#garden-typing-speed-install:enabled').waitFor()
    const [box] = await confirmations()
    assert.equal(box.message, 'Install Typing speed 1.1.1?')
    assert.match(box.detail, /Signed by Hibi\./)
    await until(
      async () => !(await installed()).includes('typing-speed'),
      'typing-speed is still installed after Uninstall',
    )
  })

  await t.test(
    'an install link asks, then installs the signed package',
    async () => {
      await answer(1)
      await link('hibi://addons/install?id=typing-speed')
      await garden('typing-speed')
        .getByText('Installed', { exact: true })
        .waitFor()
      const boxes = await confirmations()
      assert.equal(boxes.length, 2)
      assert.match(boxes[1].detail, /Signed by Hibi\./)
      assert.ok((await installed()).includes('typing-speed'))
    },
  )

  await t.test(
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

  await t.test(
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

  await t.test(
    'curated doom installs signed without unsigned opt-in',
    async () => {
      await openAddonManager()
      await gardenTab.click()
      await answer(1)
      const before = (await confirmations()).length
      await garden('hibi-doom')
        .getByRole('button', { name: 'Install Doom' })
        .click()
      await garden('hibi-doom')
        .getByText('Installed', { exact: true })
        .waitFor()
      const boxes = await confirmations()
      assert.equal(boxes.length, before + 1)
      assert.equal(boxes.at(-1).message, 'Install Doom 0.4.1?')
      assert.match(boxes.at(-1).detail, /Signed by Hibi\./)
      assert.match(boxes.at(-1).detail, /gist\.githubusercontent\.com/)
      await installedTab.click()
      await toggle('hibi-doom').click()
      await addons.locator('input#addon-hibi-doom:checked:enabled').waitFor()
      // Running the command loads the addon's code and opens its tab. The first
      // game downloads Doom's shareware data from the addon's declared origin.
      const { input } = await palette('Play Doom')
      await input.press('Enter')
      const game = page.locator('section[aria-label="Doom game"]')
      await game.waitFor()
      await game.locator('canvas[aria-label="Doom canvas"]').waitFor()
      await page
        .waitForFunction(
          () =>
            window.document.querySelector('section[aria-label="Doom game"]')
              ?.dataset.state === 'ready',
          null,
          { timeout: 120000 },
        )
        .catch(async (error) => {
          throw new Error(
            `Doom did not become ready (state ${await game.getAttribute('data-state')}): ${await game.innerText()}`,
            { cause: error },
          )
        })
    },
  )

  await t.test(
    'uncurated packages stay unsigned and blocked by default',
    async () => {
      await openAddonManager()
      const before = (await confirmations()).length
      await installFromUrl(
        'https://github.com/ralphbibera/hibi-doom/tree/446296f572ba80ba6290fba864f104412794bca2/addon',
      )
      await page
        .getByText(/Turn on "Allow unsigned addons"/)
        .first()
        .waitFor()
      for (const url of [ADDON_STARTER, THEME_STARTER]) {
        await installFromUrl(url)
        await page
          .getByText(/Turn on "Allow unsigned addons"/)
          .first()
          .waitFor()
      }
      // A repository with several packages opens the chooser instead.
      await installFromUrl(TWO_PACKAGES, { wait: false })
      const chooser = page.getByRole('dialog', { name: /^install addons$/i })
      await chooser.waitFor()
      for (const name of ['Hello', 'Hello theme'])
        assert.equal(
          await chooser
            .getByRole('checkbox', { name, exact: true })
            .isEnabled(),
          false,
        )
      await chooser.getByRole('button', { name: /^cancel$/i }).click()
      await chooser.waitFor({ state: 'hidden' })
      assert.equal((await confirmations()).length, before)
      const ids = await installed()
      assert.ok(!ids.includes('hello') && !ids.includes('hello-theme'))
    },
  )

  await t.test(
    'allowing unsigned addons installs both starters from their commits',
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
      for (const [url, id, message] of [
        [ADDON_STARTER, 'hello', 'Install Hello 1.0.0?'],
        [THEME_STARTER, 'hello-theme', 'Install Hello theme 1.0.0?'],
      ]) {
        const before = (await confirmations()).length
        await installFromUrl(url)
        assert.ok((await installed()).includes(id), `${id} was not installed`)
        const boxes = await confirmations()
        assert.equal(boxes.length, before + 1)
        assert.equal(boxes.at(-1).message, message)
        assert.match(boxes.at(-1).detail, /Unsigned\./)
      }
    },
  )

  await t.test(
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

  await t.test(
    'the starter theme is selectable and falls back when uninstalled',
    async () => {
      await openAddonManager()
      await installedTab.click()
      await toggle('hello-theme').click()
      await addons.locator('input#addon-hello-theme:checked:enabled').waitFor()
      await page.getByRole('tab', { name: /^appearance$/i }).click()
      const appearance = page.locator('#settings-appearance')
      const light = appearance.locator('select#theme-light')
      await light
        .locator('option[value="hello-theme.light"]')
        .waitFor({ state: 'attached' })
      assert.equal(
        await light.locator('option[value="hello-theme.light"]').textContent(),
        'Hello light',
      )
      await appearance.locator('select#theme-mode').selectOption('dark')
      await appearance
        .locator('select#theme-dark')
        .selectOption('hello-theme.dark')
      await page.waitForFunction(
        () =>
          window.document.documentElement.dataset.colorscheme ===
          'hello-theme.dark',
      )
      await openAddonManager()
      await installedTab.click()
      await row('hello-theme')
        .getByRole('button', { name: /^uninstall$/i })
        .click()
      await row('hello-theme').waitFor({ state: 'detached' })
      await page.waitForFunction(
        () =>
          window.document.documentElement.dataset.colorscheme === 'hibi-dark',
      )
      await page.getByRole('tab', { name: /^appearance$/i }).click()
      await page
        .locator('#settings-appearance select#theme-mode')
        .selectOption('system')
    },
  )

  await t.test(
    'garden rows uninstall and offer the install again',
    async () => {
      await openAddonManager()
      await gardenTab.click()
      await garden('typing-speed')
        .getByRole('button', { name: 'Uninstall Typing speed' })
        .click()
      await garden('typing-speed')
        .getByRole('button', { name: 'Install Typing speed' })
        .waitFor()
      await until(
        async () => !(await installed()).includes('typing-speed'),
        'Typing speed is still installed after Uninstall.',
      )
    },
  )

  assert.deepEqual(errors, [])
})
