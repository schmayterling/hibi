import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('find in document searches rich text and offscreen markdown without editing it', {
  timeout: 45000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-find-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
    colorScheme: null,
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      })
    })
    const slowClose = setTimeout(() => {
      void Promise.race([
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().map((window) => ({
            destroyed: window.isDestroyed(),
            loading: window.webContents.isLoading(),
            url: window.webContents.getURL(),
          })),
        ),
        new Promise((resolve) =>
          setTimeout(() => resolve('main did not reply'), 1000),
        ),
      ]).then(
        (windows) =>
          t.diagnostic(`slow Electron close: ${JSON.stringify(windows)}`),
        (error) => t.diagnostic(`slow Electron close: ${String(error)}`),
      )
    }, 10000)
    try {
      await app.close()
    } finally {
      clearTimeout(slowClose)
    }
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  const rich = page.getByRole('textbox', { name: /document editor/i })
  await rich.waitFor()
  await page
    .getByRole('button', { name: /^source view$/i, exact: true })
    .click()
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  await source.waitFor()
  const replaceSource = async (text) => {
    await page
      .locator(
        '.editor-panes[data-source-ready="true"] .source-pane:not([inert]) [contenteditable="true"]',
      )
      .waitFor()
    // Select the full editor document, including offscreen text, before input.
    await source.focus()
    await source.press('ControlOrMeta+a')
    await page.keyboard.insertText(text)
    await waitForAsync(
      page,
      async (expected) =>
        (await window.hibi.getDocument()).markdown === expected,
      text,
    )
  }
  const markdown = '# title\n\nhello **world** and hello world.\n\nHELLO world.'
  await replaceSource(markdown)
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await rich.waitFor()
  const shortcut = process.platform === 'darwin' ? 'Meta+f' : 'Control+f'
  await pressShortcut(app, shortcut)
  const input = page.getByRole('textbox', {
    name: /^find in document$/i,
    exact: true,
  })
  const bar = page.getByRole('search', { name: /find in document/i })
  const waitForCount = (expected) =>
    page.waitForFunction(
      (count) =>
        document.querySelector('.find-bar output')?.textContent === count,
      expected,
    )
  await input.fill('hello world')
  await page.waitForFunction(
    () => document.querySelector('.find-bar output')?.textContent === '1/3',
  )
  assert.equal(
    await input.evaluate((element) => element === document.activeElement),
    true,
  )
  await input.press('Enter')
  await waitForCount('2/3')
  await input.press('Shift+Enter')
  await waitForCount('1/3')
  await input.press('Shift+Enter')
  await waitForCount('3/3')
  await page.getByRole('button', { name: /^next match$/i, exact: true }).click()
  await waitForCount('1/3')
  await rich.click()
  await pressShortcut(app, shortcut)
  assert.equal(
    await input.evaluate((element) => element === document.activeElement),
    true,
  )
  await input.press('Enter')
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    markdown,
  )
  await input.press('Escape')
  await bar.waitFor({ state: 'hidden' })
  assert.equal(
    await rich.evaluate((element) => element === document.activeElement),
    true,
  )

  await page
    .getByRole('button', { name: /^source view$/i, exact: true })
    .click()
  await source.waitFor()
  await pressShortcut(app, shortcut)
  await page.waitForFunction(
    () => document.querySelector('.find-bar output')?.textContent === '1/2',
  )
  await input.press('Enter')
  await waitForCount('2/2')
  assert.equal(
    await input.evaluate((element) => element === document.activeElement),
    true,
  )
  await input.fill('settings')
  await page.waitForFunction(
    () =>
      document.querySelector('.find-bar output')?.textContent === 'No results',
  )
  assert.equal(
    await page
      .getByRole('button', { name: /^next match$/i, exact: true })
      .isDisabled(),
    true,
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    markdown,
  )

  await replaceSource(
    `${Array.from({ length: 150 }, (_, index) => `line ${index}`).join('\n')}\nlast needle`,
  )
  await input.fill('last needle')
  await page.waitForFunction(
    () => document.querySelector('.find-bar output')?.textContent === '1/1',
  )
  await source
    .locator('.cm-searchMatch')
    .filter({ hasText: /last needle/i })
    .waitFor()
  await replaceSource(
    Array.from({ length: 200 }, (_, index) => `${index} café`).join('\n'),
  )
  await input.fill('CAFE')
  await waitForCount('1/200')
  await input.press('Shift+Enter')
  await waitForCount('200/200')
  await input.press('Enter')
  await waitForCount('1/200')
  await replaceSource('last needle')
  await waitForCount('No results')
  assert.equal(
    await source.evaluate((element) => element === document.activeElement),
    true,
  )
  await input.fill('last needle')
  await waitForCount('1/1')
  await page.getByRole('button', { name: /^close find$/i, exact: true }).click()
  await bar.waitFor({ state: 'hidden' })
  assert.equal(
    await source.evaluate((element) => element === document.activeElement),
    true,
  )

  await page
    .getByRole('button', { name: /^side-by-side$/i, exact: true })
    .click()
  await source.waitFor()
  await source.focus()
  await pressShortcut(app, shortcut)
  await waitForCount('1/1')
  await source.locator('.cm-searchMatch-selected').waitFor()
  assert.equal(await source.locator('.cm-searchMatch-selected').count(), 1)
  await rich.focus()
  await pressShortcut(app, shortcut)
  await waitForCount('1/1')
  await rich.locator('.ProseMirror-active-search-match').waitFor()
  assert.equal(
    await rich.locator('.ProseMirror-active-search-match').count(),
    1,
  )
  await input.press('Escape')
  await bar.waitFor({ state: 'hidden' })
})
