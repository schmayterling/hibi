import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { collectLicenses } from '../scripts/licenses.ts'
import { electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

test('license catalog retains dependency and palette notices, excluding build tools', async () => {
  const entries = await collectLicenses()
  assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length)
  assert.match(
    entries.find((entry) => entry.name === 'isarray').text,
    /Copyright.*Julian Gruber/,
  )
  for (const name of [
    'react',
    'react-dom',
    'electron',
    'geist',
    'dompurify',
    '@codemirror/view',
    '@tiptap/core',
    '@tiptap/extension-drag-handle',
    '@tiptap/extension-node-range',
    '@tiptap/extension-collaboration',
    '@tiptap/y-tiptap',
    'yjs',
    'y-protocols',
    'lib0',
    '@replit/codemirror-vim',
    'catppuccin colorscheme',
  ])
    assert.ok(entries.some((entry) => entry.name === name && entry.text.trim()))
  for (const name of [
    'typescript',
    'playwright',
    'electron-builder',
    '@electron/get',
    'next',
    '@next/env',
  ])
    assert.equal(
      entries.some((entry) => entry.name === name),
      false,
    )
  assert.ok(
    entries
      .find((entry) => entry.name === 'react')
      .text.includes(await readFile('node_modules/react/LICENSE', 'utf8')),
  )
  assert.ok(
    entries
      .find((entry) => entry.name === 'dompurify')
      .text.includes(
        await readFile('node_modules/dompurify/LICENSE-MPL', 'utf8'),
      ),
  )
})

test('hibi opens first, sponsor uses a fixed URL, and license dialogs stay readable', {
  timeout: 45000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-about-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await clickMenu(app, 'Settings')
  const sidebar = page.getByRole('tablist', { name: /settings categories/i })
  assert.equal(await sidebar.getByRole('tab').first().innerText(), 'Hibi')
  assert.equal(
    await page
      .getByRole('tab', { name: /^hibi$/i, exact: true })
      .getAttribute('aria-selected'),
    'true',
  )
  const panel = page.getByRole('tabpanel', { name: /^hibi$/i, exact: true })
  await panel.getByText(/^version 0\.1\.0$/i, { exact: true }).waitFor()
  const react = panel
    .getByRole('button')
    .filter({ has: page.locator('.license-name', { hasText: /^react19/ }) })
  await react.waitFor()
  await page.evaluate(() => document.fonts.ready)
  assert.deepEqual(
    await react.evaluate((element) => {
      const style = getComputedStyle(element)
      return [style.borderRadius, style.paddingLeft, style.paddingRight]
    }),
    ['0px', '16px', '16px'],
  )
  const catalog = await page.evaluate(() => window.hibi.getLicenses())
  const hoverBounds = await react.evaluate((element) => {
    const row = element.getBoundingClientRect(),
      card = element.parentElement.getBoundingClientRect()
    return [row.left - card.left, card.right - row.right]
  })
  assert.ok(
    hoverBounds.every((value) => Math.abs(value - 1) < 1),
    JSON.stringify(hoverBounds),
  )
  assert.equal(await panel.locator('.license-row').count(), catalog.length)
  assert.ok(catalog.every((entry) => !('text' in entry)))
  await assert.rejects(
    page.evaluate(() => window.hibi.getLicense('../package.json')),
    /This license is no longer available\./,
  )
  await assert.rejects(
    page.evaluate(() => window.hibi.getLicense(42)),
    /Choose a license to view\./,
  )
  await app.evaluate(({ shell }) => {
    shell.openExternal = async (url) => {
      globalThis.openedSponsor = url
    }
  })
  await panel.getByRole('button', { name: /sponsor on github/i }).press('Enter')
  assert.equal(
    await app.evaluate(() => globalThis.openedSponsor),
    'https://github.com/sponsors/schmayterling',
  )
  await page.waitForFunction(
    () => !document.querySelector('#sponsor-project').disabled,
  )
  await mkdir('test-results', { recursive: true })
  await page.screenshot({
    path: 'test-results/hibi-settings.png',
    animations: 'disabled',
  })
  await react.press('Enter')
  const dialog = page.getByRole('dialog', { name: /^react$/i, exact: true })
  await dialog.locator('.license-text').waitFor()
  assert.ok(
    (await dialog.locator('.license-text').innerText()).includes(
      await readFile('node_modules/react/LICENSE', 'utf8'),
    ),
  )
  await page.screenshot({
    path: 'test-results/license-dialog.png',
    animations: 'disabled',
  })
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  assert.equal(
    await react.evaluate((el) => el === document.activeElement),
    true,
  )
  for (const width of [480, 1000]) {
    await page.setViewportSize({ width, height: 720 })
    assert.equal(
      await panel.evaluate((el) => el.scrollWidth <= el.clientWidth),
      true,
    )
    await react.press('Enter')
    await dialog.locator('.license-text').waitFor()
    assert.equal(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
      true,
    )
    await page.mouse.click(3, 3)
    await dialog.waitFor({ state: 'hidden' })
  }
  assert.deepEqual(errors, [])
  await page.getByRole('tab', { name: /^appearance$/i, exact: true }).click()
  assert.equal(await page.locator('.colorscheme-license').count(), 0)
})
