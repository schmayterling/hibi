import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { exportOptions } from '../src/addons/documentation/options.ts'
import { prepareSite, siteFiles } from '../src/addons/documentation/site.ts'
import { electron } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'

// Counts layout frames from workers and pixel-producing canvas calls per animation frame.
function instrument() {
  const Original = window.Worker
  window.graphWorkers = []
  window.Worker = class extends Original {
    constructor(url, options) {
      super(url, options)
      const record = { url: String(url), frames: 0, ticks: 0, settled: false }
      window.graphWorkers.push(record)
      this.addEventListener('message', (event) => {
        if (!event.data?.positions) return
        record.frames++
        record.ticks = event.data.ticks
        record.settled ||= event.data.settled
      })
    }
  }
  const draws = { frames: [], current: 0 }
  window.graphDraws = draws
  for (const name of ['fill', 'stroke', 'fillText']) {
    const original = CanvasRenderingContext2D.prototype[name]
    CanvasRenderingContext2D.prototype[name] = function (...args) {
      if (this.canvas.closest?.('.graph-view')) draws.current++
      return original.apply(this, args)
    }
  }
  const frame = () => {
    draws.frames.push(draws.current)
    draws.current = 0
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

test('graph code keeps d3-force in its worker bundles', async () => {
  const assets = 'out/renderer/assets'
  const files = await readdir(assets)
  const sources = await Promise.all(
    files
      .filter((file) => file.endsWith('.js'))
      .map(async (file) => [file, await readFile(join(assets, file), 'utf8')]),
  )
  const panel = sources.filter(([, source]) =>
    source.includes('layout.worker-'),
  )
  const worker = sources.filter(([file]) => file.startsWith('layout.worker-'))
  assert.equal(panel.length, 1)
  assert.equal(worker.length, 1)
  assert.ok(worker[0][1].includes('alphaDecay'))
  assert.ok(!panel[0][1].includes('alphaDecay'))
  // Exported sites inline the worker source and start it from a blob.
  assert.match(
    await readFile('out/site/template.html', 'utf8'),
    /worker-src blob:/,
  )
})

test('a 2,000-note workspace with 10,000 links shows every note and lays out off the page', {
  timeout: 120000,
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'hibi-graph-scale-'))
  const root = join(temp, 'notes'),
    profile = join(temp, 'profile')
  await mkdir(root)
  await mkdir(profile)
  const name = (index) => `n${String(index).padStart(4, '0')}`
  for (let index = 0; index < 2000; index++)
    await writeFile(
      join(root, `${name(index)}.md`),
      `# Note ${index}\n\n${[1, 7, 17, 101, 331].map((offset) => `[[${name((index + offset) % 2000)}]]`).join(' ')}`,
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
  page.setDefaultTimeout(30000)
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
    .getByRole('treeitem', { name: 'n0000.md', exact: true })
    .click()
  await page.evaluate(instrument)
  await clickMenu(app, 'Command palette')
  await page
    .getByRole('combobox', { name: /search commands/i })
    .fill('Open workspace graph')
  await page.getByRole('option').first().click()
  const sidebar = page.getByRole('complementary', {
    name: /^workspace graph$/i,
    exact: true,
  })
  // Every note and link arrives; nothing is sliced or marked incomplete.
  await sidebar
    .getByText('2000 of 2000 notes · 10000 connections', { exact: true })
    .waitFor()
  assert.equal(
    await sidebar
      .locator('.graph-nodes [role="option"]')
      .getAttribute('aria-setsize'),
    '2000',
  )
  await page.waitForFunction(() =>
    window.graphWorkers.some((worker) => worker.settled),
  )
  const workers = await page.evaluate(() => window.graphWorkers)
  const layout = workers.find((worker) => worker.url.includes('layout.worker'))
  assert.ok(layout, JSON.stringify(workers))
  assert.equal(layout.ticks, 160)
  assert.ok(layout.frames <= 3, `${layout.frames} frames`)
  // Labels are visible at the opening zoom only for notes near the view.
  await sidebar.getByRole('button', { name: 'Fit graph' }).click()
  await sidebar.locator('.graph-canvas[data-labels="false"]').waitFor()
  await page.evaluate(() => {
    window.graphDraws.frames = []
  })
  await sidebar.getByRole('button', { name: 'Zoom in' }).click()
  await page.waitForFunction(() =>
    window.graphDraws.frames.some((count) => count > 0),
  )
  // One edge path, then one path per group of dots that touch at this zoom:
  // a few dozen calls a frame for 2,000 notes, not one per note.
  assert.ok(
    Math.max(...(await page.evaluate(() => window.graphDraws.frames))) < 64,
  )
  assert.deepEqual(errors, [])
})

test('an exported 5,000-note, 20,000-link graph renders in bounded calls from an inline worker', {
  timeout: 120000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-graph-site-'))
  const name = (index) => `n${String(index).padStart(4, '0')}.md`
  const pages = Array.from({ length: 5000 }, (_, index) => ({
    path: name(index),
    markdown: `# Note ${index}\n\n${[1, 7, 17, 101].map((offset) => `[next](${name((index + offset) % 5000)})`).join(' ')}`,
  }))
  const site = prepareSite(
    { name: 'Notes', pages },
    exportOptions({ singleFile: true, graph: true }),
  )
  assert.equal(site.graph.nodes.length, 5000)
  assert.equal(site.graph.edges.length, 20000)
  const files = await siteFiles(
    await readFile('out/site/template.html', 'utf8'),
    site,
  )
  await writeFile(join(folder, 'index.html'), files.get('index.html'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  await app.firstWindow()
  const next = app.waitForEvent('window')
  await app.evaluate(
    ({ BrowserWindow }, url) => {
      const viewer = new BrowserWindow({
        show: false,
        width: 1000,
        height: 780,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      })
      void viewer.loadURL(url)
    },
    pathToFileURL(join(folder, 'index.html')).href,
  )
  const page = await next
  page.setDefaultTimeout(30000)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.getByRole('button', { name: /^open graph$/i }).waitFor()
  await page.evaluate(instrument)
  await page.getByRole('button', { name: /^open graph$/i }).click()
  const graph = page.getByRole('dialog', { name: /^graph$/i })
  assert.equal(
    await graph
      .locator('.graph-nodes [role="option"]')
      .getAttribute('aria-setsize'),
    '5000',
  )
  await page.waitForFunction(() =>
    window.graphWorkers.some((worker) => worker.settled),
  )
  const [layout] = await page.evaluate(() => window.graphWorkers)
  assert.match(layout.url, /^blob:/)
  assert.equal(layout.ticks, 160)
  await graph.getByRole('button', { name: 'Fit graph' }).click()
  await graph.locator('.graph-canvas[data-labels="false"]').waitFor()
  await page.evaluate(() => {
    window.graphDraws.frames = []
  })
  await graph.getByRole('button', { name: 'Zoom in' }).click()
  await page.waitForFunction(() =>
    window.graphDraws.frames.some((count) => count > 0),
  )
  assert.ok(
    Math.max(...(await page.evaluate(() => window.graphDraws.frames))) < 64,
  )
  assert.deepEqual(errors, [])
})

// Pages that cannot start workers fall back to laying out on the page.
function blockWorkers(throws) {
  window.workerReport = { errors: 0, frames: 0 }
  const Original = window.Worker
  window.Worker = class extends Original {
    constructor(...args) {
      if (throws)
        throw new DOMException('Workers are blocked here.', 'SecurityError')
      super(...args)
      this.addEventListener('error', () => window.workerReport.errors++)
      this.addEventListener('message', (event) => {
        if (event.data?.positions) window.workerReport.frames++
      })
    }
  }
}
const drawn = (selector) => {
  const canvas = document.querySelector(selector)
  return (
    canvas?.width > 0 &&
    canvas
      .getContext('2d')
      .getImageData(0, 0, canvas.width, canvas.height)
      .data.some((value, index) => index % 4 === 3 && value)
  )
}

test('an exported graph lays out on the page when its host blocks workers', {
  timeout: 90000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-graph-no-worker-'))
  const pages = Array.from({ length: 30 }, (_, index) => ({
    path: `n${index}.md`,
    markdown: `# Note ${index}\n\n[next](n${(index + 1) % 30}.md)`,
  }))
  const html = (
    await siteFiles(
      await readFile('out/site/template.html', 'utf8'),
      prepareSite(
        { name: 'Notes', pages },
        exportOptions({ singleFile: true, graph: true }),
      ),
    )
  ).get('index.html')
  await writeFile(join(folder, 'index.html'), html)
  // Some hosts send their own policy that forbids every worker.
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/html',
      'Content-Security-Policy': "worker-src 'none'",
    })
    response.end(html)
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  t.after(
    () =>
      new Promise((done) => {
        server.close(done)
        server.closeAllConnections()
      }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  await app.firstWindow()
  const open = async (url, throws) => {
    const next = app.waitForEvent('window')
    await app.evaluate(({ BrowserWindow }, url) => {
      const viewer = new BrowserWindow({
        show: false,
        width: 1000,
        height: 780,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      })
      void viewer.loadURL(url)
    }, url)
    const page = await next
    page.setDefaultTimeout(15000)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.getByRole('button', { name: /^open graph$/i }).waitFor()
    await page.evaluate(blockWorkers, throws)
    await page.getByRole('button', { name: /^open graph$/i }).click()
    const graph = page.getByRole('dialog', { name: /^graph$/i })
    await page.waitForFunction(drawn, '.graph-view canvas')
    assert.equal(
      await graph
        .locator('.graph-nodes [role="option"]')
        .getAttribute('aria-setsize'),
      '30',
    )
    await graph.locator('.graph-canvas[data-labels="true"]').waitFor()
    assert.deepEqual(errors, [])
    return page.evaluate(() => window.workerReport)
  }
  // The worker fails to start, so every drawn position came from the page.
  assert.deepEqual(
    await open(`http://127.0.0.1:${server.address().port}/`, false),
    { errors: 1, frames: 0 },
  )
  assert.deepEqual(
    await open(pathToFileURL(join(folder, 'index.html')).href, true),
    { errors: 0, frames: 0 },
  )
})

test('the panel lays out without a worker, keeps connections in tab order, and hints over labels', {
  timeout: 90000,
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'hibi-graph-panel-'))
  const root = join(temp, 'notes'),
    profile = join(temp, 'profile')
  await mkdir(root)
  await mkdir(profile)
  const name = (index) => `n${String(index).padStart(3, '0')}`
  await writeFile(
    join(root, 'hub.md'),
    Array.from({ length: 100 }, (_, index) => `[[${name(index + 1)}]]`).join(
      ' ',
    ),
  )
  for (let index = 1; index <= 100; index++)
    await writeFile(join(root, `${name(index)}.md`), `# ${name(index)}`)
  await writeFile(join(profile, 'addons.json'), JSON.stringify({ graph: true }))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(temp, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
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
    .getByRole('treeitem', { name: 'hub.md', exact: true })
    .click()
  await page.evaluate(blockWorkers, true)
  await clickMenu(app, 'Command palette')
  await page
    .getByRole('combobox', { name: /search commands/i })
    .fill('Open workspace graph')
  await page.getByRole('option').first().click()
  const sidebar = page.getByRole('complementary', {
    name: /^workspace graph$/i,
    exact: true,
  })
  await sidebar
    .getByText('101 of 101 notes · 100 connections', { exact: true })
    .waitFor()
  await page.waitForFunction(drawn, '.addon-sidebar .graph-view canvas')
  // A shown label belongs to its note's hint, as in the svg note group.
  const canvas = sidebar.locator('.graph-canvas')
  for (
    let step = 0;
    step < 8 && (await canvas.getAttribute('data-labels')) !== 'true';
    step++
  )
    await sidebar.getByRole('button', { name: 'Zoom in' }).click()
  await canvas.and(page.locator('[data-labels="true"]')).waitFor()
  const scale = await sidebar.locator('canvas').evaluate(async (element) => {
    await new Promise((done) =>
      requestAnimationFrame(() => requestAnimationFrame(done)),
    )
    return (
      element.getContext('2d').getTransform().a /
      (element.width / element.getBoundingClientRect().width)
    )
  })
  const dot = await sidebar
    .locator('.graph-nodes [role="option"]')
    .boundingBox()
  const center = { x: dot.x + dot.width / 2, y: dot.y + dot.height / 2 }
  await page.mouse.move(center.x + 1, center.y)
  await page.mouse.move(center.x, center.y)
  await page.waitForFunction(() =>
    document
      .querySelector('.addon-sidebar .graph-view [data-tooltip]')
      ?.matches(':hover'),
  )
  const hint = sidebar.locator('.graph-view [data-tooltip]')
  assert.equal(
    await hint.getAttribute('data-tooltip'),
    'hub.md · 100 connections',
  )
  // The label sits 14 units above the dot's center; the hint covers it too.
  const box = await hint.boundingBox()
  assert.ok(box.y <= center.y - 20 * scale, JSON.stringify({ box, center }))
  assert.ok(box.y + box.height >= dot.y + dot.height - 1)
  await page.mouse.move(5, 790)
  // Rows far below the view stay in tab order.
  const connections = sidebar.getByRole('region', { name: 'Connections' })
  await connections
    .getByRole('button', { name: 'n001.md', exact: true })
    .focus()
  await page.evaluate(() => {
    const scroller = document
      .querySelector('.addon-sidebar .graph-connections')
      .closest('.addon-view-content')
    scroller.scrollTop = scroller.scrollHeight
  })
  await page.waitForFunction(
    () =>
      !document
        .querySelector('.addon-sidebar .graph-connection-rows > :nth-child(3)')
        ?.textContent.startsWith('n003'),
  )
  await connections
    .getByRole('button', { name: 'n100.md', exact: true })
    .waitFor()
  const focused = () => page.evaluate(() => document.activeElement?.textContent)
  await page.keyboard.press('Tab')
  assert.equal(await focused(), 'n002.md')
  await page.keyboard.press('Shift+Tab')
  assert.equal(await focused(), 'n001.md')
  assert.deepEqual(errors, [])
})
