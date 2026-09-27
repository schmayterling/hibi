import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'
import { uiName } from './ui.mjs'

test('titlebar keeps actions minimal, blocks scrolled content, and persists toast settings', async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-titlebar-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1000, height: 600 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const titlebar = page.locator('.titlebar')
  await titlebar.waitFor()
  for (const name of [
    'new',
    'open',
    'save',
    'editor settings',
    'command palette',
    'back to editor',
  ])
    assert.equal(
      await titlebar
        .getByRole('button', { name: new RegExp(`^${name}$`, 'i') })
        .count(),
      0,
    )
  assert.equal(
    await titlebar
      .getByRole('navigation', { name: /editor view/i })
      .getByRole('button')
      .count(),
    3,
  )
  await titlebar.getByRole('button', { name: /^settings$/i }).click()
  await page.getByRole('main', { name: /^settings$/i, exact: true }).waitFor()
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await clickMenu(app, 'Settings')
  for (const category of ['about', 'appearance']) {
    await page
      .getByRole('tab', { name: uiName(category, true), exact: true })
      .click()
    const content = page.locator('.settings-content')
    await content.evaluate((el) => {
      el.scrollTo(0, 0)
      const strip = document.createElement('div')
      strip.dataset.titlebarOpacityProbe = 'true'
      strip.style.cssText = 'height: 36px; background: #f0f'
      el.prepend(strip)
    })
    await page.evaluate(() => document.fonts.ready)
    const clip = { x: 500, y: 16, width: 64, height: 12 }
    const before = await page.screenshot({ clip, animations: 'disabled' })
    await content.evaluate((el) => el.scrollTo(0, 60))
    await page.waitForFunction(
      () => document.querySelector('.settings-content').scrollTop === 60,
    )
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    )
    const strip = await content
      .locator('[data-titlebar-opacity-probe]')
      .evaluate((el) => {
        const { left, right, top, bottom } = el.getBoundingClientRect()
        return { left, right, top, bottom }
      })
    const after = await page.screenshot({ clip, animations: 'disabled' })
    const covered =
      strip.left <= clip.x &&
      strip.right >= clip.x + clip.width &&
      strip.top <= clip.y &&
      strip.bottom >= clip.y + clip.height
    if (!covered || !before.equals(after)) {
      await mkdir('test-results', { recursive: true })
      await writeFile(`test-results/titlebar-${category}-before.png`, before)
      await writeFile(`test-results/titlebar-${category}-after.png`, after)
    }
    assert.ok(
      covered,
      `${category}: opacity probe must move behind the titlebar`,
    )
    assert.ok(
      before.equals(after),
      `${category}: scrolled content must not show through the titlebar`,
    )
    await content
      .locator('[data-titlebar-opacity-probe]')
      .evaluate((el) => el.remove())
  }
  await page
    .getByLabel(/^position$/i, { exact: true })
    .selectOption('top-center')
  await page
    .getByLabel(/^dismiss after$/i, { exact: true })
    .selectOption('3000')
  await page
    .getByRole('button', { name: /^show preview$/i, exact: true })
    .click()
  await page.locator('.sonner[data-position="top-center"]').waitFor()
  assert.deepEqual(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem('toast-preferences')),
    ),
    { position: 'top-center', duration: 3000 },
  )
  await page
    .getByRole('button', { name: /^dismiss notice$/i, exact: true })
    .click()
  await page.getByRole('button', { name: /^back to app$/i }).click()
  for (const open of [true, false]) {
    await page
      .getByRole('button', { name: /toggle workspace sidebar/i })
      .click()
    const surface = await page.locator('.editor-surface').evaluate((el) => {
      const styles = getComputedStyle(el, '::before')
      return {
        left: el.getBoundingClientRect().left + Number.parseFloat(styles.left),
        top: el.getBoundingClientRect().top + Number.parseFloat(styles.top),
        background: styles.backgroundColor,
        page: getComputedStyle(document.body).backgroundColor,
      }
    })
    assert.equal(surface.left, open ? 256 : 0)
    assert.equal(surface.top, 0)
    assert.equal(surface.background, surface.page)
  }
})
