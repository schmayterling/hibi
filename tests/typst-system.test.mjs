import assert from 'node:assert/strict'
import {
  copyFile,
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

test('selected system Typst compiles newer syntax, local imports, multiple pages, and PDF', {
  skip: !process.env.TYPST_TEST_BIN,
  timeout: 60000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-typst-system-'))
  const profile = join(root, 'profile')
  const workspace = join(root, 'workspace')
  await mkdir(profile)
  await mkdir(workspace)
  await writeFile(join(profile, 'addons.json'), JSON.stringify({ typst: true }))
  await writeFile(join(workspace, 'values.typ'), '#let answer = 42')
  if (process.env.TYPST_TEST_FONT)
    await copyFile(process.env.TYPST_TEST_FONT, join(workspace, 'Fraunces.ttf'))
  await writeFile(join(root, 'private.txt'), 'outside-project-secret')
  await symlink(join(root, 'private.txt'), join(workspace, 'escape.txt'))
  const source = `#import "values.typ": answer\n#set text(${process.env.TYPST_TEST_FONT ? 'font: "Fraunces", ' : ''}variations: (wght: 500))\n= first\n#answer\n#pagebreak()\n= second\n`
  await writeFile(join(workspace, 'report.typ'), source)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Dependencies', exact: true }).click()
  const panel = page.getByRole('tabpanel', {
    name: 'Dependencies',
    exact: true,
  })
  await panel
    .getByRole('searchbox', { name: 'Filter dependencies' })
    .fill('typst')
  const tool = panel.getByRole('region', { name: 'Typst', exact: true })
  await tool.locator('summary').click()
  const path = tool.getByRole('textbox', {
    name: 'Typst executable path',
    exact: true,
  })
  await path.fill(process.env.TYPST_TEST_BIN)
  await path.press('Enter')
  await tool.getByText('Available', { exact: true }).waitFor()
  const search = page.getByRole('textbox', {
    name: 'Search settings',
    exact: true,
  })
  await search.fill('use system typst')
  await page
    .getByRole('treeitem', { name: 'Use system Typst', exact: true })
    .click()
  await page.getByRole('checkbox', { name: 'Use system Typst' }).check()
  await page.getByRole('button', { name: 'Back to app' }).click()
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async (_window, options) => ({
      canceled: false,
      filePaths: [
        options.properties.includes('openDirectory')
          ? directory
          : `${directory}/report.typ`,
      ],
    })
  }, workspace)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await pressShortcut(app, `${mod}+Shift+o`)
  await page.getByRole('treeitem', { name: 'report.typ', exact: true }).click()
  await page.waitForFunction(
    () =>
      document.querySelector('.typst-preview')?.getAttribute('aria-busy') ===
      'false',
    undefined,
    { timeout: 20000 },
  )
  assert.equal(
    await page.getByAltText(/Typst document preview, page/).count(),
    2,
    await page.locator('.typst-preview').innerText(),
  )
  const tracked = await page.evaluate(async () => {
    const document = await window.hibi.getDocument()
    return window.hibi.queryAddon('typst', 'compile', {
      source: document.markdown,
      documentId: document.id,
      compiler: 'system',
    })
  })
  assert.deepEqual(tracked.dependencies, ['values.typ'])
  if (process.env.TYPST_TEST_FONT)
    assert.equal(
      tracked.diagnostics.some((item) =>
        /unknown font family/i.test(item.message),
      ),
      false,
    )
  const warning = await page.evaluate(async () => {
    const document = await window.hibi.getDocument()
    return window.hibi.queryAddon('typst', 'compile', {
      source: '#set text(font: "Hibi Missing Font")\nHello',
      documentId: document.id,
      compiler: 'system',
    })
  })
  assert.ok(warning.svg)
  assert.match(warning.diagnostics[0].message, /unknown font family/i)
  for (const unsafe of ['#read("../private.txt")', '#read("escape.txt")']) {
    const result = await page.evaluate(async (source) => {
      const document = await window.hibi.getDocument()
      return window.hibi.queryAddon('typst', 'compile', {
        source,
        documentId: document.id,
        compiler: 'system',
      })
    }, unsafe)
    assert.equal(result.svg, undefined)
    assert.equal(result.diagnostics[0].severity, 'error')
  }
  const packageResult = await page.evaluate(async () => {
    const document = await window.hibi.getDocument()
    return window.hibi.queryAddon('typst', 'compile', {
      source: '#import "@preview/cetz:0.5.2": *\nHello',
      documentId: document.id,
      compiler: 'system',
    })
  })
  assert.equal(packageResult.svg, undefined)
  assert.equal(packageResult.diagnostics[0].severity, 'error')
  assert.match(packageResult.diagnostics[0].message, /download|403|proxy/i)
  await clickMenu(app, 'Settings')
  await search.fill('')
  await page.getByRole('tab', { name: 'Dependencies', exact: true }).click()
  await panel
    .getByRole('searchbox', { name: 'Filter dependencies' })
    .fill('typst')
  if (!(await path.isVisible())) await tool.locator('summary').click()
  await tool.getByRole('button', { name: 'Use PATH' }).click()
  await page.getByRole('button', { name: 'Back to app' }).click()
  await page.getByText(/Install Typst or choose its executable/).waitFor()
  await clickMenu(app, 'Settings')
  await search.fill('')
  await page.getByRole('tab', { name: 'Dependencies', exact: true }).click()
  await panel
    .getByRole('searchbox', { name: 'Filter dependencies' })
    .fill('typst')
  if (!(await path.isVisible())) await tool.locator('summary').click()
  await path.fill(process.env.TYPST_TEST_BIN)
  await path.press('Enter')
  await tool.getByText('Available', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Back to app' }).click()
  await page
    .getByAltText(/Typst document preview, page/)
    .first()
    .waitFor()
  const pdf = join(root, 'report.pdf')
  await app.evaluate(({ dialog }, destination) => {
    dialog.showSaveDialog = async () => ({
      canceled: false,
      filePath: destination,
    })
  }, pdf)
  await pressShortcut(app, `${mod}+k`)
  await page.getByRole('combobox').fill('export typst pdf')
  await page.getByRole('option').first().click()
  await page.getByText(/exported pdf to/i).waitFor({ timeout: 20000 })
  assert.equal((await readFile(pdf)).subarray(0, 5).toString(), '%PDF-')
  assert.equal(await readFile(join(workspace, 'report.typ'), 'utf8'), source)
})
