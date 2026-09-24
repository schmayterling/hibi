import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('Discord addon is opt-in, documents setup, validates IDs and persists privacy controls without real Discord traffic', {
  timeout: 45000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-discord-settings-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  await app.evaluate(({ shell }) => {
    globalThis.discordUrls = []
    shell.openExternal = async (url) => {
      globalThis.discordUrls.push(url)
    }
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(8000)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 1100, height: 900 })
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  // Keep this UI test offline even though Hibi ships an application ID.
  await page.evaluate(() =>
    localStorage.setItem(
      'discord-presence:preferences',
      JSON.stringify({
        applicationId: '',
        showDocumentName: false,
        showElapsed: true,
      }),
    ),
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getAddonStates())).find(
      (addon) => addon.id === 'discord-presence',
    ).enabled,
    false,
  )
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^addon manager$/i }).click()
  await page.locator('#addon-discord-presence').click()
  await page.getByRole('tab', { name: /^discord rich presence$/i }).click()
  const id = page.getByRole('textbox', { name: /^application id$/i })
  await id.waitFor()
  assert.equal(await id.inputValue(), '')
  await page
    .getByText('Add a Discord application ID to connect.', { exact: true })
    .waitFor()
  const locked = await page.evaluate(async () => {
    const app = document.querySelector('.app')
    let locked = false
    const observer = new MutationObserver(() => {
      locked ||= app.getAttribute('aria-busy') === 'true'
    })
    observer.observe(app, { attributes: true, attributeFilter: ['aria-busy'] })
    window.dispatchEvent(new Event('hibi:discord-presence-settings'))
    await window.hibi.queryAddon('discord-presence', 'status')
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    )
    observer.disconnect()
    return locked
  })
  assert.equal(locked, false, 'presence refresh never locks the editor')
  const names = page.getByRole('checkbox', { name: /^show document name$/i })
  const elapsed = page.getByRole('checkbox', { name: /^show elapsed time$/i })
  assert.equal(await names.isChecked(), false)
  assert.equal(await elapsed.isChecked(), true)
  await id.fill('not-a-token')
  await id.press('Enter')
  await page
    .getByText('Enter a numeric Discord application ID, not a bot token.', {
      exact: true,
    })
    .waitFor()
  assert.equal(await id.getAttribute('aria-invalid'), 'true')
  assert.equal(
    await page.evaluate(() =>
      localStorage.getItem('discord-presence:preferences'),
    ),
    JSON.stringify({
      applicationId: '',
      showDocumentName: false,
      showElapsed: true,
    }),
  )
  await id.fill('')
  await id.press('Enter')
  await names.check()
  await elapsed.uncheck()
  const preferences = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('discord-presence:preferences')),
  )
  assert.deepEqual(preferences, {
    applicationId: '',
    showDocumentName: true,
    showElapsed: false,
  })
  await page.getByRole('button', { name: /^open developer portal$/i }).click()
  assert.deepEqual(await app.evaluate(() => globalThis.discordUrls), [
    'https://discord.com/developers/applications',
  ])
  await mkdir('test-results', { recursive: true })
  assert.ok(
    (
      await page
        .locator('[data-setting-id="discord-application-id"] .setting-copy')
        .boundingBox()
    ).width >= 240,
    'application ID field leaves room for its description',
  )
  await page.screenshot({ path: 'test-results/discord-presence-settings.png' })
  await page.setViewportSize({ width: 640, height: 900 })
  await page.waitForFunction(
    () =>
      document
        .querySelector('.settings-screen')
        ?.getAttribute('data-sidebar-overlay') === 'true' &&
      document
        .querySelector('.settings-screen')
        ?.getAttribute('data-sidebar') === 'false',
  )
  assert.equal(
    await page
      .locator('.settings-content')
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
    true,
  )
  await page.waitForFunction(() => {
    const sidebar = document.querySelector('.settings-sidebar .sidebar')
    return sidebar && getComputedStyle(sidebar).visibility === 'hidden'
  })
  await id.focus()
  await page.mouse.move(620, 880)
  await page.screenshot({
    path: 'test-results/discord-presence-settings-narrow.png',
  })
  await page.setViewportSize({ width: 1100, height: 900 })
  await page.waitForFunction(
    () =>
      document
        .querySelector('.settings-screen')
        ?.getAttribute('data-sidebar-overlay') === 'false' &&
      document
        .querySelector('.settings-screen')
        ?.getAttribute('data-sidebar') === 'true',
  )
  await page.reload()
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^discord rich presence$/i }).click()
  assert.equal(await names.isChecked(), true)
  assert.equal(await elapsed.isChecked(), false)
  await page.getByRole('tab', { name: /^addon manager$/i }).click()
  await page.locator('#addon-discord-presence').click()
  await waitForAsync(
    page,
    async () =>
      !(await window.hibi.getAddonStates()).find(
        (addon) => addon.id === 'discord-presence',
      ).enabled,
  )
  await assert.rejects(
    page.evaluate(() => window.hibi.queryAddon('discord-presence', 'status')),
    /Enable this addon/,
  )
})
