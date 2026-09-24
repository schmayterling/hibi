import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'
import { uiName } from './ui.mjs'

test('extension and core fields share themes, focus states, and narrow layouts', {
  timeout: 45000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-controls-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(6500)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  const choose = async (name) => {
    await pressShortcut(app, `${mod}+k`)
    await page.getByRole('combobox', { name: /search commands/i }).fill(name)
    await page
      .getByRole('option')
      .filter({ has: page.getByText(uiName(name, true), { exact: true }) })
      .first()
      .click()
    await page.locator('.command-palette').waitFor({ state: 'hidden' })
  }
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await choose('enable graph')
  const fieldStyle = (field) =>
    field.evaluate((element) => {
      const style = getComputedStyle(element)
      return Object.fromEntries(
        [
          'fontFamily',
          'fontSize',
          'lineHeight',
          'borderRadius',
          'borderTopWidth',
          'paddingTop',
          'paddingLeft',
          'backgroundColor',
          'color',
        ].map((key) => [key, style[key]]),
      )
    })
  let previous
  for (const [mode, command, title, label] of [
    ['light', 'open workspace graph', 'workspace graph', 'filter graph notes'],
    ['dark', 'browse tags', 'tags', 'filter tags'],
  ]) {
    await page.evaluate(
      (mode) =>
        localStorage.setItem(
          'hibi-colorscheme',
          JSON.stringify({
            mode,
            light: 'catppuccin-latte',
            dark: 'catppuccin-mocha',
          }),
        ),
      mode,
    )
    await page.reload()
    await page.getByRole('textbox', { name: /document editor/i }).waitFor()
    await choose('open syntax settings')
    const core = await fieldStyle(page.locator('#markdown-syntax-filter'))
    if (previous)
      assert.notEqual(core.backgroundColor, previous.backgroundColor)
    previous = core
    await page.getByRole('button', { name: /^back to app$/i }).click()
    await choose(command)
    const dialog = page.getByRole('complementary', {
      name: uiName(title, true),
      exact: true,
    })
    const field = dialog.getByRole('searchbox', { name: uiName(label) })
    await field.waitFor()
    assert.deepEqual(await fieldStyle(field), core)
    await field.fill('filter')
    await field.focus()
    assert.equal(
      await field.evaluate((el) => getComputedStyle(el).outlineWidth),
      '2px',
    )
    assert.equal(
      await field.evaluate((el) => getComputedStyle(el).outlineOffset),
      '-2px',
    )
    // Installed extensions using plain native markup receive the same defaults.
    await dialog.locator('.sidebar-content').evaluate((container) => {
      const field = document.createElement('input')
      field.id = 'native-extension-input'
      field.setAttribute('aria-label', 'native extension field')
      container.append(field)
    })
    const native = page.locator('#native-extension-input')
    assert.deepEqual(await fieldStyle(native), core)
    await native.evaluate((el) => el.setAttribute('aria-invalid', 'true'))
    await native.focus()
    await page.waitForFunction(() => {
      const style = getComputedStyle(
        document.querySelector('#native-extension-input'),
      )
      return style.borderTopColor === style.outlineColor
    })
    await native.evaluate((el) => {
      el.disabled = true
    })
    assert.equal(
      await native.evaluate((el) => getComputedStyle(el).opacity),
      '0.5',
    )
    await native.evaluate((el) => el.remove())
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setMinimumSize(360, 500)
      window.setSize(360, 640)
    })
    await page.waitForFunction(() => innerWidth === 360)
    await page
      .getByRole('button', { name: /toggle workspace sidebar/i })
      .click()
    await dialog.waitFor()
    await page.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((animation) =>
            Number.isFinite(animation.effect?.getComputedTiming().iterations),
          )
          .map((animation) => animation.finished.catch(() => {})),
      ),
    )
    assert.equal(
      await dialog.evaluate((el) => {
        const box = el.getBoundingClientRect()
        const controls = el.querySelector('.ui-control-row')
        const row = controls.getBoundingClientRect()
        return (
          box.right <= innerWidth &&
          box.left >= 0 &&
          [...controls.children].every((child) => {
            const rect = child.getBoundingClientRect()
            return rect.left >= row.left - 1 && rect.right <= row.right + 1
          })
        )
      }),
      true,
    )
    await page
      .getByRole('button', { name: /toggle workspace sidebar/i })
      .click()
    await dialog.waitFor({ state: 'hidden' })
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1000, 720),
    )
  }
})
