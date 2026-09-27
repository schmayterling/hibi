import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

test('closing settings never overrides a newer editor focus', {
  timeout: 15000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-focus-'))
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
  page.setDefaultTimeout(5000)
  await page
    .getByRole('textbox', { name: /document editor/i })
    .fill('initial text')
  await page
    .getByRole('button', { name: /^side-by-side$/i, exact: true })
    .click()
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  await source.waitFor()
  await clickMenu(app, 'Settings')
  await page.evaluate(() => {
    document.activeElement.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
  })
  await page
    .getByRole('main', { name: /^settings$/i })
    .waitFor({ state: 'hidden' })
  await page.locator('.editor-surface:not([inert])').waitFor()
  await source.focus()
  await page.evaluate(() => new Promise(requestAnimationFrame))
  assert.equal(
    await source.evaluate((element) => element === document.activeElement),
    true,
  )
  await source.fill('# source text')
  await page
    .getByRole('heading', { name: /^source text$/i, exact: true })
    .waitFor()
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    '# source text',
  )
})
