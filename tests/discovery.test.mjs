import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('palette discovers settings, addon controls, themes, and formatting without visiting their pages', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-discovery-'))
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
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await waitForDocumentEditor(app, page)
  const choose = async (query) => {
    await pressShortcut(app, `${mod}+k`)
    await page.getByRole('combobox', { name: /search commands/i }).fill(query)
    await page.getByRole('option').first().waitFor()
    await page
      .getByRole('combobox', { name: /search commands/i })
      .press('Enter')
    await page
      .getByRole('dialog', { name: /command palette/i })
      .waitFor({ state: 'hidden' })
  }
  await choose('cursor blink')
  await page.waitForFunction(
    () => document.activeElement?.id === 'cursor-speed',
  )
  await choose('content padding')
  await page.waitForFunction(
    () => document.activeElement?.id === 'editor-padding',
  )
  const slider = page.getByLabel(/^content padding$/i, { exact: true })
  assert.equal(await slider.getAttribute('class'), 'ui-slider ')
  await slider.press('ArrowRight')
  assert.equal(await slider.inputValue(), '52')
  assert.ok((await slider.getAttribute('style')).includes('54.166'))
  const toggle = page.getByLabel(/^show line numbers$/i, { exact: true })
  assert.equal(
    await toggle.evaluate((el) => getComputedStyle(el).borderRadius),
    '999px',
  )
  await choose('enable vim')
  await choose('start in insert mode')
  await page.waitForFunction(() => document.activeElement?.id === 'vim-insert')
  await choose('disable vim')
  await waitForAsync(
    page,
    async () =>
      !(await window.hibi.getAddonStates()).some(
        ({ id, enabled }) => id === 'vim' && enabled,
      ),
  )
  await pressShortcut(app, `${mod}+k`)
  await page
    .getByRole('combobox', { name: /search commands/i })
    .fill('start in insert mode')
  await page
    .getByRole('dialog', { name: /command palette/i })
    .getByText('No commands found.', { exact: true })
    .waitFor()
  assert.equal(await page.getByRole('option').count(), 0)
  await page.keyboard.press('Escape')
  await page
    .getByRole('dialog', { name: /command palette/i })
    .waitFor({ state: 'hidden' })
  await choose('themes catppuccin mocha')
  await page.waitForFunction(
    () => document.documentElement.dataset.colorscheme === 'catppuccin-mocha',
  )
  await page.getByRole('button', { name: /^back to app$/i }).click()
  const rich = page.getByRole('textbox', { name: /document editor/i })
  await rich.fill('format from palette')
  await rich.press(`${mod}+a`)
  await choose('format bold')
  await waitForAsync(
    page,
    async () =>
      (await window.hibi.getDocument()).markdown === '**format from palette**',
  )
})
