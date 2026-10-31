import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForFormattedEditor } from './electron.mjs'
import { replaceRichText } from './keyboard.mjs'

test('split view mirrors the caret without moving focus or selecting the other pane', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-mirror-'))
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
  page.setDefaultTimeout(6000)
  const rich = page.getByRole('textbox', { name: /document editor/i })
  await waitForFormattedEditor(app, page)
  await replaceRichText(page, rich, 'mirror this text')
  await page
    .getByRole('button', { name: /^side-by-side$/i, exact: true })
    .click()
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  await source.waitFor()
  await page.evaluate(() => {
    document.hasFocus = () => true
  })
  await rich.focus()
  await rich.press('ArrowLeft')
  await page.locator('.source-pane .mirror-cursor').waitFor()
  assert.equal(
    await rich.evaluate((element) => element === document.activeElement),
    true,
  )
  await source.focus()
  await source.press('ArrowRight')
  await source.pressSequentially('!')
  await page.locator('.rich-pane .mirror-cursor').waitFor()
  assert.equal(
    await source.evaluate((element) => element === document.activeElement),
    true,
  )
  await source.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
  await page.locator('.mirror-cursor').waitFor({ state: 'hidden' })
  await source.press('ArrowRight')
  await page.locator('.mirror-cursor').waitFor()
  await page
    .getByRole('button', { name: /^source view$/i, exact: true })
    .click()
  await page.locator('.mirror-cursor').waitFor({ state: 'hidden' })
})
