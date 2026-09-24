import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'

test('sidebar starts hidden, stays open while typing, and navigates the page outline in either editor', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-sidebar-views-'))
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
  page.setDefaultTimeout(6500)
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await page.waitForFunction(
    () =>
      document.querySelector('.app')?.getAttribute('data-sidebar') === 'false',
  )
  await page
    .getByRole('button', { name: /^source view$/i, exact: true })
    .click()
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  const text =
    '# alpha\n\n' +
    'paragraph\n\n'.repeat(40) +
    '## second\n\n```md\n# code example\n```\n'
  await source.fill(text)
  await page.getByRole('button', { name: /toggle workspace sidebar/i }).click()
  await page
    .getByRole('button', { name: /^sidebar views$/i, exact: true })
    .click()
  await page
    .getByRole('menuitem', { name: /^on this page$/i, exact: true })
    .click()
  const outline = page.getByRole('tree', { name: /on this page/i })
  await outline
    .getByRole('treeitem', { name: /^second$/i, exact: true })
    .waitFor()
  assert.equal(await outline.getByRole('treeitem').count(), 2)
  await outline
    .getByRole('treeitem', { name: /^second$/i, exact: true })
    .click()
  await page.waitForFunction(() =>
    document.activeElement?.classList.contains('cm-content'),
  )
  assert.match(
    await page.evaluate(
      () =>
        window.getSelection()?.anchorNode?.parentElement?.closest('.cm-line')
          ?.textContent,
    ),
    /second/,
  )
  await source.press('End')
  await source.press('x')
  assert.equal(await page.locator('.app').getAttribute('data-sidebar'), 'true')
  await outline
    .getByRole('treeitem', { name: /^secondx$/i, exact: true })
    .waitFor()
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await outline.getByRole('treeitem', { name: /^alpha$/i, exact: true }).click()
  await page.waitForFunction(() =>
    document.activeElement?.classList.contains('tiptap'),
  )
  assert.equal(
    await page.evaluate(
      () =>
        window.getSelection()?.anchorNode?.parentElement?.closest('h1')
          ?.textContent,
    ),
    'alpha',
  )
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+/' : 'Control+/',
  )
  await page.waitForFunction(
    () =>
      document.querySelector('.app')?.getAttribute('data-sidebar') === 'false',
  )
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+/' : 'Control+/',
  )
  await outline.waitFor()
  await page
    .getByRole('button', { name: /^sidebar views$/i, exact: true })
    .click()
  await page
    .getByRole('menuitem', { name: /^workspace$/i, exact: true })
    .click()
  await page
    .getByRole('button', { name: /^open workspace$/i, exact: true })
    .waitFor()
  await page.reload()
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  assert.equal(await page.locator('.app').getAttribute('data-sidebar'), 'false')
})

test('outline nesting follows the cursor and sidebar view pins survive reload', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-outline-cursor-'))
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
  page.setDefaultTimeout(6500)
  await page.getByRole('button', { name: /^source view$/i }).click()
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  await source.fill(
    'introduction\n\n# alpha\n\nalpha body\n\n### deep\n\ndeep body\n\n## beta\n\nbeta body\n\n# final\n\nfinal body',
  )
  const views = page.getByRole('button', { name: /^sidebar views$/i })
  assert.equal(await views.count(), 0)
  assert.equal(await page.locator('.sidebar-view-shortcuts button').count(), 0)
  await page.getByRole('button', { name: /toggle workspace sidebar/i }).click()
  await views.click()
  await page.getByRole('menuitem', { name: /^on this page$/i }).click()
  const outline = page.getByRole('tree', { name: /on this page/i })
  await outline.getByRole('treeitem', { name: 'deep' }).waitFor()
  assert.deepEqual(
    await outline
      .getByRole('treeitem')
      .evaluateAll((items) =>
        items.map((item) => item.getAttribute('aria-level')),
      ),
    ['1', '2', '2', '1'],
  )
  const active = (name) =>
    outline.getByRole('treeitem', { name, selected: true }).waitFor()
  await source
    .locator('.cm-line')
    .filter({ hasText: /^deep body$/ })
    .click()
  await active('deep')
  await source.press('ArrowUp')
  await active('deep')
  await source
    .locator('.cm-line')
    .filter({ hasText: /^introduction$/ })
    .click()
  await page.waitForFunction(
    () => !document.querySelector('.outline-sidebar [aria-selected="true"]'),
  )
  await source
    .locator('.cm-line')
    .filter({ hasText: /^## beta$/ })
    .click({ position: { x: 2, y: 8 } })
  await active('beta')
  await page.getByRole('button', { name: /^normal$/i }).click()
  await page
    .locator('.tiptap p')
    .filter({ hasText: /^alpha body$/ })
    .click()
  await active('alpha')
  await outline.getByRole('treeitem', { name: 'deep' }).click()
  await active('deep')
  await outline.getByRole('treeitem', { name: 'alpha' }).click()
  await active('alpha')
  await page.getByRole('button', { name: /^side-by-side$/i }).click()
  await source
    .locator('.cm-line')
    .filter({ hasText: /^final body$/ })
    .click()
  await active('final')
  await page
    .locator('.tiptap p')
    .filter({ hasText: /^deep body$/ })
    .click()
  await active('deep')

  await views.click()
  assert.equal(
    await page.getByRole('menuitem').first().innerText(),
    'Pin On this page tab',
  )
  await page.getByRole('menuitem', { name: /^pin on this page tab$/i }).click()
  assert.deepEqual(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem('sidebar-pinned-views')),
    ),
    ['outline'],
  )
  const resize = page
    .locator('.outline-sidebar')
    .getByRole('separator', { name: /resize sidebar/i })
  await resize.press('End')
  await page.getByRole('button', { name: 'On this page view' }).waitFor()
  assert.equal(
    await page
      .locator('.sidebar-view-shortcuts button')
      .first()
      .getAttribute('aria-label'),
    'On this page view',
  )
  const edge = await page.evaluate(() => {
    const sidebar = document
      .querySelector('.outline-sidebar > .sidebar')
      .getBoundingClientRect()
    const toggle = document
      .querySelector('.sidebar-toggle')
      .getBoundingClientRect()
    return sidebar.right - toggle.right
  })
  assert.ok(Math.abs(edge - 8) < 1)
  const toggleIcon = await page.locator('.sidebar-toggle svg').innerHTML()
  await page.getByRole('button', { name: /^workspace view$/i }).click()
  assert.equal(
    await page.locator('.sidebar-toggle svg').innerHTML(),
    toggleIcon,
  )
  await page.getByRole('button', { name: /^on this page view$/i }).click()
  await resize.press('Home')
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll('.sidebar-view-shortcuts button').length ===
      count,
    process.platform === 'darwin' ? 0 : 2,
  )
  await views.click()
  await page.getByRole('menuitem', { name: /^workspace$/i }).waitFor()
  await page.keyboard.press('Escape')
  await page.reload()
  assert.equal(await views.count(), 0)
  await page.getByRole('button', { name: /toggle workspace sidebar/i }).click()
  await views.waitFor()
  assert.deepEqual(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem('sidebar-pinned-views')),
    ),
    ['outline'],
  )
})
