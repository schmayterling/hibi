import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { settingsPages } from '../src/renderer/src/settings-pages.ts'
import { electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

test('settings registrations use addon ownership and clean up without collisions', () => {
  const Content = () => null
  const category = settingsPages.registerCategory('one', {
    id: 'tools',
    label: 'Tools',
  })
  const page = settingsPages.register('one', {
    id: 'options',
    label: 'Options',
    category: 'tools',
    Content,
  })
  const other = settingsPages.register('two', {
    id: 'options',
    label: 'Other',
    Content,
  })
  try {
    assert.equal(settingsPages.snapshot().pages[0].category, 'one.tools')
    assert.equal(settingsPages.snapshot().pages[1].category, 'addons')
    assert.throws(
      () =>
        settingsPages.register('one', {
          id: 'options',
          label: 'Duplicate',
          Content,
        }),
      /duplicate/,
    )
    assert.throws(
      () =>
        settingsPages.register('one', { id: '../bad', label: 'Bad', Content }),
      /invalid/,
    )
    assert.throws(
      () =>
        settingsPages.register('one', {
          id: 'bad',
          label: 'Bad',
          Content: null,
        }),
      /invalid/,
    )
  } finally {
    page()
    page()
    other()
    category()
  }
  assert.deepEqual(settingsPages.snapshot(), { categories: [], pages: [] })
})

test('status visibility, zen mode, settings groups, search clear and import notice use shared layout', {
  timeout: 45000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-focus-settings-'))
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
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const editor = page.getByRole('textbox', { name: /document editor/i })
  await editor.waitFor()
  await editor.fill('A quiet place to write.')
  const choose = async (label) => {
    await clickMenu(app, 'Command palette')
    await page.getByRole('combobox', { name: /search commands/i }).fill(label)
    await page.getByRole('option').first().click()
    await page
      .getByRole('combobox', { name: /search commands/i })
      .waitFor({ state: 'hidden' })
  }
  const settings = async () => {
    await clickMenu(app, 'Settings')
    await page.getByRole('tab', { name: 'Appearance', exact: true }).click()
  }
  const back = () =>
    page.getByRole('button', { name: /^back to app$/i }).click()
  await settings()
  const groups = await page
    .locator('.settings-sidebar .sidebar-section')
    .allTextContents()
  assert.deepEqual(groups, ['Editing', 'Interface', 'Addons', 'Addon settings'])
  assert.equal(
    await page.locator('.settings-sidebar .sidebar-section:empty').count(),
    0,
  )
  assert.equal(
    await page.locator('#category-hibi').evaluate((button) => {
      const row = button.parentElement
      return (
        row?.hasAttribute('data-divider') &&
        row.getBoundingClientRect().top -
          row.previousElementSibling?.getBoundingClientRect().bottom ===
          12
      )
    }),
    true,
  )
  assert.equal(
    await page
      .locator('.settings-sidebar .sidebar-section')
      .filter({ hasText: 'Addon settings' })
      .evaluate(
        (section) =>
          section.previousElementSibling?.querySelector(
            '#category-dependencies',
          ) !== null &&
          section.nextElementSibling?.querySelector(
            '[id^="category-plugin-"], [id^="category-addon-"]',
          ) !== null,
      ),
    true,
  )
  assert.equal(
    await page
      .locator('.settings-sidebar .sidebar-scroll > .settings-versions')
      .count(),
    1,
  )
  const scroll = page.locator('.settings-sidebar .sidebar-scroll')
  assert.equal(
    await scroll.evaluate((element) => getComputedStyle(element).paddingTop),
    '0px',
  )
  await page.waitForFunction(() =>
    document
      .querySelector('.settings-sidebar .sidebar-scroll')
      ?.hasAttribute('data-fade-bottom'),
  )
  await scroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await page.waitForFunction(() => {
    const element = document.querySelector('.settings-sidebar .sidebar-scroll')
    return (
      element?.hasAttribute('data-fade-top') &&
      !element.hasAttribute('data-fade-bottom')
    )
  })
  await scroll.evaluate((element) => {
    element.scrollTop = 0
  })
  await page.getByRole('tab', { name: 'About', exact: true }).click()
  await page.waitForFunction(() => {
    const selected = document.querySelector(
      '.settings-sidebar [aria-selected="true"]',
    )
    const marker = document.querySelector(
      '.settings-sidebar .sidebar-selection',
    )
    return (
      selected &&
      marker &&
      Math.abs(
        selected.getBoundingClientRect().top -
          marker.getBoundingClientRect().top,
      ) < 1
    )
  })
  await page.getByRole('tab', { name: 'Appearance', exact: true }).click()
  const search = page.getByRole('textbox', {
    name: 'Search settings',
    exact: true,
  })
  await search.fill('status')
  assert.equal(
    await scroll.evaluate((element) => getComputedStyle(element).paddingTop),
    '0px',
  )
  const clear = page.getByRole('button', {
    name: 'Clear settings search',
    exact: true,
  })
  await clear.hover()
  assert.equal(
    await clear.evaluate((node) => getComputedStyle(node).backgroundColor),
    'rgba(0, 0, 0, 0)',
  )
  await clear.click()
  await page.getByLabel('Status bar', { exact: true }).selectOption('hidden')
  await back()
  assert.equal(await page.locator('.app-statusbar').count(), 0)
  await settings()
  await page.getByLabel('Status bar', { exact: true }).selectOption('auto')
  await back()
  await page.mouse.move(400, 150)
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('.app-statusbar')).opacity ===
      '0',
  )
  const edge = await page.locator('.statusbar-slot').boundingBox()
  await page.mouse.move(edge.x + 5, edge.y + edge.height - 2)
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('.app-statusbar')).opacity ===
      '1',
  )
  await page.locator('[data-status-id="flavor"]').focus()
  await page.mouse.move(400, 150)
  assert.equal(
    await page
      .locator('.app-statusbar')
      .evaluate((node) => getComputedStyle(node).opacity),
    '1',
  )
  await editor.focus()
  await choose('Show workspace sidebar')
  await page.waitForFunction(
    () => document.querySelector('.app').dataset.sidebar === 'true',
  )
  const preferences = await page.evaluate(() => ({
    sidebar: document.querySelector('.app').dataset.sidebar,
    toolbar: localStorage.getItem('hibi:toolbar'),
    status: localStorage.getItem('status-bar'),
  }))
  await choose('Enter zen mode')
  await page.waitForFunction(
    () => document.querySelector('.app').dataset.zen === 'true',
  )
  assert.equal(await page.locator('.app').getAttribute('data-zen'), 'true')
  assert.equal(await page.locator('.titlebar').isVisible(), false)
  assert.equal(await page.locator('.toolbar-slot').isVisible(), false)
  assert.equal(await page.locator('.app-statusbar').count(), 0)
  assert.equal(await page.locator('.app').getAttribute('data-sidebar'), 'false')
  await mkdir('test-results', { recursive: true })
  await page.screenshot({ path: 'test-results/zen-mode.png' })
  await page.getByRole('button', { name: 'Exit zen mode', exact: true }).click()
  assert.equal(await page.locator('.app').getAttribute('data-zen'), 'false')
  assert.equal(
    await page.locator('.app').getAttribute('data-sidebar'),
    preferences.sidebar,
  )
  assert.equal(
    await page.evaluate(() => localStorage.getItem('status-bar')),
    preferences.status,
  )
  assert.equal(
    await page.evaluate(() => localStorage.getItem('hibi:toolbar')),
    preferences.toolbar,
  )
  await choose('Source view')
  await page.getByRole('textbox', { name: /markdown editor/i }).waitFor()
  await choose('Enter zen mode')
  await page.waitForFunction(
    () => document.querySelector('.app').dataset.zen === 'true',
  )
  await page.waitForFunction(() =>
    document.activeElement?.classList.contains('cm-content'),
  )
  await page.getByRole('button', { name: 'Exit zen mode', exact: true }).click()
  await page.waitForFunction(() =>
    document.activeElement?.classList.contains('cm-content'),
  )
  assert.match(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    /A quiet place to write/,
  )
  await choose('Normal view')
  await editor.waitFor()
  await page.reload()
  await editor.waitFor()
  assert.equal(
    await page.locator('.statusbar-slot').getAttribute('data-visibility'),
    'auto',
  )
  await choose('Import into workspace')
  const modal = page.getByRole('dialog', { name: /import into workspace/i })
  const notice = await modal.locator('.document-notice').boundingBox()
  const select = await modal
    .getByLabel('Import from', { exact: true })
    .boundingBox()
  assert.ok(Math.abs(notice.x - select.x) <= 1)
  assert.ok(Math.abs(notice.width - select.width) <= 1)
  await page.screenshot({ path: 'test-results/import-notice-alignment.png' })
  await page.keyboard.press('Escape')
  await settings()
  await page.screenshot({ path: 'test-results/settings-categories.png' })
})
