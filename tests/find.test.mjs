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

  const filler = Array.from({ length: 120 }, (_, index) => `line ${index}`)
  await replaceSource(
    [...filler, 'needle top', ...filler, 'needle bottom'].join('\n\n'),
  )
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await rich.waitFor()
  await rich.focus()
  await pressShortcut(app, shortcut)
  // Focus stays in the find bar, so the rich pane must scroll to each match.
  const waitForVisibleMatch = (block) =>
    page.waitForFunction((text) => {
      const match = document.querySelector(
        '.rich-pane .ProseMirror-active-search-match',
      )
      if (match?.closest('p, pre')?.textContent !== text) return false
      const bounds = match.getBoundingClientRect()
      // Nested scroll containers such as code blocks must show the match too.
      return [match.closest('pre'), match.closest('.rich-pane')].every(
        (container) => {
          if (!container) return true
          const box = container.getBoundingClientRect()
          return (
            bounds.top >= box.top &&
            bounds.bottom <= box.bottom &&
            bounds.left >= box.left &&
            bounds.right <= box.right
          )
        },
      )
    }, block)
  await input.fill('needle')
  await waitForCount('1/2')
  await waitForVisibleMatch('needle top')
  await input.press('Enter')
  await waitForCount('2/2')
  await waitForVisibleMatch('needle bottom')
  await input.press('Enter')
  await waitForCount('1/2')
  await waitForVisibleMatch('needle top')
  await input.press('Shift+Enter')
  await waitForCount('2/2')
  await waitForVisibleMatch('needle bottom')
  await input.press('Escape')
  await bar.waitFor({ state: 'hidden' })

  const longLine = `${'code '.repeat(60)}needle`
  await page
    .getByRole('button', { name: /^source view$/i, exact: true })
    .click()
  await replaceSource([...filler, `\`\`\`\n${longLine}\n\`\`\``].join('\n\n'))
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await rich.waitFor()
  await rich.focus()
  await pressShortcut(app, shortcut)
  await input.fill('needle')
  await waitForCount('1/1')
  await waitForVisibleMatch(longLine)
  await input.press('Escape')
  await bar.waitFor({ state: 'hidden' })

  // A long match wraps in a narrow pane and must be revealed to its end.
  const wrapped = `wrapped needle ${'word '.repeat(24)}end`
  await page.setViewportSize({ width: 480, height: 720 })
  await page.waitForFunction(() => innerWidth === 480)
  await page
    .getByRole('button', { name: /^source view$/i, exact: true })
    .click()
  await replaceSource([...filler, wrapped, ...filler].join('\n\n'))
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await rich.waitFor()
  // Start above the match so the reveal scrolls down to it.
  await rich.evaluate((element) => {
    element.closest('.rich-pane').scrollTop = 0
  })
  await rich.focus()
  await pressShortcut(app, shortcut)
  await input.fill(wrapped)
  await waitForCount('1/1')
  await waitForVisibleMatch(wrapped)
  await input.press('Escape')
  await bar.waitFor({ state: 'hidden' })

  // A match wider than its code block but narrower than the pane keeps its start visible.
  const codeSource = (match) =>
    [...filler, `\`\`\`\n${'code '.repeat(60)}${match}\n\`\`\``].join('\n\n')
  await page
    .getByRole('button', { name: /^source view$/i, exact: true })
    .click()
  await replaceSource(codeSource('x'))
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await rich.waitFor()
  const length = await page.locator('.rich-pane pre').evaluate((pre) => {
    const range = document.createRange()
    range.selectNodeContents(pre)
    const glyph = range.getBoundingClientRect().width / pre.textContent.length
    const pane = pre.closest('.rich-pane').getBoundingClientRect().width
    const code = pre.getBoundingClientRect().width
    return Math.floor((code + Math.min(pane, code + 80) - 96) / 2 / glyph)
  })
  const wide = `needle${'x'.repeat(length - 6)}`
  await page
    .getByRole('button', { name: /^source view$/i, exact: true })
    .click()
  await replaceSource(codeSource(wide))
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await rich.waitFor()
  await rich.focus()
  await pressShortcut(app, shortcut)
  await input.fill(wide)
  await waitForCount('1/1')
  await page.waitForFunction(() => {
    const match = document.querySelector(
      '.rich-pane .ProseMirror-active-search-match',
    )
    const pre = match?.closest('pre')
    if (!pre || pre.scrollLeft === 0) return false
    const start = match.getBoundingClientRect().left
    const box = pre.getBoundingClientRect()
    return start >= box.left && start < box.right
  })
  await input.press('Escape')
  await bar.waitFor({ state: 'hidden' })
})
