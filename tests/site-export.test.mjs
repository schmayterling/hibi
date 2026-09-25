import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  exportOptions,
  validateExportOptions,
} from '../src/addons/documentation/options.ts'
import { prepareSite, siteFiles } from '../src/addons/documentation/site.ts'
import { electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

const pixel =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZkAAAAASUVORK5CYII='
const snapshot = {
  name: 'Notes',
  pages: [
    {
      path: 'README.md',
      markdown:
        '# Home\n\nWelcome to the garden.\n\n[Development page](development/README.md)',
    },
    {
      path: 'development/README.md',
      markdown:
        '---\ntitle: Development guide\ndescription: Build something useful.\n---\n# Development\n\nA private-sentinel-9742 paragraph.\n\n## Getting started\n\n[Back home](../README.md)',
    },
  ],
}

test('export options validate URLs, images and portable paths; protected files contain ciphertext only', async () => {
  assert.equal(exportOptions().singleFile, true)
  for (const value of [
    { url: 'javascript:alert(1)' },
    { socialImage: 'https://user:secret@example.com/a.png' },
    { logo: '<svg onload="alert(1)" />' },
    { language: '"><script>' },
  ])
    assert.throws(() => validateExportOptions(value))
  for (const path of [
    '../escape.md',
    '/root.md',
    'a\\b.md',
    'a/.. /escape.md',
    'CON.md',
  ])
    assert.throws(() =>
      prepareSite(
        { name: 'bad', pages: [{ path, markdown: 'bad' }] },
        exportOptions({ singleFile: false }),
      ),
    )
  const template = await readFile('out/site/template.html', 'utf8')
  const options = exportOptions({
    title: 'Custom site',
    url: 'https://example.com/docs/',
    socialImage: 'https://example.com/card.png',
  })
  const data = prepareSite(snapshot, options)
  await assert.rejects(
    siteFiles(
      template,
      prepareSite(snapshot, { ...options, passwordProtected: true }),
    ),
    /password/,
  )
  assert.equal(data.pages[0].description, 'Welcome to the garden.')
  assert.equal(data.pages[1].title, 'Development guide')
  const single = await siteFiles(template, data)
  assert.equal(single.size, 1)
  assert.match(single.get('index.html'), /<title>Home · Custom site<\/title>/)
  assert.match(
    single.get('index.html'),
    /<meta name="description" content="Welcome to the garden\."/,
  )
  const folder = await siteFiles(
    template,
    prepareSite(snapshot, { ...options, singleFile: false }),
  )
  assert.ok(folder.has('development/README.md/index.html'))
  assert.match(
    folder.get('development/README.md/index.html'),
    /rel="canonical" href="https:\/\/example.com\/docs\/development\/README.md\/"/,
  )
  assert.match(
    folder.get('sitemap.xml'),
    /https:\/\/example.com\/docs\/development\/README.md\//,
  )
  assert.match(folder.get('robots.txt'), /Sitemap:/)
  for (const singleFile of [true, false]) {
    const encrypted = await siteFiles(
      template,
      prepareSite(snapshot, { ...options, singleFile }),
      'unit-export-password-482',
    )
    const all = [...encrypted.values()].join('\n')
    for (const value of [
      'private-sentinel-9742',
      'development/README.md',
      'Build something useful.',
      'unit-export-password-482',
    ])
      assert.ok(!all.includes(value), value)
    assert.match(encrypted.get('index.html'), /content="noindex, nofollow"/)
    assert.ok(!encrypted.has('sitemap.xml'))
    assert.ok(!encrypted.has('development/README.md/index.html'))
  }
})

test('published sites support direct routes, crawlable HTML, branding, locked themes, graph and encrypted unlock', {
  timeout: 60000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-site-'))
  const template = await readFile('out/site/template.html', 'utf8')
  const options = exportOptions({
    singleFile: false,
    title: 'My garden',
    favicon: pixel,
    logo: pixel,
    graph: true,
    lockTheme: true,
    theme: { mode: 'light', light: 'hibi-light', dark: 'hibi-dark' },
    url: 'https://example.com/docs/',
    css: '.site-content article h1 { color: rgb(12, 34, 56); }',
  })
  const hostile = {
    ...snapshot,
    pages: snapshot.pages.map((page) => ({ ...page, html: undefined })),
  }
  hostile.pages[0].markdown +=
    '\n<script>window.exportAttack = true</script>\n<img src="x" onerror="window.exportAttack=true">'
  const files = await siteFiles(template, prepareSite(hostile, options))
  const server = createServer((request, response) => {
    let path = decodeURIComponent(
      new URL(request.url, 'http://localhost').pathname,
    )
    if (!path.startsWith('/docs/')) {
      response.writeHead(404).end()
      return
    }
    path = path.slice(6)
    if (!path || path.endsWith('/')) path += 'index.html'
    if (!files.has(path) && files.has(`${path}/index.html`)) {
      response.writeHead(302, { Location: `${request.url}/` }).end()
      return
    }
    if (!files.has(path)) {
      response.writeHead(404).end()
      return
    }
    response.setHeader(
      'Content-Type',
      path.endsWith('.js')
        ? 'application/javascript'
        : path.endsWith('.css')
          ? 'text/css'
          : 'text/html',
    )
    response.end(files.get(path))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/docs/`
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await new Promise((resolve) => server.close(resolve))
    await rm(folder, { recursive: true, force: true })
  })
  await app.firstWindow()
  const view = async (url, javascript = true) => {
    const next = app.waitForEvent('window')
    await app.evaluate(
      ({ BrowserWindow }, { url, javascript }) => {
        const viewer = new BrowserWindow({
          show: false,
          width: 1000,
          height: 780,
          webPreferences: {
            javascript,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false,
          },
        })
        void viewer.loadURL(url)
      },
      { url, javascript },
    )
    const page = await next
    page.setDefaultTimeout(7000)
    return page
  }
  const noJs = await view(`${base}development/README.md/`, false)
  assert.equal(await noJs.title(), 'Development guide · My garden')
  assert.match(
    await noJs.locator('article').innerText(),
    /private-sentinel-9742/,
  )
  const page = await view(base)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.getByRole('button', { name: /^toggle navigation$/i }).waitFor()
  assert.equal(
    await page.getByRole('button', { name: /^color scheme$/i }).count(),
    0,
  )
  assert.equal(await page.locator('.site-logo').getAttribute('src'), pixel)
  assert.equal(
    await page.locator('link[rel="icon"]').getAttribute('href'),
    pixel,
  )
  assert.equal(
    await page.locator('html').getAttribute('data-appearance'),
    'light',
  )
  assert.equal(
    await page
      .locator('article h1')
      .evaluate((node) => getComputedStyle(node).color),
    'rgb(12, 34, 56)',
  )
  assert.equal(await page.evaluate(() => window.exportAttack), undefined)
  await page
    .getByRole('link', { name: 'Development page', exact: true })
    .click()
  assert.equal(page.url(), `${base}development/README.md/`)
  await page.waitForFunction(
    () => document.title === 'Development guide · My garden',
  )
  assert.equal(
    await page.locator('meta[name="description"]').getAttribute('content'),
    'Build something useful.',
  )
  await page.reload()
  await page.getByRole('button', { name: /^open graph$/i }).click()
  const graph = page.getByRole('dialog', { name: /^graph$/i })
  await graph
    .getByRole('button', { name: 'Open README.md', exact: true })
    .focus()
  await page.keyboard.press('Enter')
  await graph.waitFor({ state: 'hidden' })
  assert.equal(page.url(), base)
  await page.goBack()
  assert.equal(page.url(), `${base}development/README.md/`)
  await page.goto(`${base}development/README.md`)
  assert.equal(page.url(), `${base}development/README.md/`)
  await page.goto(`${base}#page=development%2FREADME.md`)
  await page.waitForURL(`${base}development/README.md/`)
  await page.goto(`${base}development/README.md/#%`)
  await page.getByRole('button', { name: /^toggle navigation$/i }).waitFor()
  files.set(
    'hibi-assets/custom.css',
    files.get('hibi-assets/custom.css') +
      '\n.site-content article h1 { color: rgb(65, 43, 21); }',
  )
  await page.reload()
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('article h1')).color ===
      'rgb(65, 43, 21)',
  )
  await mkdir('test-results', { recursive: true })
  await page.screenshot({ path: 'test-results/export-custom-site.png' })
  const lockedFile = join(folder, 'protected.html')
  const protectedFiles = await siteFiles(
    template,
    prepareSite(snapshot, { ...options, singleFile: true }),
    'unit-export-password-482',
  )
  await writeFile(lockedFile, protectedFiles.get('index.html'))
  const locked = await view(new URL(`file://${lockedFile}`).href)
  await locked.getByLabel('Password', { exact: true }).fill('wrong-password')
  await locked.getByRole('button', { name: /^unlock$/i }).click()
  await locked
    .getByRole('alert')
    .filter({ hasText: /incorrect password/i })
    .waitFor()
  assert.equal(await locked.locator('article').count(), 0)
  await locked
    .getByLabel('Password', { exact: true })
    .fill('unit-export-password-482')
  await locked.getByRole('button', { name: /^unlock$/i }).click()
  await locked
    .getByRole('link', { name: 'Development page', exact: true })
    .click()
  assert.match(
    await locked.locator('article').innerText(),
    /private-sentinel-9742/,
  )
  assert.equal(
    await locked.evaluate(() =>
      JSON.stringify(localStorage).includes('unit-export-password-482'),
    ),
    false,
  )
  assert.equal(
    await locked.locator('meta[name="robots"]').getAttribute('content'),
    'noindex, nofollow',
  )
  assert.deepEqual(errors, [])
})

test('command-palette export opens options and writes a configured static folder without overwriting existing files', {
  timeout: 45000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-export-options-'))
  const workspace = join(folder, 'notes'),
    output = join(folder, 'output'),
    profile = join(folder, 'profile')
  await mkdir(workspace)
  await mkdir(output)
  await writeFile(join(workspace, 'README.md'), '# Garden\n\n[More](more.md)')
  await writeFile(join(workspace, 'more.md'), '# More\n\nMore notes.')
  await mkdir(join(output, 'notes-site'))
  await writeFile(join(output, 'notes-site', 'keep.txt'), 'keep me')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(8000)
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await app.evaluate(({ dialog }, workspace) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [workspace],
    })
  }, workspace)
  await page.evaluate(() => window.hibi.openWorkspace())
  await page.waitForFunction(() =>
    document
      .querySelector('.workspace-sidebar')
      ?.textContent.includes('README.md'),
  )
  const workspaceId = await page.evaluate(
    async () => (await window.hibi.getWorkspace()).id,
  )
  const legacy = JSON.stringify(
    exportOptions({ title: 'Legacy garden' }, 'notes'),
  )
  await page.evaluate(
    ({ id, value }) => localStorage.setItem(`hibi:export:${id}`, value),
    { id: workspaceId, value: legacy },
  )
  await clickMenu(app, 'Command palette')
  await page
    .getByRole('combobox', { name: /search commands/i })
    .fill('export workspace to html')
  // Background addons can register commands after the editor becomes ready.
  await page
    .getByRole('option', {
      name: /^export workspace to html addons$/i,
      selected: true,
    })
    .waitFor()
  await page.getByRole('combobox', { name: /search commands/i }).press('Enter')
  const modal = page.getByRole('dialog', { name: /^export workspace$/i })
  await modal.waitFor()
  const footer = modal.locator('.dialog-footer')
  await footer.getByRole('button', { name: /^export$/i }).waitFor()
  assert.equal(
    await modal.getByLabel('Site title', { exact: true }).inputValue(),
    'Legacy garden',
  )
  const storedOptions = join(
    profile,
    'addon-storage',
    'workspace',
    workspaceId,
    'documentation.json',
  )
  assert.equal(
    JSON.parse(await readFile(storedOptions, 'utf8')).entries['export-options']
      .value.title,
    'Legacy garden',
  )
  assert.equal(
    await page.evaluate(
      (id) => localStorage.getItem(`hibi:export:${id}`),
      workspaceId,
    ),
    legacy,
  )
  await modal.evaluate((dialog) =>
    Promise.all(dialog.getAnimations().map((animation) => animation.finished)),
  )
  assert.equal(await modal.locator('.dialog-content .dialog-footer').count(), 0)
  const footerBefore = await footer.boundingBox()
  await modal.locator('.dialog-content').evaluate((content) => {
    content.scrollTop = content.scrollHeight
  })
  const footerAfter = await footer.boundingBox()
  const modalBox = await modal.boundingBox()
  assert.equal(footerAfter.y, footerBefore.y)
  assert.ok(
    Math.abs(
      footerAfter.y + footerAfter.height - modalBox.y - modalBox.height,
    ) <= 2,
  )
  assert.equal(
    await modal
      .getByRole('checkbox', { name: /single html file/i })
      .isChecked(),
    true,
  )
  assert.equal(
    await modal.getByRole('checkbox', { name: /include graph/i }).count(),
    0,
  )
  await modal
    .getByLabel('Site title', { exact: true })
    .fill('My published garden')
  await modal.getByRole('checkbox', { name: /single html file/i }).uncheck()
  await modal.getByRole('checkbox', { name: /lock theme/i }).check()
  await app.evaluate(({ dialog }, output) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [output],
    })
  }, output)
  await page.screenshot({ path: 'test-results/export-options-modal.png' })
  await modal.getByRole('button', { name: /^export$/i, exact: true }).click()
  await modal.waitFor({ state: 'hidden' })
  assert.equal(
    JSON.parse(await readFile(storedOptions, 'utf8')).entries['export-options']
      .value.title,
    'My published garden',
  )
  assert.equal(
    await readFile(join(output, 'notes-site', 'keep.txt'), 'utf8'),
    'keep me',
  )
  assert.match(
    await readFile(join(output, 'notes-site-2', 'index.html'), 'utf8'),
    /My published garden/,
  )
  assert.match(
    await readFile(
      join(output, 'notes-site-2', 'more.md', 'index.html'),
      'utf8',
    ),
    /<title>More · My published garden<\/title>/,
  )
  const reopen = async () => {
    await clickMenu(app, 'Command palette')
    const search = page.getByRole('combobox', { name: /search commands/i })
    await search.fill('export workspace to html')
    await search.press('Enter')
    await modal.waitFor()
  }
  await reopen()
  assert.equal(
    await modal
      .getByRole('checkbox', { name: /single html file/i })
      .isChecked(),
    false,
  )
  await modal.getByRole('checkbox', { name: /single html file/i }).check()
  await modal
    .locator('summary')
    .filter({ hasText: 'Password protection' })
    .click()
  await modal.getByRole('checkbox', { name: /require a password/i }).check()
  await modal
    .getByLabel('Password', { exact: true })
    .fill('remember-lock-not-password-845')
  const protectedPath = join(output, 'private.html')
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath })
  }, protectedPath)
  await modal.getByRole('button', { name: /^export$/i, exact: true }).click()
  await modal.waitFor({ state: 'hidden' })
  assert.ok(
    !(await readFile(protectedPath, 'utf8')).includes('My published garden'),
  )
  assert.equal(
    await page.evaluate(() =>
      JSON.stringify(localStorage).includes('remember-lock-not-password-845'),
    ),
    false,
  )
  await reopen()
  assert.equal(
    await modal
      .getByRole('checkbox', { name: /require a password/i })
      .isChecked(),
    true,
  )
  assert.equal(
    await modal.getByLabel('Password', { exact: true }).inputValue(),
    '',
  )
  await page.keyboard.press('Escape')
})
