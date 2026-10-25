import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
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
  // A redraw of 2,000 notes is one edge path and two dot paths.
  assert.ok(
    Math.max(...(await page.evaluate(() => window.graphDraws.frames))) <= 5,
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
    Math.max(...(await page.evaluate(() => window.graphDraws.frames))) <= 5,
  )
  assert.deepEqual(errors, [])
})
