import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

test('spell checking toggles live, persists, and preserves text in both views', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-spellcheck-'))
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
  await waitForDocumentEditor(app, page)
  assert.equal(await rich.getAttribute('spellcheck'), 'true')
  await rich.fill('mispellled text')
  const change = async () => {
    await clickMenu(app, 'Settings')
    await page.getByRole('tab', { name: /^editor$/i, exact: true }).click()
    await page.locator('#spell-check').click()
    await page.keyboard.press('Escape')
    await rich.waitFor()
  }
  await change()
  assert.equal(await rich.getAttribute('spellcheck'), 'false')
  await rich.press('End')
  await rich.pressSequentially(' stays')
  assert.equal(await rich.getAttribute('spellcheck'), 'false')
  const text = (await page.evaluate(() => window.hibi.getDocument())).markdown
  await page.reload()
  await rich.waitFor()
  assert.equal(await rich.getAttribute('spellcheck'), 'false')
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    text,
  )
  await change()
  assert.equal(await rich.getAttribute('spellcheck'), 'true')
  await page
    .getByRole('button', { name: /^side-by-side$/i, exact: true })
    .click()
  await page.getByRole('textbox', { name: /markdown editor/i }).waitFor()
  assert.equal(await rich.getAttribute('spellcheck'), 'true')
  assert.equal(
    await page.locator('.cm-content').getAttribute('spellcheck'),
    'false',
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    text,
  )
})
