import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { build } from 'vite'
import { electron } from './electron.mjs'

test('palette selection reuses filtered results and rerenders only the rows it changes', {
  timeout: 45000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-palette-results-'))
  let app
  t.after(async () => {
    try {
      await app?.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  await build({
    configFile: false,
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
    esbuild: { jsx: 'automatic' },
    build: {
      outDir: root,
      emptyOutDir: false,
      lib: {
        entry: resolve('tests/fixtures/palette.tsx'),
        name: 'PaletteHarness',
        formats: ['iife'],
        fileName: () => 'harness.js',
        cssFileName: 'harness',
      },
    },
  })
  await writeFile(
    join(root, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="harness.css"></head><body><script src="harness.js"></script></body></html>',
  )
  await writeFile(
    join(root, 'main.cjs'),
    `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(root, 'profile'))});if(process.platform==='darwin')app.setActivationPolicy('accessory');app.whenReady().then(()=>{const w=new BrowserWindow({width:800,height:640,show:false,focusable:false,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});w.loadFile(${JSON.stringify(join(root, 'index.html'))});});`,
  )
  app = await electron.launch({ args: [join(root, 'main.cjs')] })
  const page = await app.firstWindow()
  page.setDefaultTimeout(6000)
  await page.waitForFunction(() => window.paletteHarness)
  const counts = () =>
    page.evaluate(() => ({ ...window.paletteHarness.counts }))
  const search = page.getByRole('combobox', { name: /search commands/i })
  const option = (number) =>
    page.getByRole('option', { name: new RegExp(`^Command ${number}(?!\\d)`) })
  const selected = (number) =>
    page
      .getByRole('option', {
        name: new RegExp(`^Command ${number}(?!\\d)`),
        selected: true,
      })
      .waitFor()

  await search.fill('command 1')
  await selected(1)
  assert.equal(await page.getByRole('option').count(), 1271)
  const filtered = await counts()
  for (let index = 1; index <= 10; index++) await search.press('ArrowDown')
  await selected(19)
  await option(13).hover()
  await selected(13)
  await search.press('ArrowUp')
  await selected(12)
  const moved = await counts()
  // Twelve moves rerender the row each one leaves and enters, not all 1,271.
  assert.equal(moved.filtered, filtered.filtered)
  assert.ok(
    moved.rendered - filtered.rendered <= 24,
    `rendered ${moved.rendered - filtered.rendered} rows`,
  )
  // Scrolling can move a different row under a stationary pointer. Chromium
  // sends boundary events, but those must not replace keyboard selection.
  const beforeBoundary = await counts()
  await option(14).dispatchEvent('mouseover')
  await page.evaluate(() => new Promise(requestAnimationFrame))
  await selected(12)
  assert.deepEqual(await counts(), beforeBoundary)
  await option(14).hover()
  await selected(14)
  assert.equal((await counts()).filtered, beforeBoundary.filtered)
  assert.equal((await counts()).rendered - beforeBoundary.rendered, 2)

  await search.fill('command 2')
  await selected(2)
  assert.equal(await page.getByRole('option').count(), 542)
  assert.ok((await counts()).filtered > moved.filtered)

  for (const query of ['ΟΔΟΣ', 'οδος', 'οδοσ', 'Σ', 'σ', 'ς', 'ΑςΑ']) {
    await search.fill(query)
    await page.locator('#command-greek-0').waitFor()
    assert.deepEqual(
      await page
        .getByRole('option')
        .evaluateAll((rows) => rows.map((row) => row.id)),
      ['command-greek-0', 'command-greek-1', 'command-greek-2'],
      query,
    )
  }

  // A search callback runs once per query, not once per selection move.
  await page.evaluate(() => window.paletteHarness.setMode('search'))
  await search.fill('Command 5')
  await selected(5)
  const searched = (await counts()).searches
  for (let index = 1; index <= 5; index++) await search.press('ArrowDown')
  await selected(54)
  assert.equal((await counts()).searches, searched)
})
