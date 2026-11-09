import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'

const shots = process.env.TOAST_SHOTS

test('the update notice opens About at the update status by click or keyboard', {
  timeout: 45000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-clickable-toasts-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await waitForDocumentEditor(app, page)
  await page.waitForFunction(() => document.activeElement?.isContentEditable)
  const notify = () =>
    app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents
      contents.send('updates:changed', {
        channel: 'nightly-green',
        status: 'available',
        supported: true,
        checkOnStartup: true,
        checkFrequency: 6,
        version: '0.1.0-nightly.20261012.gbbbbbbb.20.1',
        message: 'An update is available: 0.1.0-nightly.20261012.gbbbbbbb.20.1',
      })
      contents.send('document:notice', 'A Hibi update is available.', 'updates')
    })
  const settings = page.getByRole('main', { name: /^settings$/i })
  const about = page.getByRole('tabpanel', { name: 'About', exact: true })
  const status = page.locator('[data-setting-id="install-update"]')
  const action = page.getByRole('button', {
    name: 'A Hibi update is available. Open update settings.',
    exact: true,
  })
  const toast = page.locator('.toast').filter({ has: action })

  // Showing the notice never moves focus.
  await notify()
  await toast.waitFor()
  assert.equal(
    await page.evaluate(() => document.activeElement?.isContentEditable),
    true,
  )
  assert.equal(
    await toast.evaluate((element) => getComputedStyle(element).cursor),
    'pointer',
  )
  await toast.locator('.toast-copy').click({ position: { x: 4, y: 8 } })
  await settings.waitFor()
  await about.waitFor()
  await status.waitFor()
  assert.equal(await status.isVisible(), true)
  await page.waitForFunction(() => {
    const row = document.querySelector('[data-setting-id="install-update"]')
    const box = row?.getBoundingClientRect()
    return box && box.top >= 0 && box.bottom <= innerHeight
  })
  await toast.waitFor({ state: 'detached' })

  // Keyboard: Focus notifications ships unbound; once bound it focuses the newest notice.
  await page.getByRole('tab', { name: 'Editor', exact: true }).click()
  const tab = page.getByRole('tab', { name: 'Editor', exact: true })
  await tab.focus()
  await notify()
  await toast.waitFor()
  const focus = `${process.platform === 'darwin' ? 'Meta' : 'Control'}+Shift+N`
  const hotkeys = await page.evaluate(() => window.hibi.getHotkeys())
  assert.equal(hotkeys['focus-notifications'], '')
  await pressShortcut(app, focus, { delivered: true })
  await page.evaluate(() => new Promise(requestAnimationFrame))
  assert.equal(
    await tab.evaluate((element) => element === document.activeElement),
    true,
  )
  await page.evaluate((next) => window.hibi.saveHotkeys(next), {
    ...hotkeys,
    'focus-notifications': `${process.platform === 'darwin' ? 'meta' : 'ctrl'}+shift+n`,
  })
  await pressShortcut(app, focus)
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute('aria-label') ===
      'A Hibi update is available. Open update settings.',
  )
  // Plain Tab never enters the stack; inside it, Tab and arrows move between buttons.
  assert.deepEqual(
    await toast
      .locator('button')
      .evaluateAll((buttons) => buttons.map((button) => button.tabIndex)),
    [-1, -1],
  )
  await page.keyboard.press('Tab')
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute('aria-label') === 'Dismiss notice',
  )
  await page.keyboard.press('ArrowLeft')
  await page.waitForFunction(() =>
    document.activeElement?.classList.contains('toast-action'),
  )
  await page.keyboard.press('Escape')
  await toast.waitFor({ state: 'detached' })
  assert.equal(await settings.isVisible(), true)
  assert.equal(
    await tab.evaluate((element) => element === document.activeElement),
    true,
  )

  await notify()
  await toast.waitFor()
  await pressShortcut(app, focus)
  await page.waitForFunction(() =>
    document.activeElement?.classList.contains('toast-action'),
  )
  await page.keyboard.press('Enter')
  await about.waitFor()
  await status.waitFor()
  await toast.waitFor({ state: 'detached' })
  await page.waitForFunction(() =>
    document
      .querySelector('[data-setting-id="install-update"]')
      ?.contains(document.activeElement),
  )

  // A removed origin falls back to its nearest connected focusable ancestor.
  await page.evaluate(() => {
    const parent = document.createElement('div')
    parent.tabIndex = -1
    parent.id = 'focus-origin-parent'
    parent.append(document.createElement('button'))
    document.body.append(parent)
    parent.querySelector('button').focus()
  })
  await notify()
  await toast.waitFor()
  await pressShortcut(app, focus)
  await page.waitForFunction(() =>
    document.activeElement?.classList.contains('toast-action'),
  )
  await page.evaluate(() =>
    document.querySelector('#focus-origin-parent button').remove(),
  )
  await page.keyboard.press('Escape')
  await toast.waitFor({ state: 'detached' })
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    'focus-origin-parent',
  )
  await page.evaluate(() =>
    document.querySelector('#focus-origin-parent').remove(),
  )

  if (shots) {
    await mkdir(shots, { recursive: true })
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
      await notify()
      await toast.waitFor()
      await toast.hover()
      await toast.screenshot({ path: join(shots, `toast-hover-${scheme}.png`) })
      await page.mouse.move(4, 4)
      await pressShortcut(app, focus)
      await page.waitForFunction(() =>
        document.activeElement?.classList.contains('toast-action'),
      )
      await toast.screenshot({ path: join(shots, `toast-focus-${scheme}.png`) })
      await page.keyboard.press('Escape')
      await toast.waitFor({ state: 'detached' })
    }
  }
  assert.deepEqual(errors, [])
})
