import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { selectFormattedEngine } from './formatted-engine.mjs'
import { pressShortcut, replaceSourceText } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

async function denseHighlights(page, rich) {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  )
  return rich.evaluate((element) => {
    const ranges = element.cmTile.root.view.visibleRanges
    return {
      count: element.querySelectorAll('.cm-searchMatch').length,
      units: ranges.reduce((sum, range) => sum + range.to - range.from, 0),
      // each edge can show a partial match and the query's lookaround margin.
      bound: ranges.reduce(
        (sum, range) =>
          sum + Math.ceil((range.to - range.from) / 'needle word '.length) + 4,
        0,
      ),
    }
  })
}

async function openFind(t, markdown) {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-formatted-find-'))
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
  page.setDefaultTimeout(7000)
  const rich = await selectFormattedEngine(app, page, 'codemirror')
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  const source = page.getByRole('textbox', {
    name: 'Markdown editor',
    exact: true,
  })
  await replaceSourceText(page, source, markdown)
  await waitForAsync(
    page,
    async (markdown) => (await window.hibi.getDocument()).markdown === markdown,
    markdown,
  )
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await rich.waitFor()
  await rich.focus()
  await pressShortcut(app, `${mod}+f`)
  const input = page.getByRole('textbox', {
    name: 'Find in document',
    exact: true,
  })
  const bar = page.getByRole('search', { name: /find in document/i })
  const count = async (expected) => {
    try {
      await waitForAsync(
        page,
        (expected) =>
          document.querySelector('.find-bar output')?.textContent === expected,
        expected,
      )
    } catch (error) {
      t.diagnostic(
        JSON.stringify({
          expected,
          actual: await bar.locator('output').textContent(),
          query: await input.inputValue(),
        }),
      )
      throw error
    }
  }
  return { app, page, rich, source, input, bar, count }
}

test('formatted find matches rendered phrases across markdown marks and returns focus without editing', {
  timeout: 30000,
}, async (t) => {
  const markdown = '# title\n\nhello **world** and hello world.\n\nHELLO world.'
  const { page, rich, input, bar, count } = await openFind(t, markdown)
  await input.fill('hello world')
  await count('1/3')
  assert.equal(
    await input.evaluate((element) => element === document.activeElement),
    true,
  )
  await input.press('Enter')
  await count('2/3')
  await input.press('Shift+Enter')
  await count('1/3')
  await input.press('Shift+Enter')
  await count('3/3')
  await page.getByRole('button', { name: 'Next match', exact: true }).click()
  await count('1/3')
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
})

test('formatted find folds unicode without shifting selected text and keeps offscreen matches visible', {
  timeout: 45000,
}, async (t) => {
  const filler = Array.from({ length: 120 }, (_, i) => `line ${i}`).join('\n\n')
  const markdown = `😀İ é ß ΟΔΟΣ οδος οδοσ;ΑΣΑ ΣΣ.\n\n${filler}\n\nlast needle`
  const { page, rich, input, bar, count } = await openFind(t, markdown)
  for (const query of ['ΟΔΟΣ', 'οδος', 'οδοσ']) {
    await input.fill(query)
    await count('1/3')
    await input.press('Enter')
    await count('2/3')
    await rich.locator('.cm-searchMatch-selected').waitFor()
    assert.equal(
      await rich.locator('.cm-searchMatch-selected').textContent(),
      'οδος',
    )
  }
  await input.fill('Σ')
  await count('1/6')
  await input.press('Enter')
  await count('2/6')
  await input.fill('last needle')
  await count('1/1')
  await page.waitForFunction(() => {
    const match = document.querySelector('.rich-pane .cm-searchMatch-selected')
    if (match?.textContent !== 'last needle') return false
    const box = match.getBoundingClientRect()
    const pane = match.closest('.rich-pane').getBoundingClientRect()
    return box.top >= pane.top && box.bottom <= pane.bottom
  })
  assert.equal(
    await input.evaluate((element) => element === document.activeElement),
    true,
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    markdown,
  )
  await input.fill('missing')
  await count('No results')
  assert.equal(
    await page
      .getByRole('button', { name: 'Next match', exact: true })
      .isDisabled(),
    true,
  )
  await input.press('Escape')
  await bar.waitFor({ state: 'hidden' })
  assert.equal(
    await rich.evaluate((element) => element === document.activeElement),
    true,
  )
})

test('formatted dense find counts every match, bounds highlights, and preserves selection through edit and undo', {
  timeout: 60000,
}, async (t) => {
  const dense = 'needle word '.repeat(10000).trimEnd()
  const { app, page, rich, input, count } = await openFind(t, dense)
  await input.fill('NEEDLE')
  await count('1/10000')
  const nearby = await denseHighlights(page, rich)
  assert.ok(
    nearby.count > 1 && nearby.count <= nearby.bound,
    JSON.stringify(nearby),
  )
  assert.ok(
    nearby.units < dense.length / 2,
    'highlights cover only the rendered source window',
  )
  await input.press('Enter')
  await count('2/10000')
  assert.equal(
    await rich.locator('.cm-searchMatch-selected').textContent(),
    'needle',
  )
  await input.press('Shift+Enter')
  await count('1/10000')
  await input.press('Shift+Enter')
  await count('10000/10000')
  await input.press('Enter')
  await count('1/10000')
  await input.press('Escape')
  await page.keyboard.insertText('pin')
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    `pin${dense.slice(6)}`,
  )
  await pressShortcut(app, `${mod}+z`)
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    dense,
  )
  await pressShortcut(app, `${mod}+f`)
  // native undo restores the selected match, which remains the current result.
  await count('1/10000')
  assert.equal(
    await rich.locator('.cm-searchMatch-selected').textContent(),
    'needle',
  )
})

test('formatted find keeps highlights bounded when match count grows from ten thousand to one hundred thousand', {
  timeout: 60000,
}, async (t) => {
  const dense = 'needle word '.repeat(10000).trimEnd()
  const { app, page, rich, source, input, count } = await openFind(t, dense)
  await input.fill('needle')
  await count('1/10000')
  const nearby = await denseHighlights(page, rich)
  assert.ok(
    nearby.count > 1 && nearby.count <= nearby.bound,
    JSON.stringify(nearby),
  )
  assert.ok(
    nearby.units < dense.length / 2,
    'highlights cover only the rendered source window',
  )
  await input.press('Escape')
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  const larger = 'needle word '.repeat(100000).trimEnd()
  await replaceSourceText(page, source, larger)
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    larger,
  )
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await rich.waitFor()
  await rich.focus()
  await pressShortcut(app, `${mod}+f`)
  await input.fill('needle')
  await count('1/100000')
  const more = await denseHighlights(page, rich)
  assert.ok(more.count > 1 && more.count <= more.bound, JSON.stringify(more))
  assert.ok(
    more.units <= 2 * nearby.units,
    'ten times as many matches stays within the same viewport budget',
  )
  t.diagnostic(JSON.stringify({ nearby, more }))
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    larger,
  )
})
