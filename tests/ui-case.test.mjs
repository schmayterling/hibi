import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

test('sentence case is default; lowercase covers UI and menus while preserving content and persists', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-ui-case-'))
  let app
  async function launch() {
    app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${profile}`],
    })
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    const page = await app.firstWindow()
    // Give a cold native renderer its own startup deadline; interactions stay strict.
    await page
      .getByRole('textbox', { name: /document editor/i })
      .waitFor({ timeout: 15000 })
      .catch(async (error) => {
        throw new Error(
          `editor did not start: ${(await page.locator('body').innerText()).slice(0, 1200)}`,
          { cause: error },
        )
      })
    page.setDefaultTimeout(6500)
    return page
  }
  t.after(async () => {
    await app?.close()
    await rm(profile, { recursive: true, force: true })
  })
  let page = await launch()
  await app.evaluate(({ Menu }) => {
    globalThis.initialHibiMenu = Menu.getApplicationMenu()
  })
  await page.evaluate(() => window.hibi.setUiCase('sentence'))
  assert.equal(
    await app.evaluate(
      ({ Menu }) => globalThis.initialHibiMenu === Menu.getApplicationMenu(),
    ),
    true,
  )
  assert.equal(
    await page.locator('.startup-placeholder h2').innerText(),
    'Start typing',
  )
  assert.equal(
    await app.evaluate(
      ({ Menu }) =>
        Menu.getApplicationMenu().items.find(
          (item) => item.label.toLowerCase() === 'file',
        ).label,
    ),
    'File',
  )
  await page
    .getByRole('textbox', { name: /document editor/i })
    .fill('CaseSensitiveValue')
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^appearance$/i }).click()
  assert.equal(
    await page.locator('#settings-appearance h1').innerText(),
    'Appearance',
  )
  await page.getByRole('checkbox', { name: /^lowercase interface$/i }).check()
  assert.equal(
    await page.locator('#settings-appearance h1').innerText(),
    'appearance',
  )
  await page.evaluate(() => {
    const button = document.createElement('button')
    button.id = 'extension-case'
    button.className = 'ui-button'
    button.textContent = 'Extension Action'
    document.body.append(button)
    const command = document.createElement('span')
    command.id = 'verbatim-case'
    command.dataset.verbatim = 'true'
    command.textContent = 'gU'
    document.body.append(command)
  })
  assert.equal(
    await page.locator('#extension-case').innerText(),
    'extension action',
  )
  assert.equal(await page.locator('#verbatim-case').innerText(), 'gU')
  assert.equal(
    await page.locator('#extension-case').textContent(),
    'Extension Action',
  )
  await page.getByRole('tab', { name: /^addon manager$/i }).click()
  const filter = page.getByRole('searchbox', { name: /^filter addons$/i })
  await filter.fill('GitHubCase')
  assert.equal(await filter.inputValue(), 'GitHubCase')
  assert.equal(
    await filter.evaluate((input) => getComputedStyle(input).textTransform),
    'none',
  )
  assert.equal(
    await filter.evaluate(
      (input) => getComputedStyle(input, '::placeholder').textTransform,
    ),
    'lowercase',
  )
  await page.getByRole('button', { name: /^back to app$/i }).click()
  const rich = page.getByRole('textbox', { name: /document editor/i })
  assert.equal(await rich.innerText(), 'CaseSensitiveValue')
  assert.equal(
    await rich.evaluate((editor) => getComputedStyle(editor).textTransform),
    'none',
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'CaseSensitiveValue',
  )
  assert.equal(
    JSON.parse(await readFile(join(profile, 'ui-case.json'), 'utf8')),
    'lowercase',
  )
  assert.equal(
    await app.evaluate(
      ({ Menu }) =>
        Menu.getApplicationMenu().items.find(
          (item) => item.label.toLowerCase() === 'file',
        ).label,
    ),
    'file',
  )
  await app.close()
  app = null
  page = await launch()
  assert.equal(
    await page.locator('html').getAttribute('data-ui-case'),
    'lowercase',
  )
  assert.equal(
    await page.locator('.startup-placeholder h2').innerText(),
    'start typing',
  )
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^appearance$/i }).click()
  await page.getByRole('checkbox', { name: /^lowercase interface$/i }).uncheck()
  assert.equal(
    await page.locator('#settings-appearance h1').innerText(),
    'Appearance',
  )
})
