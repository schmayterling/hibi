import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu, replaceSourceText } from './keyboard.mjs'

test('right sidebar starts empty, remembers its view and width, and collapses independently', {
  timeout: 45000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-right-sidebar-'))
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
  await page.setViewportSize({ width: 1100, height: 800 })
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const shell = page.locator('.app')
  const rightToggle = page.getByRole('button', {
    name: /^toggle right sidebar$/i,
  })
  const leftToggle = page.getByRole('button', {
    name: /toggle workspace sidebar/i,
  })
  const picker = page.getByRole('button', { name: /^right sidebar views$/i })
  const right = page.locator(
    '.document-sidebar[data-side="right"][data-open="true"]',
  )
  assert.equal(await shell.getAttribute('data-right-sidebar'), 'false')
  assert.equal(await right.count(), 0)
  await rightToggle.click()
  await right.getByText(/no view selected/i).waitFor()
  const aligned = async () => {
    if (process.platform !== 'darwin') return
    const geometry = await page.evaluate(() => {
      const panel = document
        .querySelector(
          '.document-sidebar[data-side="right"][data-open="true"] > aside',
        )
        .getBoundingClientRect()
      const toolbar = document
        .querySelector('.right-sidebar-toolbar')
        .getBoundingClientRect()
      const toggle = document
        .querySelector('.right-sidebar-toggle')
        .getBoundingClientRect()
      const menu = document
        .querySelector('.right-sidebar-view-controls button')
        .getBoundingClientRect()
      return {
        left: toolbar.left - panel.left,
        right: panel.right - toolbar.right,
        toggle: toggle.left - panel.left,
        menu: panel.right - menu.right,
        center: toggle.top + toggle.height / 2 - (menu.top + menu.height / 2),
      }
    })
    assert.deepEqual(geometry, {
      left: 0,
      right: 0,
      toggle: 8,
      menu: 8,
      center: 0,
    })
  }
  await aligned()
  if (process.env.HIBI_RIGHT_SCREENSHOT)
    await page.locator('.right-sidebar-toolbar').screenshot({
      path: process.env.HIBI_RIGHT_SCREENSHOT.replace('.png', '-empty.png'),
    })
  const choose = async (name) => {
    await picker.click()
    await page.getByRole('menuitem', { name, exact: true }).click()
  }
  const command = async (label) => {
    await clickMenu(app, 'Command palette')
    await page.getByRole('combobox', { name: /search commands/i }).fill(label)
    await page.getByRole('option').first().click()
    await page
      .getByRole('combobox', { name: /search commands/i })
      .waitFor({ state: 'hidden' })
  }
  // Workspace views live only on the left; every offered item opens.
  await picker.click()
  const offered = await page
    .getByRole('menuitem')
    .evaluateAll((items) => items.map((item) => item.textContent.trim()))
  if (process.env.HIBI_RIGHT_SCREENSHOT)
    await page.screenshot({
      path: process.env.HIBI_RIGHT_SCREENSHOT.replace('.png', '-picker.png'),
    })
  await page.keyboard.press('Escape')
  assert.deepEqual(offered.slice(0, 3), [
    'No view',
    'On this page',
    'Backlinks',
  ])
  assert.ok(
    offered.every((label) => !/^Workspaces?$/.test(label)),
    JSON.stringify(offered),
  )
  await choose('On this page')
  await right.getByText(/add headings to this note/i).waitFor()
  await page.getByRole('button', { name: /^source view$/i }).click()
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  await replaceSourceText(page, source, '# first\n\nbody\n\n## second\n\nend')
  await right.getByRole('treeitem', { name: 'second', exact: true }).click()
  await page.waitForFunction(() =>
    document.activeElement?.classList.contains('cm-content'),
  )
  assert.equal(await shell.getAttribute('data-right-sidebar'), 'true')
  await leftToggle.click()
  assert.equal(await shell.getAttribute('data-sidebar'), 'true')
  const leftWidth = await page.evaluate(() =>
    localStorage.getItem('sidebar-width'),
  )
  const resize = right.getByRole('separator', { name: /resize right sidebar/i })
  const before = Number(await resize.getAttribute('aria-valuenow'))
  await resize.press('ArrowLeft')
  assert.equal(Number(await resize.getAttribute('aria-valuenow')), before + 8)
  await resize.press('ArrowRight')
  assert.equal(Number(await resize.getAttribute('aria-valuenow')), before)
  assert.equal(
    await page.evaluate(() => localStorage.getItem('sidebar-width')),
    leftWidth,
  )
  const bounds = await page.evaluate(() => {
    const editor = document
      .querySelector('.editor-surface')
      .getBoundingClientRect()
    const left = document
      .querySelector(
        '.document-sidebar[data-side="left"][data-open="true"] > aside',
      )
      .getBoundingClientRect()
    const right = document
      .querySelector(
        '.document-sidebar[data-side="right"][data-open="true"] > aside',
      )
      .getBoundingClientRect()
    return {
      editor: { left: editor.left, right: editor.right, width: editor.width },
      left: left.right,
      right: right.left,
      edge: right.right,
      viewport: innerWidth,
    }
  })
  assert.ok(
    Math.abs(bounds.editor.left - bounds.left) < 1,
    JSON.stringify(bounds),
  )
  assert.ok(
    Math.abs(bounds.editor.right - bounds.right) < 1,
    JSON.stringify(bounds),
  )
  assert.ok(Math.abs(bounds.edge - bounds.viewport) < 1, JSON.stringify(bounds))
  assert.ok(bounds.editor.width >= 200, JSON.stringify(bounds))
  await aligned()
  if (process.env.HIBI_RIGHT_SCREENSHOT)
    await page.screenshot({ path: process.env.HIBI_RIGHT_SCREENSHOT })
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await rightToggle.click()
  const slide = await page.evaluate(() => {
    const pane = document.querySelector(
      '.outline-sidebar[data-side="right"] > aside',
    )
    const transition = pane
      .getAnimations()
      .find((animation) => animation.transitionProperty === 'transform')
    if (!transition) return null
    transition.pause()
    transition.currentTime = Number(transition.effect.getTiming().duration) / 2
    const bounds = pane.getBoundingClientRect()
    const result = { x: bounds.x, width: bounds.width, viewport: innerWidth }
    transition.finish()
    return result
  })
  assert.ok(
    slide && slide.x > slide.viewport - slide.width && slide.x < slide.viewport,
    JSON.stringify(slide),
  )
  await page.emulateMedia({ reducedMotion: 'reduce' })
  assert.equal(await shell.getAttribute('data-right-sidebar'), 'false')
  assert.equal(await shell.getAttribute('data-sidebar'), 'true')
  await rightToggle.click()
  await right.getByRole('treeitem', { name: 'second', exact: true }).waitFor()
  await command('Enter zen mode')
  await page.waitForFunction(
    () => document.querySelector('.app')?.getAttribute('data-zen') === 'true',
  )
  assert.equal(await right.count(), 0)
  assert.equal(await shell.getAttribute('data-right-sidebar'), 'false')
  await page.getByRole('button', { name: 'Exit zen mode', exact: true }).click()
  await right.getByRole('treeitem', { name: 'second', exact: true }).waitFor()
  await command('Toggle right sidebar')
  // The palette runs commands on the frame after its dialog closes.
  await page.waitForFunction(
    () =>
      document.querySelector('.app')?.getAttribute('data-right-sidebar') ===
      'false',
  )
  assert.equal(await shell.getAttribute('data-right-sidebar'), 'false')
  await command('Toggle right sidebar')
  await right.getByRole('treeitem', { name: 'second', exact: true }).waitFor()

  // Dragging the left edge toward the right collapses and restores keyboard focus.
  const edge = await resize.boundingBox()
  await page.mouse.move(edge.x + edge.width / 2, edge.y + 110)
  await page.mouse.down()
  await page.mouse.move(edge.x + before, edge.y + 110, { steps: 12 })
  await page.mouse.up()
  await page.waitForFunction(
    () => document.querySelector('.app').dataset.rightSidebar === 'false',
  )
  assert.equal(
    await rightToggle.evaluate((node) => document.activeElement === node),
    true,
  )
  await rightToggle.click()

  await clickMenu(app, 'Settings')
  assert.equal(await right.count(), 0)
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await right.getByRole('treeitem', { name: 'second', exact: true }).waitFor()
  await page.reload()
  await rightToggle.waitFor()
  assert.equal(await shell.getAttribute('data-right-sidebar'), 'false')
  await rightToggle.click()
  await right.getByRole('tree', { name: /on this page/i }).waitFor()
  assert.equal(Number(await resize.getAttribute('aria-valuenow')), before)

  // Narrow windows use one overlay at a time and keep the editor full-width.
  await page.setViewportSize({ width: 600, height: 720 })
  await page.waitForFunction(
    () => document.querySelector('.app').dataset.sidebarOverlay === 'true',
  )
  assert.equal(await shell.getAttribute('data-right-sidebar'), 'false')
  await rightToggle.click()
  const narrow = await page.evaluate(() => {
    const right = document
      .querySelector(
        '.document-sidebar[data-side="right"][data-open="true"] > aside',
      )
      .getBoundingClientRect()
    const editor = document.querySelector('.editor-surface')
    return {
      edge: right.right,
      width: editor.getBoundingClientRect().width,
      viewport: innerWidth,
      inert: editor.inert,
    }
  })
  assert.equal(narrow.edge, narrow.viewport)
  assert.equal(narrow.width, narrow.viewport)
  assert.equal(narrow.inert, true)
  if (process.env.HIBI_RIGHT_SCREENSHOT)
    await page.screenshot({
      path: process.env.HIBI_RIGHT_SCREENSHOT.replace('.png', '-narrow.png'),
    })
  await right.getByRole('treeitem', { name: 'second', exact: true }).click()
  await page.waitForFunction(
    () => document.querySelector('.app').dataset.rightSidebar === 'false',
  )
  await rightToggle.click()
  await page.keyboard.press('Escape')
  await page.waitForFunction(
    () => document.querySelector('.app').dataset.rightSidebar === 'false',
  )
  await leftToggle.click()
  await page.mouse.click(580, 380)
  await rightToggle.click()
  await choose('No view')
  await right.getByText(/no view selected/i).waitFor()
  await page.mouse.click(4, 380)
  await page.setViewportSize({ width: 1100, height: 800 })
  await page.waitForFunction(
    () => document.querySelector('.app').dataset.sidebarOverlay === 'false',
  )
  await right.getByText(/no view selected/i).waitFor()
  for (const platform of ['win32', 'linux']) {
    await shell.evaluate((node, platform) => {
      node.dataset.platform = platform
    }, platform)
    const controls = await page
      .getByRole('button', { name: 'Right sidebar views', exact: true })
      .boundingBox()
    const panel = await right.locator(':scope > aside').boundingBox()
    assert.ok(
      controls.x >= panel.x &&
        controls.x + controls.width <= panel.x + panel.width,
      JSON.stringify({ controls, panel }),
    )
    assert.ok(controls.y >= 36)
  }
})
