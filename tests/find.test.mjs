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

  // Characters that lengthen when lowercased must not shift highlights, and a
  // final sigma is still the same letter.
  await page
    .getByRole('button', { name: /^source view$/i, exact: true })
    .click()
  await replaceSource('İx needle word ΣΣ')
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await rich.waitFor()
  await rich.focus()
  await pressShortcut(app, shortcut)
  await input.fill('needle')
  await waitForCount('1/1')
  assert.equal(
    await rich.locator('.ProseMirror-active-search-match').textContent(),
    'needle',
  )
  await input.fill('Σ')
  await waitForCount('1/2')
  await input.press('Enter')
  await waitForCount('2/2')
  await input.press('Escape')
  await bar.waitFor({ state: 'hidden' })

  // A dense paragraph counts every match. Moving between matches restyles
  // two highlights without case-folding the paragraph again.
  const dense = 'needle word '.repeat(10000).trimEnd()
  await page
    .getByRole('button', { name: /^source view$/i, exact: true })
    .click()
  await replaceSource(dense)
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await rich.waitFor()
  await rich.focus()
  await pressShortcut(app, shortcut)
  await input.fill('NEEDLE')
  await waitForCount('1/10000')
  const folded = () =>
    page.evaluate(() => {
      const count = window.foldedText
      window.foldedText = 0
      return count
    })
  await page.evaluate(() => {
    const lower = String.prototype.toLowerCase
    window.foldedText = 0
    window.restoreFolding = () => {
      String.prototype.toLowerCase = lower
    }
    String.prototype.toLowerCase = function () {
      window.foldedText += this.length
      return lower.call(this)
    }
  })
  const selected = () =>
    rich.evaluate((element) => {
      const { from, to } = element.editor.state.selection
      return [from, to]
    })
  await input.press('Enter')
  await waitForCount('2/10000')
  assert.deepEqual(await selected(), [13, 19])
  await input.press('Shift+Enter')
  await waitForCount('1/10000')
  await input.press('Shift+Enter')
  await waitForCount('10000/10000')
  assert.deepEqual(await selected(), [dense.length - 10, dense.length - 4])
  await page.getByRole('button', { name: /^next match$/i, exact: true }).click()
  await waitForCount('1/10000')
  assert.deepEqual(await selected(), [1, 7])
  assert.ok(
    (await folded()) < dense.length,
    'selection-only find steps must not rescan the paragraph',
  )
  assert.equal(
    await rich.locator('.ProseMirror-active-search-match').count(),
    1,
  )
  // Only matches near the viewport are highlighted, one frame after a change.
  const highlighted = async () => {
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    )
    return rich
      .locator('.ProseMirror-search-match, .ProseMirror-active-search-match')
      .count()
  }
  const nearby = await highlighted()
  assert.ok(nearby > 1 && nearby < 1000, `${nearby} highlights`)
  // A move only swaps the classes of two highlights; rewriting text in the
  // paragraph would make the browser lay it out again.
  await page.evaluate(() => {
    const paragraph = document.querySelector('.rich-pane .tiptap > p')
    window.findRecords = []
    window.findMutations = new MutationObserver((records) => {
      window.findRecords.push(...records)
    })
    window.findMutations.observe(paragraph, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    })
  })
  await input.press('Enter')
  await waitForCount('2/10000')
  assert.deepEqual(
    await page.evaluate(() => {
      const records = [
        ...window.findRecords,
        ...window.findMutations.takeRecords(),
      ]
      window.findMutations.disconnect()
      return records.map((record) => [
        record.type,
        record.attributeName,
        record.target.className,
      ])
    }),
    [
      ['attributes', 'class', 'ProseMirror-search-match'],
      ['attributes', 'class', 'ProseMirror-search-match'],
      ['attributes', 'class', 'ProseMirror-active-search-match'],
      ['attributes', 'class', 'ProseMirror-active-search-match'],
    ],
  )
  await input.press('Shift+Enter')
  await waitForCount('1/10000')

  // Replacing the selected match rescans its paragraph once, and undo
  // restores the text and every match.
  await rich.evaluate((element) => element.editor.commands.insertContent('pin'))
  await waitForCount('0/9999')
  assert.ok(
    (await folded()) < 2 * dense.length,
    'an edit must rescan only its paragraph, once',
  )
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    `pin${dense.slice(6)}`,
  )
  await rich.evaluate((element) => element.editor.commands.undo())
  await waitForCount('0/10000')
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    dense,
  )
  // Moves continue from wherever the cursor is.
  await rich.evaluate((element) => element.editor.commands.setTextSelection(7))
  await input.press('Enter')
  await waitForCount('2/10000')
  assert.deepEqual(await selected(), [13, 19])
  await page.evaluate(() => window.restoreFolding())
  await page.getByRole('button', { name: /^close find$/i, exact: true }).click()
  await bar.waitFor({ state: 'hidden' })

  // Ten times as many matches leave the highlighted count unchanged.
  await page
    .getByRole('button', { name: /^source view$/i, exact: true })
    .click()
  await replaceSource('needle word '.repeat(100000).trimEnd())
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await rich.waitFor()
  await rich.focus()
  await pressShortcut(app, shortcut)
  await input.fill('needle')
  await waitForCount('1/100000')
  assert.equal(await highlighted(), nearby)
  await input.press('Escape')
  await bar.waitFor({ state: 'hidden' })

  // Enter while a long note is still being searched moves once it is counted,
  // without finishing the search at once.
  const lines = Array.from({ length: 500 }, (_, index) => `line ${index}`)
  await page
    .getByRole('button', { name: /^source view$/i, exact: true })
    .click()
  await replaceSource(
    [...lines, 'needle one', 'needle two', 'needle three'].join('\n\n'),
  )
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await rich.waitFor()
  await rich.focus()
  await pressShortcut(app, shortcut)
  await waitForCount('1/3')
  await input.fill('')
  await waitForCount('')
  // A fast clock ends the first search slice after one block, and the later
  // slices are held, so the search stays pending.
  await page.evaluate(() => {
    const schedule = window.setTimeout
    window.heldSlices = []
    window.releaseSlices = () => {
      window.setTimeout = schedule
      for (const run of window.heldSlices.splice(0)) run()
    }
    window.setTimeout = (run, delay, ...rest) =>
      delay ? schedule(run, delay, ...rest) : window.heldSlices.push(run)
    let ticks = 0
    performance.now = () =>
      Performance.prototype.now.call(performance) + 1000 * ++ticks
  })
  await input.fill('needle')
  await waitForCount('Searching…')
  await page.evaluate(() => {
    delete performance.now
  })
  const before = await selected()
  await page.evaluate(() => {
    const lower = String.prototype.toLowerCase
    window.foldedText = 0
    window.restoreFolding = () => {
      String.prototype.toLowerCase = lower
    }
    String.prototype.toLowerCase = function () {
      // Count source text; key routing also folds unrelated DOM tag names.
      if (this.includes('line ') || this.includes('needle '))
        window.foldedText += this.length
      return lower.call(this)
    }
  })
  await input.press('Enter')
  await input.press('Enter')
  assert.ok(
    (await folded()) < 1000,
    'a pending move must not search the rest of the note at once',
  )
  await page.evaluate(() => window.restoreFolding())
  assert.deepEqual(await selected(), before)
  assert.equal(await bar.locator('output').textContent(), 'Searching…')
  await page.evaluate(() => window.releaseSlices())
  await waitForCount('3/3')
  await input.press('Escape')
  await bar.waitFor({ state: 'hidden' })
})
