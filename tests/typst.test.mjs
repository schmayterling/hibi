import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'
import { renameDocument } from './rename.mjs'
import { uiName } from './ui.mjs'

test('typst documents and markdown blocks preview locally, export, and preserve source', {
  timeout: 60000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-typst-test-'))
  const notes = join(root, 'notes')
  await mkdir(notes)
  await writeFile(join(notes, 'values.typ'), '#let answer = 42')
  const original =
    '#import "values.typ": answer\n= report\n\nanswer: #answer\n\n$ integral_0^1 x dif x = 1/2 $\n'
  await writeFile(join(notes, 'report.typ'), original)
  const markdown =
    '# markdown\n\n```typst\n$ sum_(k=1)^n k = (n(n+1))/2 $\n```\n\nkeep this paragraph.\n'
  await writeFile(join(notes, 'blocks.md'), markdown)
  await writeFile(join(root, 'private.txt'), 'outside-project-secret')
  await symlink(join(root, 'private.txt'), join(notes, 'escape.txt'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  const read = () => page.evaluate(() => window.hibi.getDocument())
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^addons$/i, exact: true }).click()
  await page.locator('#addon-typst').click()
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await app.evaluate(({ dialog }, notes) => {
    dialog.showOpenDialog = async (_window, options) => ({
      canceled: false,
      filePaths: [
        options.properties.includes('openDirectory')
          ? notes
          : `${notes}/report.typ`,
      ],
    })
    dialog.showMessageBox = async () => ({ response: 1 })
  }, notes)
  await pressShortcut(app, `${mod}+Shift+o`)
  const tree = page.getByRole('tree', { name: /workspace files/i })
  await tree
    .getByRole('treeitem', { name: /^report\.typ$/i, exact: true })
    .click()
  const preview = page.getByAltText(/typst document preview/)
  await preview.waitFor()
  assert.equal((await read()).markdown, original)
  await pressShortcut(app, `${mod}+Shift+\\`)
  const source = page.getByRole('textbox', { name: /typst editor/i })
  await source.waitFor()
  await page.locator('.source-pane .hibi-token-keyword').first().waitFor()
  const updated = `${original}\nsecond paragraph.\n`
  await source.fill(updated)
  await waitForAsync(
    page,
    async (updated) => (await window.hibi.getDocument()).markdown === updated,
    updated,
  )
  await page.waitForFunction(
    () =>
      document.querySelector('.typst-preview')?.getAttribute('aria-busy') ===
      'false',
  )
  assert.equal(await page.locator('.typst-diagnostics').count(), 0)
  await pressShortcut(app, `${mod}+s`)
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  assert.equal(await readFile(join(notes, 'report.typ'), 'utf8'), updated)
  async function choose(name) {
    await pressShortcut(app, `${mod}+k`)
    const palette = page.getByRole('dialog', { name: /command palette/i })
    await palette.getByRole('combobox').fill(name)
    await palette
      .getByRole('option')
      .filter({ has: page.getByText(uiName(name, true), { exact: true }) })
      .first()
      .click()
  }
  const pdf = join(root, 'report.pdf')
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
  }, pdf)
  await choose('export typst pdf')
  await page.getByText(/exported pdf to/i).waitFor()
  assert.equal((await readFile(pdf)).subarray(0, 5).toString(), '%PDF-')
  await choose('insert typst block')
  const formatDialog = page.getByRole('dialog', {
    name: /^open a markdown document$/i,
    exact: true,
  })
  await formatDialog.waitFor()
  await formatDialog.getByRole('button', { name: /^ok$/i, exact: true }).click()
  assert.equal((await read()).markdown, updated)
  await renameDocument(app, page, 'renamed')
  await tree
    .getByRole('treeitem', { name: /^renamed\.typ$/i, exact: true })
    .waitFor()
  assert.equal(await readFile(join(notes, 'renamed.typ'), 'utf8'), updated)
  await renameDocument(app, page, 'report')
  await tree
    .getByRole('treeitem', { name: /^report\.typ$/i, exact: true })
    .waitFor()
  const query = (source) =>
    page.evaluate(
      (source) => window.hibi.queryAddon('typst', 'compile', { source }),
      source,
    )
  for (const code of [
    '#read("../private.txt")',
    '#read("escape.txt")',
    '#read("/etc/passwd")',
  ]) {
    const result = await query(code)
    assert.equal(result.svg, undefined)
    assert.ok(result.diagnostics.some((error) => error.severity === 'error'))
  }
  const network = await query(
    '#import "@preview/hibi-nonexistent-package:0.0.0": *',
  )
  assert.equal(network.svg, undefined)
  assert.match(network.diagnostics[0].message, /download package/)
  // Document-controlled loops cannot hold the application or survive the timeout.
  const loop = query('#let i = 0\n#while i >= 0 { i += 1 }').then(
    (result) =>
      result.diagnostics.map((error) => error.message).join('\n') ||
      'unexpected success',
    (error) => error.message,
  )
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^appearance$/i, exact: true }).click()
  assert.match(await loop, /timed out|infinite/)
  await page.getByRole('button', { name: /^back to app$/i }).click()
  assert.ok((await query('recovered')).svg)
  // Exercise timeout/restart deterministically without allocating an enormous Typst document.
  await page.evaluate(() => window.hibi.setAddonEnabled('typst', false))
  await app.evaluate(({ utilityProcess }) => {
    globalThis.typstOriginalFork = utilityProcess.fork
    globalThis.typstOriginalTimer = setTimeout
    const { EventEmitter } = process.getBuiltinModule('events')
    utilityProcess.fork = () => {
      const worker = new EventEmitter()
      worker.postMessage = () => {}
      worker.kill = () => {
        worker.emit('exit', 0)
        return true
      }
      return worker
    }
    globalThis.setTimeout = (callback, delay, ...args) =>
      globalThis.typstOriginalTimer(
        callback,
        delay === 10000 ? 20 : delay,
        ...args,
      )
  })
  try {
    await page.evaluate(() => window.hibi.setAddonEnabled('typst', true))
    await assert.rejects(query('timeout fixture'), /timed out/)
  } finally {
    await app.evaluate(({ utilityProcess }) => {
      utilityProcess.fork = globalThis.typstOriginalFork
      globalThis.setTimeout = globalThis.typstOriginalTimer
    })
  }
  assert.ok((await query('restarted')).svg)
  // Empty/incomplete syntax reports diagnostics without modifying the buffer.
  await source.fill('#let =')
  await page.locator('.typst-diagnostics').waitFor()
  assert.equal((await read()).markdown, '#let =')
  await source.fill(updated)
  await tree
    .getByRole('treeitem', { name: /^blocks\.md$/i, exact: true })
    .click()
  await page.getByAltText('typst block preview', { exact: true }).waitFor()
  assert.equal(await page.locator('.tiptap h1').innerText(), 'markdown')
  assert.match(
    await page.locator('.tiptap').innerText(),
    /keep this paragraph\./,
  )
  assert.equal((await read()).markdown, markdown)
  await page
    .getByRole('button', { name: /^edit typst block$/i, exact: true })
    .click()
  const dialog = page.getByRole('dialog', {
    name: /^edit typst block$/i,
    exact: true,
  })
  await dialog.getByLabel(/^typst source$/i, { exact: true }).fill('$ x^3 $')
  await dialog.getByRole('button', { name: /^apply$/i, exact: true }).click()
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('$ x^3 $'),
  )
  assert.match((await read()).markdown, /```typst\n\$ x\^3 \$\n```/)
  await page.getByAltText('typst block preview', { exact: true }).waitFor()
  const output = join(root, 'doc.html')
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
  }, output)
  await choose('export documentation')
  await page.getByText(/exported 3 pages/i).waitFor()
  const html = await readFile(output, 'utf8')
  assert.match(html, /data:image\/svg\+xml;base64,/)
  const nextWindow = app.waitForEvent('window')
  await app.evaluate(({ BrowserWindow }, path) => {
    const window = new BrowserWindow({
      show: false,
      focusable: false,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    })
    void window.loadFile(path)
  }, output)
  const site = await nextWindow
  await site.getByAltText('typst block preview', { exact: true }).waitFor()
  await site.getByRole('treeitem', { name: /^report$/i, exact: true }).click()
  await site.getByAltText('typst document preview', { exact: true }).waitFor()
  assert.equal(
    await site
      .locator('img')
      .first()
      .evaluate((image) => image.complete && image.naturalWidth > 0),
    true,
  )
  await site.close()
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^addons$/i, exact: true }).click()
  await page.locator('#addon-typst').click()
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await page.locator('.tiptap pre').waitFor()
  assert.equal(
    await page.locator('.tiptap').getAttribute('contenteditable'),
    'true',
  )
  assert.match((await read()).markdown, /\$ x\^3 \$/)
  await tree
    .getByRole('treeitem', { name: /^report\.typ$/i, exact: true })
    .click()
  await page.locator('.format-unavailable').waitFor()
  await source.waitFor()
  assert.equal(await source.getAttribute('contenteditable'), 'true')
  assert.deepEqual(errors, [])
})
