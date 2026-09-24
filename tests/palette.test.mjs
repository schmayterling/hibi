import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { uiName } from './ui.mjs'

test('command palette, full-height settings, and local geist fonts', {
  timeout: 45000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-palette-'))
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
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const rich = page.getByRole('textbox', { name: /document editor/i })
  await rich.waitFor()
  await rich.fill('keep this draft')
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+k' : 'Control+k',
  )
  const palette = page.getByRole('dialog', { name: /command palette/i })
  const search = page.getByRole('combobox', { name: /search commands/i })
  await palette.waitFor()
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const marker = palette.locator('.command-selection')
  await marker.waitFor()
  await page.waitForFunction(() =>
    document
      .querySelector('.command-palette')
      .getAnimations()
      .every((animation) => animation.playState !== 'running'),
  )
  const origin = await marker.evaluate((el) => el.getBoundingClientRect().top)
  assert.ok(
    await marker.evaluate((el) => {
      const style = getComputedStyle(el)
      const properties = style.transitionProperty
        .split(',')
        .map((part) => part.trim())
      const durations = style.transitionDuration
        .split(',')
        .map(Number.parseFloat)
      const transform = properties.indexOf('transform')
      return transform >= 0 && durations[transform % durations.length] > 0
    }),
  )
  await search.press('ArrowDown')
  await page.waitForFunction((origin) => {
    const marker = document.querySelector('.command-selection')
    const selected = document.querySelector(
      '[role="option"][aria-selected="true"]',
    )
    return (
      marker &&
      selected &&
      selected.getBoundingClientRect().top > origin + 1 &&
      Math.abs(
        marker.getBoundingClientRect().top -
          selected.getBoundingClientRect().top,
      ) < 1
    )
  }, origin)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  assert.equal(
    await marker.evaluate((el) => getComputedStyle(el).transitionDuration),
    '0s',
  )
  await search.fill('no-such-command-zzzz')
  assert.equal(await marker.count(), 0)
  await search.fill('export workspace to html')
  assert.equal(
    await palette.locator('.command-label').first().textContent(),
    'Export workspace to HTML',
  )
  await search.fill('')
  const keyStyle = (element) => {
    const style = getComputedStyle(element)
    return [
      style.height,
      style.minWidth,
      style.fontFamily,
      style.fontSize,
      style.borderRadius,
      style.borderWidth,
      style.backgroundColor,
    ]
  }
  const footerKeys = await palette
    .locator('.palette-footer kbd')
    .first()
    .evaluate(keyStyle)
  assert.deepEqual(
    await palette.locator('.shortcut-keys kbd').first().evaluate(keyStyle),
    footerKeys,
  )
  await search.click()
  assert.equal(await palette.isVisible(), true)
  await page.mouse.click(12, 400)
  await palette.waitFor({ state: 'hidden' })
  await clickMenu(app, 'Command palette')
  await palette.waitFor()
  await page.mouse.click(300, 18)
  await palette.waitFor({ state: 'hidden' })
  await clickMenu(app, 'Command palette')
  await palette.waitFor()
  await search.fill('side-by-side')
  await search.press('Enter')
  await palette.waitFor({ state: 'hidden' })
  await page.getByRole('textbox', { name: /markdown editor/i }).waitFor()
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'keep this draft',
  )
  await page.evaluate(() => document.fonts.ready.then(() => true))
  assert.deepEqual(
    await page.evaluate(() =>
      ['Geist', 'Geist Mono'].map((family) =>
        [...document.fonts].some(
          (font) => font.family === family && font.status === 'loaded',
        ),
      ),
    ),
    [true, true],
  )

  await clickMenu(app, 'Command palette')
  await search.fill('preferences settings')
  await search.press('Enter')
  await palette.waitFor({ state: 'hidden' })
  const settings = page.getByRole('main', { name: /^settings$/i, exact: true })
  await settings.waitFor()
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('.editor-surface')).opacity ===
      '0',
  )
  assert.equal(
    await page.locator('.editor-surface').evaluate((element) => element.inert),
    true,
  )
  for (const category of ['appearance', 'addon manager', 'about', 'hotkeys']) {
    await page
      .getByRole('tab', { name: uiName(category, true), exact: true })
      .click()
    if (category === 'hotkeys')
      assert.deepEqual(
        await page.locator('.hotkey-binding kbd').first().evaluate(keyStyle),
        footerKeys,
      )
    for (const width of [1000, 480]) {
      await page.setViewportSize({ width, height: 720 })
      const geometry = await page
        .getByRole('tabpanel', { name: uiName(category, true), exact: true })
        .evaluate((panel) => {
          const bounds = panel.getBoundingClientRect()
          return {
            overflow: panel.scrollWidth - panel.clientWidth,
            right: bounds.right,
            viewport: innerWidth,
          }
        })
      assert.ok(
        geometry.overflow <= 1 && geometry.right <= geometry.viewport,
        `${category} ${width}: ${JSON.stringify(geometry)}`,
      )
    }
    await page.setViewportSize({ width: 1000, height: 720 })
  }
  await page.getByRole('tab', { name: /^appearance$/i, exact: true }).click()
  const rowGeometry = await page
    .locator('#settings-appearance .setting-row:has(select)')
    .first()
    .evaluate((row) => {
      const label = row.querySelector('.setting-copy').getBoundingClientRect()
      const control = row.querySelector('select').getBoundingClientRect()
      return {
        separated: control.left > label.right,
        centered:
          Math.abs(
            label.y + label.height / 2 - control.y - control.height / 2,
          ) < 1,
      }
    })
  assert.ok(rowGeometry.separated && rowGeometry.centered)
  await page.getByRole('tab', { name: /^editor$/i, exact: true }).click()
  assert.deepEqual(
    await page.evaluate(() => {
      const sidebar = document
        .querySelector('.settings-sidebar')
        .getBoundingClientRect()
      return {
        top: sidebar.top,
        height: sidebar.height,
        viewport: innerHeight,
        wrapper: Boolean(document.querySelector('.settings-sidebar summary')),
      }
    }),
    {
      top: 0,
      height: await page.evaluate(() => innerHeight),
      viewport: await page.evaluate(() => innerHeight),
      wrapper: false,
    },
  )
  for (const name of [
    'new',
    'open',
    'save',
    'format',
    'normal',
    'side-by-side',
    'source view',
  ]) {
    assert.equal(
      await page
        .getByRole('button', { name: uiName(name, true), exact: true })
        .count(),
      0,
      name,
    )
  }
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  )
  await mkdir('test-results', { recursive: true })
  await page.screenshot({ path: 'test-results/settings.png' })

  await clickMenu(app, 'Command palette')
  await search.fill('no matching action')
  await page
    .getByRole('status')
    .filter({ hasText: /no commands found\./i })
    .waitFor()
  await search.press('Escape')
  await palette.waitFor({ state: 'hidden' })
  assert.equal(await settings.isVisible(), true)
  await clickMenu(app, 'Command palette')
  const first = await search.getAttribute('aria-activedescendant')
  await search.press('ArrowDown')
  assert.notEqual(await search.getAttribute('aria-activedescendant'), first)
  await palette.evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished)),
  )
  await page.screenshot({ path: 'test-results/command-palette.png' })
  await search.press('Escape')
  await palette.waitFor({ state: 'hidden' })

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await clickMenu(app, 'Command palette')
  await palette.waitFor()
  assert.equal(
    await palette.evaluate(
      (element) => getComputedStyle(element).animationName,
    ),
    'none',
  )
  await search.fill('back to editor')
  await search.press('Enter')
  await rich.waitFor()
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'keep this draft',
  )
  assert.deepEqual(errors, [])
})

