import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('toolbar placements persist, keep menu-only actions in overflow, and recover from all hidden', {
  timeout: 60000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-toolbar-placement-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 1800, height: 900 })
  await page.evaluate(() =>
    localStorage.setItem(
      'hibi:toolbar',
      JSON.stringify({
        autoHide: false,
        placements: {
          'format.table-delete': 'menu',
          'future.action': 'menu',
          'bad id': 'hidden',
          'format.bold': 'invalid',
        },
      }),
    ),
  )
  await page.reload()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const rich = page.getByRole('textbox', { name: /document editor/i })
  await rich.fill('hello')
  const bar = page.getByRole('navigation', { name: /editor toolbar/i })
  const inline = (id) =>
    bar.locator(`:scope > [data-toolbar-id="format.${id}"]`)
  const menu = bar.getByRole('menu', { name: /more formatting actions/i })
  const more = bar.getByRole('button', { name: /more formatting actions/i })
  await inline('bold').waitFor()
  assert.equal(
    await more.isVisible(),
    false,
    'wide toolbar initially fits every action',
  )
  const openSettings = async () => {
    await clickMenu(app, 'Settings')
    await page.getByRole('tab', { name: /^appearance$/i }).click()
    const disclosure = page.locator('.toolbar-order')
    if ((await disclosure.getAttribute('open')) === null)
      await disclosure.locator('summary').click()
  }
  const place = async (id, value) => {
    await page
      .locator(`.toolbar-order [data-toolbar-id="format.${id}"] button`)
      .click()
    await page
      .getByRole('combobox', { name: /toolbar placement for/i })
      .selectOption(value)
  }
  const closeSettings = async () => {
    await page.getByRole('button', { name: /back to app/i }).click()
    await page.locator('.settings-screen').waitFor({ state: 'hidden' })
  }
  const preferences = () =>
    page.evaluate(() => JSON.parse(localStorage.getItem('hibi:toolbar')))
  await openSettings()
  await place('bold', 'menu')
  await place('italic', 'hidden')
  const saved = await preferences()
  assert.deepEqual(saved.placements, {
    'format.table-delete': 'menu',
    'future.action': 'menu',
    'format.bold': 'menu',
    'format.italic': 'hidden',
  })
  await place('bold', 'menu')
  await page.getByRole('button', { name: /^move bold earlier$/i }).click()
  await page.getByRole('button', { name: /^reset order$/i }).click()
  assert.deepEqual((await preferences()).placements, saved.placements)
  const ids = await page
    .locator('.toolbar-order li')
    .evaluateAll((items) => items.map((item) => item.dataset.toolbarId))
  await mkdir('test-results', { recursive: true })
  await page.screenshot({
    path: 'test-results/toolbar-placements-settings.png',
  })
  await closeSettings()
  assert.equal(await inline('bold').count(), 0)
  assert.equal(
    await bar.locator('[data-toolbar-id="format.italic"]').count(),
    0,
  )
  await rich.press('Control+a')
  await more.click()
  await menu.waitFor()
  assert.equal(await menu.locator('[data-toolbar-id]').count(), 1)
  await menu.getByRole('menuitemcheckbox', { name: /^bold$/i }).click()
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).markdown === '**hello**',
  )
  for (const width of [480, 1800]) {
    await page.setViewportSize({ width, height: 900 })
    await more.click()
    await menu.locator('[data-toolbar-id="format.bold"]').waitFor()
    assert.equal(await inline('bold').count(), 0)
    assert.equal(
      await bar.locator('[data-toolbar-id="format.italic"]').count(),
      0,
    )
    assert.equal(
      await bar.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
      true,
    )
    if (width === 480)
      assert.ok((await menu.locator('[data-toolbar-id]').count()) > 1)
    await page.screenshot({
      path: `test-results/toolbar-placements-${width}.png`,
    })
    await page.keyboard.press('Escape')
  }
  await page.reload()
  await more.waitFor()
  assert.equal(await inline('bold').count(), 0)
  assert.deepEqual((await preferences()).placements, saved.placements)
  // Exercise a toolbar with only menu actions, then no actions, using the same persisted preferences.
  await page.evaluate((ids) => {
    const prefs = JSON.parse(localStorage.getItem('hibi:toolbar'))
    prefs.placements = Object.fromEntries(
      ids.map((id) => [id, id === 'format.bold' ? 'menu' : 'hidden']),
    )
    localStorage.setItem('hibi:toolbar', JSON.stringify(prefs))
  }, ids)
  await page.reload()
  await more.waitFor()
  assert.equal(await bar.locator(':scope > [data-toolbar-id]').count(), 0)
  await openSettings()
  await place('bold', 'hidden')
  await closeSettings()
  await bar.waitFor({ state: 'hidden' })
  await openSettings()
  await place('bold', 'toolbar')
  await closeSettings()
  await inline('bold').waitFor()
  assert.equal(await more.isVisible(), false)
  assert.equal((await preferences()).placements['format.bold'], undefined)
  assert.deepEqual(errors, [])
})
