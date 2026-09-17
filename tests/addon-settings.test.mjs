import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { zipFiles } from './zip.mjs'

test('compact filters reset preferences, group addons, and install reviewed url packages disabled', {
  timeout: 45000,
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'hibi-addon-settings-'))
  const profile = join(temp, 'profile'),
    zip = join(temp, 'addon.zip')
  await writeFile(
    zip,
    zipFiles([
      {
        name: 'hibi-addon.json',
        content: JSON.stringify({
          id: 'url-fixture',
          name: 'url fixture',
          description: 'downloaded package fixture',
          kind: 'extension',
          apiVersion: 1,
          version: '1.0.0',
          authors: [{ displayName: 'test author' }],
          entry: 'index.js',
        }),
      },
      { name: 'README.md', content: 'url package fixture' },
      {
        name: 'index.js',
        content:
          'export default () => ({ start() { window.urlFixtureStarted = true } })',
      },
    ]),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(temp, { recursive: true, force: true })
  })
  await app.evaluate(({ shell, dialog }, zip) => {
    globalThis.openedAddonLinks = []
    shell.openExternal = async (url) => {
      globalThis.openedAddonLinks.push(url)
    }
    shell.openPath = async (path) => {
      globalThis.openedAddonFolder = path
      return ''
    }
    globalThis.reviewedAddon = null
    dialog.showMessageBox = async (_window, options) => {
      globalThis.reviewedAddon = options
      return { response: 1 }
    }
    globalThis.fetch = async (url) => {
      if (String(url) !== 'https://example.com/addon.zip')
        throw new Error('unexpected network request')
      return new Response(
        await process.getBuiltinModule('fs/promises').readFile(zip),
        { headers: { 'content-type': 'application/zip' } },
      )
    }
  }, zip)
  const page = await app.firstWindow()
  page.setDefaultTimeout(6500)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^addons$/i, exact: true }).click()
  const addons = page.locator('#settings-addons')
  assert.equal(
    await addons
      .locator('.addon-state-group[data-enabled="true"] #addon-frontmatter')
      .isChecked(),
    true,
  )
  await addons.getByRole('searchbox', { name: /filter addons/i }).fill('vim')
  assert.equal(await addons.locator('.setting-row:visible').count(), 1)
  assert.match(
    await addons.locator('.setting-row:visible .addon-metadata').innerText(),
    /Built-in/,
  )
  await addons.locator('#addon-vim').click()
  await addons
    .locator('.addon-state-group[data-enabled="true"] #addon-vim')
    .waitFor()
  await page.waitForFunction(() => document.activeElement?.id === 'addon-vim')
  await addons
    .getByRole('button', { name: /^reset all$/i, exact: true })
    .click()
  await addons
    .locator('.addon-state-group[data-enabled="false"] #addon-vim')
    .waitFor()
  await addons.getByRole('button', { name: /hibi garden/i }).click()
  assert.deepEqual(await app.evaluate(() => globalThis.openedAddonLinks), [
    'https://hibi.garden/addons',
  ])
  await addons.getByRole('button', { name: /open plugins folder/i }).click()
  assert.equal(
    await app.evaluate(() => globalThis.openedAddonFolder),
    join(profile, 'installed-addons'),
  )
  await addons.getByRole('button', { name: /install from url/i }).click()
  const prompt = page.getByRole('dialog', {
    name: /^install from url$/i,
    exact: true,
  })
  await prompt.getByLabel(/addon url/i).fill('file:///etc/passwd')
  await prompt.getByRole('button', { name: /^download$/i, exact: true }).click()
  await prompt.locator('[role="alert"]').waitFor()
  await prompt.getByLabel(/addon url/i).fill('https://example.com/addon.zip')
  await prompt.getByRole('button', { name: /^download$/i, exact: true }).click()
  await prompt.waitFor({ state: 'hidden' })
  await addons
    .getByRole('searchbox', { name: /filter addons/i })
    .fill('url fixture')
  const installed = addons.locator(
    '.addon-state-group[data-enabled="false"] #addon-url-fixture',
  )
  await installed.waitFor()
  assert.equal(await installed.isChecked(), false)
  assert.match(
    await addons.locator('.setting-row:visible .addon-metadata').innerText(),
    /Third-party/,
  )
  assert.equal(await page.evaluate(() => window.urlFixtureStarted), undefined)
  assert.match(
    (await app.evaluate(() => globalThis.reviewedAddon)).detail,
    /downloaded from example.com/,
  )
  assert.equal(
    JSON.parse(
      await readFile(
        join(profile, 'installed-addons/url-fixture/.hibi-install.json'),
        'utf8',
      ),
    ).source,
    'third-party',
  )
  await installed.click()
  await page.waitForFunction(() => window.urlFixtureStarted === true)
  await page.getByRole('tab', { name: /^syntax$/i, exact: true }).click()
  const syntax = page.locator('#settings-syntax')
  await syntax.getByRole('checkbox', { name: /^italic$/i, exact: true }).click()
  await syntax.getByRole('searchbox', { name: /filter syntax/i }).fill('bold')
  assert.equal(await syntax.locator('.setting-row:visible').count(), 1)
  await syntax
    .getByRole('button', { name: /^reset all$/i, exact: true })
    .click()
  assert.equal(
    await syntax
      .getByRole('button', { name: /^reset all$/i, exact: true })
      .isDisabled(),
    true,
  )
  await syntax.getByRole('searchbox', { name: /filter syntax/i }).fill('')
  assert.equal(
    await syntax
      .getByRole('checkbox', { name: /^italic$/i, exact: true })
      .isChecked(),
    true,
  )
  await page
    .getByRole('tab', { name: /^code highlighting$/i, exact: true })
    .click()
  const code = page.locator('#settings-code-syntax')
  await code.getByRole('checkbox', { name: /^python$/i, exact: true }).click()
  await code
    .getByRole('searchbox', { name: /filter languages/i })
    .fill('javascript')
  assert.equal(await code.locator('.setting-row:visible').count(), 1)
  await code.getByRole('button', { name: /^reset all$/i, exact: true }).click()
  await pressShortcut(
    app,
    `${process.platform === 'darwin' ? 'Meta' : 'Control'}+k`,
  )
  await page.getByRole('combobox', { name: /search commands/i }).fill('python')
  await page
    .getByRole('option')
    .filter({ has: page.getByText(/^python$/i, { exact: true }) })
    .first()
    .click()
  await code.getByRole('checkbox', { name: /^python$/i, exact: true }).waitFor()
  assert.equal(
    await code
      .getByRole('searchbox', { name: /filter languages/i })
      .inputValue(),
    '',
  )
  assert.deepEqual(errors, [])
})
