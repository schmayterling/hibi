import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('large graphs fit padded sidebars and expanded views, resize, zoom and filter', {
  timeout: 90000,
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'hibi-graph-layout-'))
  const root = join(temp, 'notes'),
    profile = join(temp, 'profile')
  await mkdir(root)
  await mkdir(profile)
  const name = (index) => `n${String(index).padStart(3, '0')}.md`
  for (let index = 0; index < 500; index++)
    await writeFile(
      join(root, name(index)),
      `# Note ${index}\n\n${[1, 7, 17].map((offset) => `[Next](${name((index + offset) % 500)})`).join('\n')}`,
    )
  await writeFile(join(profile, 'addons.json'), JSON.stringify({ graph: true }))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(temp, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  await page.setViewportSize({ width: 1100, height: 800 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, root)
  await pressShortcut(
    app,
    `${process.platform === 'darwin' ? 'Meta' : 'Control'}+Shift+o`,
  )
  await page
    .getByRole('tree', { name: /workspace files/i })
    .getByRole('treeitem', { name: /^n000\.md$/, exact: true })
    .click()
  await page
    .getByRole('textbox', { name: /document editor/i })
    .getByRole('heading', { name: 'Note 0', exact: true })
    .waitFor()
  await clickMenu(app, 'Command palette')
  await page
    .getByRole('combobox', { name: /search commands/i })
    .fill('Open workspace graph')
  await page.getByRole('option').first().click()
  const sidebar = page.getByRole('complementary', {
    name: /^workspace graph$/i,
    exact: true,
  })
  await sidebar.getByText(/500 of 500 notes/).waitFor()
  await sidebar.locator('.graph-canvas[data-labels]').waitFor()
  // The canvas keeps the camera transform of its last frame; wait for the
  // frame drawn after the latest input.
  const cameraScale = (view) =>
    view.locator('canvas').evaluate(async (canvas) => {
      await new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      )
      return (
        canvas.getContext('2d').getTransform().a /
        (canvas.width / canvas.getBoundingClientRect().width)
      )
    })
  const startingScale = await cameraScale(sidebar)
  // Every drawn pixel stays 16 px inside the frame, and the list holds every note.
  const fitted = async (view, count = 500) => {
    await page.waitForFunction(
      ({ element, count }) => {
        const canvas = element.querySelector('.graph-view canvas')
        const option = element.querySelector('.graph-nodes [role="option"]')
        if (
          !canvas?.width ||
          option?.getAttribute('aria-setsize') !== String(count)
        )
          return false
        const ratio = canvas.width / canvas.getBoundingClientRect().width
        const inset = Math.ceil(16 * ratio)
        const { data, width, height } = canvas
          .getContext('2d')
          .getImageData(0, 0, canvas.width, canvas.height)
        let drawn = false
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++) {
            if (!data[(y * width + x) * 4 + 3]) continue
            drawn = true
            if (
              x < inset ||
              y < inset ||
              x >= width - inset ||
              y >= height - inset
            )
              return false
          }
        return drawn
      },
      { element: await view.elementHandle(), count },
      { polling: 100 },
    )
  }
  await sidebar.getByRole('button', { name: 'Fit graph' }).click()
  await fitted(sidebar)
  assert.ok(startingScale > (await cameraScale(sidebar)) * 3)
  const bounds = await sidebar.locator('.graph-canvas').boundingBox()
  const filter = await sidebar
    .getByRole('searchbox', { name: /filter graph notes/i })
    .boundingBox()
  const panel = await sidebar.boundingBox()
  assert.ok(Math.abs(bounds.width - bounds.height) < 1)
  assert.ok(Math.abs(bounds.x - filter.x) < 1)
  assert.ok(filter.x - panel.x >= 12)
  assert.ok(panel.x + panel.width - filter.x - filter.width >= 12)
  assert.equal(
    await sidebar
      .getByRole('option', { name: 'Open n000.md', exact: true })
      .getAttribute('aria-selected'),
    'true',
  )
  const connections = await sidebar
    .locator('.graph-connections h3')
    .boundingBox()
  assert.ok(Math.abs(connections.x + 12 - filter.x) < 1)
  assert.equal(
    await sidebar
      .locator('.sidebar-content')
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
    true,
  )
  assert.equal(
    await sidebar.locator('.graph-canvas').getAttribute('data-labels'),
    'false',
  )
  const before = await cameraScale(sidebar)
  await sidebar.getByRole('button', { name: 'Zoom out', exact: true }).click()
  await waitForAsync(
    page,
    async (before) => {
      const canvas = document.querySelector('.addon-sidebar canvas')
      return (
        canvas.getContext('2d').getTransform().a /
          (canvas.width / canvas.getBoundingClientRect().width) <
        before
      )
    },
    before,
  )
  await sidebar.getByRole('button', { name: 'Fit graph', exact: true }).click()
  await fitted(sidebar)
  const handle = page
    .locator('.addon-sidebar')
    .getByRole('separator', { name: /resize sidebar/i })
  await handle.focus()
  for (let step = 0; step < 8; step++) await handle.press('ArrowRight')
  await page.waitForFunction(
    (before) =>
      document
        .querySelector('.addon-sidebar .graph-canvas')
        .getBoundingClientRect().width >
      before + 10,
    bounds.width,
  )
  await fitted(sidebar)
  await mkdir('test-results', { recursive: true })
  await page.screenshot({ path: 'test-results/large-workspace-graph.png' })
  await sidebar
    .getByRole('button', { name: 'Expand graph', exact: true })
    .click()
  const expanded = page.getByRole('tabpanel', { name: /^workspace graph$/i })
  await expanded.getByRole('button', { name: 'Fit graph' }).click()
  await fitted(expanded)
  const expandedBox = await expanded.locator('.graph-canvas').boundingBox()
  assert.ok(expandedBox.width > bounds.width)
  await page.screenshot({ path: 'test-results/expanded-workspace-graph.png' })
  const graphTab = page.getByRole('tab', { name: /^workspace graph$/i })
  await page.getByRole('tab', { name: /^n000\.md$/i }).click()
  await expanded.waitFor({ state: 'hidden' })
  await graphTab.click()
  await expanded.getByRole('button', { name: 'Fit graph' }).click()
  await fitted(expanded)
  await page.getByRole('button', { name: 'Close Workspace graph' }).click()
  await graphTab.waitFor({ state: 'detached' })
  await fitted(sidebar)
  const search = sidebar.getByRole('searchbox', { name: /filter graph notes/i })
  await search.fill('n000')
  await fitted(sidebar, 1)
  await sidebar.getByRole('button', { name: 'Expand graph' }).click()
  assert.equal(
    await expanded
      .getByRole('searchbox', { name: /filter graph notes/i })
      .inputValue(),
    'n000',
  )
  await fitted(expanded, 1)
  await page.getByRole('button', { name: 'Close Workspace graph' }).click()
  await sidebar.locator('.graph-canvas[data-labels="true"]').waitFor()
  await search.fill('no-matching-note')
  await sidebar.getByText('No matching notes', { exact: true }).waitFor()
  await search.fill('')
  await sidebar.getByRole('button', { name: 'Fit graph' }).click()
  await fitted(sidebar)
  await sidebar.getByRole('button', { name: 'Expand graph' }).click()
  await expanded
    .getByRole('searchbox', { name: /filter graph notes/i })
    .waitFor()
  await page.setViewportSize({ width: 768, height: 720 })
  await expanded.locator('.graph-canvas').waitFor()
  const inset = await expanded.evaluate((panel) => {
    const panelBox = panel.getBoundingClientRect()
    const input = panel.querySelector('input').getBoundingClientRect()
    const canvas = panel.querySelector('.graph-canvas').getBoundingClientRect()
    return {
      left: input.left - panelBox.left,
      right: panelBox.right - input.right,
      canvasLeft: canvas.left - panelBox.left,
    }
  })
  assert.ok(inset.left >= 15 && inset.right >= 15)
  assert.ok(Math.abs(inset.canvasLeft - inset.left) < 1)
  const expandedSvg = expanded.getByRole('application', {
    name: 'Workspace graph',
  })
  await expandedSvg.click({ position: { x: 5, y: 5 } })
  assert.equal(
    await expandedSvg.evaluate((element) => element.matches(':focus-visible')),
    false,
  )
  await page.screenshot({ path: 'test-results/graph-tab-narrow.png' })
  await page.setViewportSize({ width: 1100, height: 800 })
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  await page.getByRole('tab', { name: 'Graph', exact: true }).click()
  const zoomSetting = page.locator('#graph-default-zoom')
  assert.equal(await zoomSetting.inputValue(), '8')
  await zoomSetting.fill('4')
  assert.equal(
    await page.evaluate(() => localStorage.getItem('graph:default-zoom')),
    '4',
  )
  assert.deepEqual(errors, [])
})
