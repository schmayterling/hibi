import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const customCSS = `:root { --ui-preview-test-probe: applied; }
.titlebar { background-color: rgb(12, 34, 56) !important; }`
const customTitlebarColor = 'rgb(12, 34, 56)'

async function openPreview(app, page) {
  await clickMenu(app, 'Command palette')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette
    .getByRole('combobox', { name: /search commands/i })
    .fill('Open UI preview')
  await palette.getByRole('option', { name: /Open UI preview/i }).click()
  const tab = page.getByRole('tab', { name: 'UI preview' })
  const panel = page.getByRole('tabpanel', { name: 'UI preview' })
  await tab.waitFor()
  await panel.locator('.ui-preview').waitFor()
  return panel
}

async function titlebarStyle(page) {
  return page.locator('.titlebar').evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      backgroundColor: style.backgroundColor,
      probe: style.getPropertyValue('--ui-preview-test-probe').trim(),
      outline: style.outline,
    }
  })
}

async function pauseCssWrite(app, enabled) {
  await app.evaluate(({ ipcMain }, enabled) => {
    const channel = 'addon-storage:write'
    const write = ipcMain._invokeHandlers.get(channel)
    if (!write) throw new Error('Addon storage write handler is unavailable')
    globalThis.cssWriteEntered = false
    globalThis.cssWriteFinished = false
    globalThis.releaseCssWrite = undefined
    globalThis.restoreCssWrite = () => {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, write)
    }
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, request) => {
      if (
        request?.owner !== 'ui-preview' ||
        request?.key !== 'custom-css' ||
        request?.value?.enabled !== enabled
      )
        return write(event, request)
      globalThis.cssWriteEntered = true
      await new Promise((resolve) => {
        globalThis.releaseCssWrite = resolve
      })
      const result = await write(event, request)
      globalThis.cssWriteFinished = true
      return result
    })
  }, enabled)
}

async function releaseCssWrite(app) {
  await app.evaluate(() => globalThis.releaseCssWrite())
  await waitForAsync(app, () => globalThis.cssWriteFinished === true)
  await app.evaluate(() => globalThis.restoreCssWrite())
}