test('recent workspace submenu filters, returns, and opens a workspace', {
  timeout: 45000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-palette-recent-'))
  const first = join(profile, 'first-workspace')
  const second = join(profile, 'second-workspace')
  await mkdir(first)
  await mkdir(second)
  await writeFile(
    join(profile, 'recent-workspaces.json'),
    JSON.stringify([first, second]),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await clickMenu(app, 'Command palette')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const search = palette.getByRole('combobox', { name: 'Search commands' })

  await search.fill('edit keyboard shortcuts')
  await search.press('Enter')
  const shortcuts = palette.getByRole('button', {
    name: 'Leave Edit keyboard shortcuts',
  })
  await shortcuts.waitFor()
  await search.fill('save document')
  assert.deepEqual(await palette.locator('.command-label').allTextContents(), [
    'Shortcut: Save document',
  ])
  await search.press('Escape')
  await search.fill('shortcut: save document')
  assert.deepEqual(await palette.locator('.command-label').allTextContents(), [
    'Shortcut: Save document',
  ])

  await search.fill('open recent workspaces')
  await search.press('Enter')
  const scope = palette.getByRole('button', {
    name: 'Leave Open recent workspaces',
  })
  await scope.waitFor()
  assert.equal(await search.inputValue(), '')
  assert.deepEqual(await palette.locator('.command-label').allTextContents(), [
    'first-workspace',
    'second-workspace',
  ])
  assert.deepEqual(await palette.locator('.command-detail').allTextContents(), [
    first,
    second,
  ])
  await page.setViewportSize({ width: 480, height: 720 })
  assert.equal(
    await palette.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
    true,
  )
  await mkdir('test-results', { recursive: true })
  await page.screenshot({ path: 'test-results/command-submenu.png' })

  await search.fill('second-workspace')
  assert.deepEqual(await palette.locator('.command-label').allTextContents(), [
    'second-workspace',
  ])
  await search.press('Escape')
  assert.equal(await scope.count(), 0)
  assert.equal(await palette.isVisible(), true)

  await search.fill('open recent workspaces')
  await search.press('Enter')
  await scope.click()
  assert.equal(await scope.count(), 0)
  await search.fill('open recent workspaces')
  await search.press('Enter')
  await search.press('Backspace')
  assert.equal(await scope.count(), 0)

  await search.fill('open recent workspaces')
  await search.press('Enter')
  await search.fill('second-workspace')
  await search.press('Enter')
  await palette.waitFor({ state: 'hidden' })
  await page.waitForFunction(
    async () => (await window.hibi.getWorkspace())?.name === 'second-workspace',
  )
})
