import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

async function appearance(app, page) {
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Appearance', exact: true }).click()
  return page.getByRole('checkbox', {
    name: 'Hide window controls',
    exact: true,
  })
}

const padding = (page) =>
  page
    .locator('.titlebar')
    .evaluate((bar) => getComputedStyle(bar).paddingRight)

test('window controls setting is available only on Linux', async (t) => {
  const profile = await mkdtemp(
    join(tmpdir(), 'hibi-window-controls-platform-'),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  const toggle = await appearance(app, page)
  assert.equal(await toggle.count(), process.platform === 'linux' ? 1 : 0)
  for (const value of [null, 'true', 1, {}])
    await assert.rejects(
      page.evaluate((value) => window.hibi.setHideWindowControls(value), value),
      /Invalid window controls setting/,
    )
  if (process.platform !== 'linux')
    await assert.rejects(
      page.evaluate(() => window.hibi.setHideWindowControls(true)),
      /Invalid window controls setting/,
    )
})

test('Linux window controls persist and apply to main and addon windows after restart', {
  skip: process.platform !== 'linux',
  timeout: 60000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-window-controls-'))
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'quick-note': true }),
  )
  let app
  t.after(async () => {
    await app?.close()
    await rm(profile, { recursive: true, force: true })
  })
  const launch = async () => {
    app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${profile}`],
    })
    const page = await app.firstWindow()
    await page.locator('.app[data-platform="linux"]').waitFor()
    return page
  }
  const addon = async (page, hidden) => {
    await page.evaluate(() =>
      window.hibi.openAddonWindow('quick-note', {
        id: 'capture',
        titleBar: 'hibi',
        show: false,
      }),
    )
    const window = app
      .windows()
      .find((page) => page.url().endsWith('/addon-window.html'))
    assert.ok(window)
    await window.locator('.addon-window-titlebar').waitFor()
    const context = await window.evaluate(() =>
      window.hibiAddonWindow.context(),
    )
    assert.equal(context.windowControlsHidden, hidden)
    assert.equal(await padding(window), hidden ? '8px' : '140px')
  }

  let page = await launch()
  let toggle = await appearance(app, page)
  await toggle.waitFor({ state: 'visible' })
  assert.equal(await toggle.isChecked(), false)
  assert.equal(await padding(page), '140px')
  await toggle.check()
  await page.waitForFunction(
    () => !document.querySelector('#hide-window-controls').disabled,
  )
  assert.equal(
    JSON.parse(await readFile(join(profile, 'window-controls.json'), 'utf8')),
    true,
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getAppInfo())).windowControlsHidden,
    false,
  )
  assert.equal(await padding(page), '140px')
  // New addon windows use the applied state, even after changing the preference.
  await addon(page, false)
  await app.close()
  app = null

  page = await launch()
  toggle = await appearance(app, page)
  await page.waitForFunction(
    () => document.querySelector('#hide-window-controls')?.checked,
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getAppInfo())).windowControlsHidden,
    true,
  )
  assert.equal(await padding(page), '8px')
  await addon(page, true)
  // Theme changes must not try to update a disabled native overlay.
  await page.evaluate(() =>
    window.hibi.setAppearance({
      preferences: { mode: 'dark', light: 'hibi-light', dark: 'hibi-dark' },
      light: { background: '#ffffff', foreground: '#1b2021' },
      dark: { background: '#181818', foreground: '#e4e9e9' },
    }),
  )
  assert.equal(await padding(page), '8px')
  await toggle.uncheck()
  await page.waitForFunction(
    () => !document.querySelector('#hide-window-controls').disabled,
  )
  assert.equal(
    JSON.parse(await readFile(join(profile, 'window-controls.json'), 'utf8')),
    false,
  )
  assert.equal(await padding(page), '8px')
  await app.close()
  app = null

  page = await launch()
  toggle = await appearance(app, page)
  assert.equal(await toggle.isChecked(), false)
  assert.equal(await padding(page), '140px')
  await addon(page, false)
})

test('a failed window controls save keeps the preference and allows a retry', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-window-controls-failure-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  const toggle = await appearance(app, page)
  await mkdir(join(profile, 'window-controls.json'))
  await toggle.click()
  await page.getByText('Window controls unavailable', { exact: true }).waitFor()
  assert.equal(await toggle.isChecked(), false)
  assert.equal(
    await page.evaluate(() => window.hibi.getHideWindowControls()),
    false,
  )
  await rm(join(profile, 'window-controls.json'), { recursive: true })
  await toggle.check()
  await page.waitForFunction(
    () => !document.querySelector('#hide-window-controls').disabled,
  )
  assert.equal(await toggle.isChecked(), true)
  assert.equal(
    JSON.parse(await readFile(join(profile, 'window-controls.json'), 'utf8')),
    true,
  )
})