test('ui preview can be enabled in release, edits samples, and owns persistent global css', {
  timeout: 90000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-ui-preview-'))
  const env = { ...process.env }
  delete env.ELECTRON_RENDERER_URL
  delete env.HIBI_TEST_SHOW_WINDOWS
  let app
  t.after(async () => {
    if (app) {
      await app.evaluate(() => globalThis.releaseCssWrite?.()).catch(() => {})
      await app.close()
    }
    await rm(profile, { recursive: true, force: true })
  })
  const launch = async () => {
    app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${profile}`],
      env,
    })
    const page = await app.firstWindow()
    page.setDefaultTimeout(8000)
    await page.getByRole('textbox', { name: /document editor/i }).waitFor()
    return page
  }

  let page = await launch()
  const original = await titlebarStyle(page)
  assert.notEqual(original.backgroundColor, customTitlebarColor)
  assert.equal(original.probe, '')
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager' }).click()
  const enabled = page.locator('#addon-ui-preview')
  await enabled.waitFor()
  assert.equal(await enabled.isChecked(), false)
  await enabled.click()
  await page.waitForFunction(
    () => document.querySelector('#addon-ui-preview')?.checked === true,
  )
  await page.getByRole('button', { name: 'Back to app' }).click()
  let panel = await openPreview(app, page)
  const sampleTitle = panel.getByRole('textbox', { name: 'Sample title' })
  const sampleBody = panel.getByRole('textbox', { name: 'Sample body' })
  await sampleTitle.fill('Preview heading')
  await sampleBody.fill('Preview body text')
  assert.equal(await sampleTitle.inputValue(), 'Preview heading')
  assert.equal(await sampleBody.inputValue(), 'Preview body text')
  if (process.env.HIBI_UI_PREVIEW_SCREENSHOT === '1') {
    await mkdir(resolve('test-results'), { recursive: true })
    await page.screenshot({ path: resolve('test-results/ui-preview.png') })
  }
  const outlines = panel.getByRole('checkbox', { name: 'Show red outlines' })
  await outlines.check()
  const stage = panel.locator('.ui-preview-stage')
  await page.waitForFunction(
    () =>
      document.querySelector('.ui-preview-stage')?.dataset.outlines === 'true',
  )
  assert.equal(
    await stage.evaluate((element) => getComputedStyle(element).outlineStyle),
    'solid',
  )
  assert.equal((await titlebarStyle(page)).outline, original.outline)
  await outlines.uncheck()
  assert.notEqual(await stage.getAttribute('data-outlines'), 'true')
  assert.equal(
    await stage.evaluate((element) => getComputedStyle(element).outlineStyle),
    'none',
  )

  const cssInput = panel.getByRole('textbox', { name: 'Custom CSS' })
  const cssEnabled = panel.getByRole('checkbox', { name: 'Enable custom CSS' })
  await cssInput.fill(customCSS)
  assert.equal(
    (await titlebarStyle(page)).backgroundColor,
    original.backgroundColor,
  )
  await cssEnabled.check()
  await page.waitForFunction(
    (color) =>
      getComputedStyle(document.querySelector('.titlebar')).backgroundColor ===
      color,
    customTitlebarColor,
  )
  await panel.getByRole('button', { name: 'Revert' }).click()
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('.titlebar'))
        .getPropertyValue('--ui-preview-test-probe')
        .trim() === '',
  )
  assert.equal(await cssInput.inputValue(), '')
  assert.equal(await cssEnabled.isChecked(), false)

  await cssInput.fill(customCSS)
  await cssEnabled.check()
  await pauseCssWrite(app, true)
  await panel.getByRole('button', { name: 'Save CSS' }).click()
  await waitForAsync(app, () => globalThis.cssWriteEntered === true)
  await clickMenu(app, 'Close tab')
  await page
    .getByRole('tab', { name: 'UI preview' })
    .waitFor({ state: 'detached' })
  panel = await openPreview(app, page)
  assert.equal(await app.evaluate(() => globalThis.cssWriteFinished), false)
  await releaseCssWrite(app)
  await panel.getByText('Custom CSS saved.', { exact: true }).waitFor()
  assert.equal((await titlebarStyle(page)).probe, 'applied')
  assert.equal(
    await panel.getByRole('textbox', { name: 'Custom CSS' }).inputValue(),
    customCSS,
  )
  assert.equal(
    await panel
      .getByRole('checkbox', { name: 'Enable custom CSS' })
      .isChecked(),
    true,
  )

  await app.close()
  app = undefined
  page = await launch()
  await page.waitForFunction(
    (color) =>
      getComputedStyle(document.querySelector('.titlebar')).backgroundColor ===
      color,
    customTitlebarColor,
  )
  assert.equal((await titlebarStyle(page)).probe, 'applied')
  panel = await openPreview(app, page)
  assert.equal(
    await panel.getByRole('textbox', { name: 'Custom CSS' }).inputValue(),
    customCSS,
  )
  await pauseCssWrite(app, false)
  await clickMenu(app, 'Disable custom CSS')
  await waitForAsync(app, () => globalThis.cssWriteEntered === true)
  await clickMenu(app, 'Close tab')
  await page
    .getByRole('tab', { name: 'UI preview' })
    .waitFor({ state: 'detached' })
  assert.equal(
    (await titlebarStyle(page)).backgroundColor,
    original.backgroundColor,
  )
  assert.equal((await titlebarStyle(page)).probe, '')
  await releaseCssWrite(app)
  assert.equal((await titlebarStyle(page)).probe, '')
  panel = await openPreview(app, page)
  await panel.getByText('Custom CSS disabled.', { exact: true }).waitFor()
  assert.equal(
    await panel.getByRole('textbox', { name: 'Custom CSS' }).inputValue(),
    customCSS,
  )
  assert.equal(
    await panel
      .getByRole('checkbox', { name: 'Enable custom CSS' })
      .isChecked(),
    false,
  )

  await app.close()
  app = undefined
  page = await launch()
  assert.equal((await titlebarStyle(page)).probe, '')
  panel = await openPreview(app, page)

  await panel.getByRole('checkbox', { name: 'Enable custom CSS' }).check()
  await panel.getByRole('button', { name: 'Save CSS' }).click()
  await panel.getByText('Custom CSS saved.', { exact: true }).waitFor()
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('.titlebar'))
        .getPropertyValue('--ui-preview-test-probe')
        .trim() === 'applied',
  )
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager' }).click()
  await page.locator('#addon-ui-preview').click()
  await page.waitForFunction(
    () => document.querySelector('#addon-ui-preview')?.checked === false,
  )
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('.titlebar'))
        .getPropertyValue('--ui-preview-test-probe')
        .trim() === '',
  )
  await page.getByRole('button', { name: 'Back to app' }).click()
  await page
    .getByRole('tab', { name: 'UI preview' })
    .waitFor({ state: 'detached' })
})
