import assert from 'node:assert/strict'
import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import katex from 'katex'
import { marked } from 'marked'
import {
  exportOptions,
  validateExportOptions,
} from '../src/addons/documentation/options.ts'
import { prepareSite, siteFiles } from '../src/addons/documentation/site.ts'
import { electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

const pixel =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZkAAAAASUVORK5CYII='
const mermaidImage = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>')}`
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
    const payload = singleFile
      ? encrypted
          .get('index.html')
          .match(
            /<script id="workspace-data" type="application\/json">([\s\S]*?)<\/script>/,
          )[1]
      : encrypted
          .get('hibi-assets/workspace.js')
          .slice('window.__HIBI_WORKSPACE__='.length, -1)
    const locked = JSON.parse(payload)
    const cipher = Buffer.from(locked.ciphertext, 'base64')
    const key = pbkdf2Sync(
      'unit-export-password-482',
      Buffer.from(locked.salt, 'base64'),
      locked.iterations,
      32,
      'sha256',
    )
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(locked.iv, 'base64'),
    )
    decipher.setAuthTag(cipher.subarray(-16))
    const plaintext = Buffer.concat([
      decipher.update(cipher.subarray(0, -16)),
      decipher.final(),
    ]).toString('utf8')
    const expected = prepareSite(snapshot, { ...options, singleFile })
    assert.equal(
      plaintext,
      JSON.stringify({
        ...expected,
        routing: 'hash',
        options: { ...expected.options, passwordProtected: true },
      }),
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

test('static export visits page paths a linear number of times', async () => {
  const count = 200
  const site = prepareSite(
    {
      name: 'paths',
      pages: Array.from({ length: count }, (_, index) => ({
        path: index + '.md',
        markdown: '# Note',
      })),
    },
    exportOptions({ singleFile: false, graph: false }),
  )
  let reads = 0
  for (const page of site.pages) {
    const path = page.path
    Object.defineProperty(page, 'path', {
      enumerable: true,
      get() {
        reads++
        return path
      },
    })
  }
  const files = await siteFiles(
    '<html lang="en"><head><title>site</title></head><body><div id="root"></div><script id="workspace-data" type="application/json">__HIBI_WORKSPACE_DATA__</script></body></html>',
    site,
  )
  assert.ok(files.has('199.md/index.html'))
  assert.ok(reads < 40 * count, reads + ' path reads for ' + count + ' pages')
})

test('site export keeps supported static content and omits addon runtime state', async () => {
  const template = await readFile('out/site/template.html', 'utf8')
  const math = katex.renderToString('x^2')
  const installedAddonCode =
    "export default { activate() { throw new Error('installed-addon-code-sentinel') } }"
  const attachment = 'data:image/png;base64,aGVsbG8='
  const unusedAttachment = 'data:image/png;base64,cHJpdmF0ZQ=='
  const snapshot = {
    name: 'Public notes',
    pages: [
      {
        id: 'private-document-id',
        path: 'README.md',
        markdown: '# Public\n\n![preview](images/preview.png)',
        html: `<h1>Public</h1><p><strong>Supported flavor</strong>${math}<img src="images/preview.png" onerror="window.exportAttack=true"></p><script>window.exportAttack=true</script>`,
        images: {
          'images/preview.png': attachment,
          'unused.png': unusedAttachment,
        },
        addonContext: {
          host: { credentials: 'credential-value-sentinel' },
          workspace: { grant: 'workspace-grant-sentinel' },
          code: installedAddonCode,
        },
      },
      {
        path: 'fallback.md',
        markdown: '## Plain fallback **works**\n\n:::unsupported',
      },
    ],
    addonRuntime: { bridge: 'privileged-bridge-sentinel' },
  }
  for (const singleFile of [true, false]) {
    const options = {
      ...exportOptions({ singleFile, graph: false }),
      credential: 'option-secret-sentinel',
    }
    const site = prepareSite(snapshot, options)
    assert.match(site.pages[1].html, /<strong>works<\/strong>/)
    assert.match(site.pages[1].html, /:::unsupported/)
    const files = await siteFiles(template, site)
    const output = [...files.values()].join('\n')
    for (const secret of [
      'private-document-id',
      'credential-value-sentinel',
      'workspace-grant-sentinel',
      'privileged-bridge-sentinel',
      'option-secret-sentinel',
      'installed-addon-code-sentinel',
      unusedAttachment,
      'window.hibi',
      'ipcRenderer',
      'window.exportAttack',
    ])
      assert.ok(!output.includes(secret), secret)
    assert.ok(output.includes(attachment))
    const article = (
      singleFile ? files.get('index.html') : files.get('README.md/index.html')
    ).match(/<article class="tiptap">([\s\S]*?)<\/article>/)?.[1]
    assert.match(article, /<strong>Supported flavor<\/strong>/)
    assert.match(article, /class="katex"/)
    assert.doesNotMatch(article, /<script|onerror|window\.exportAttack/i)
  }
})

test('static heading anchors preserve canonical fragments and unique legacy aliases', async () => {
  const template = await readFile('out/site/template.html', 'utf8')
  const texts = ['api_v2', 'title', 'title', 'title-1', '✨ features', 'apiv2']
  for (const singleFile of [true, false]) {
    const site = prepareSite(
      {
        name: 'heading destinations',
        pages: [
          {
            path: 'README.md',
            markdown: texts.map((text) => `## ${text}`).join('\n\n'),
          },
        ],
      },
      exportOptions({ singleFile }),
    )
    const files = await siteFiles(template, site)
    for (const [path, html] of files) {
      if (!path.endsWith('.html')) continue
      const article = html.match(
        /<article class="tiptap">([\s\S]*?)<\/article>/,
      )?.[1]
      assert.ok(article, path)
      assert.deepEqual(
        [...article.matchAll(/<h2[^>]* id="([^"]*)"/g)].map(
          (match) => match[1],
        ),
        ['api_v2', 'title', 'title-1', 'title-1-1', '-features', 'apiv2-1'],
      )
      assert.match(
        article,
        /<h2 id="api_v2"><span id="apiv2" aria-hidden="true"><\/span>api_v2<\/h2>/,
      )
      assert.match(
        article,
        /<h2 id="-features"><span id="features" aria-hidden="true"><\/span>✨ features<\/h2>/,
      )
      const ids = [...article.matchAll(/\sid="([^"]*)"/g)].map(
        (match) => match[1],
      )
      assert.equal(new Set(ids).size, ids.length, path)
    }
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
  hostile.pages[0].html = `${marked.parse(hostile.pages[0].markdown)}<img class="mermaid-diagram" alt="Mermaid diagram" src="${mermaidImage}"><img class="mermaid-diagram danger" src="data:text/html,%3Cscript%3Ealert(1)%3C%2Fscript%3E">`
  const files = await siteFiles(template, prepareSite(hostile, options))
  assert.ok(files.get('README.md/index.html').includes(mermaidImage))
  assert.doesNotMatch(
    files.get('README.md/index.html'),
    /data:text\/html|window\.exportAttack/,
  )
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
  // Register first so a failed Electron launch or close cannot leak the listener.
  t.after(
    () =>
      new Promise((done) => {
        server.close(done)
        server.closeAllConnections()
      }),
  )
  const base = `http://127.0.0.1:${server.address().port}/docs/`
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
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
  await page.waitForFunction(() => {
    const image = document.querySelector('article img.mermaid-diagram')
    return image?.complete && image.naturalWidth === 8
  })
  assert.equal(
    await page
      .locator('article img.mermaid-diagram:not(.danger)')
      .getAttribute('src'),
    mermaidImage,
  )
  assert.equal(
    await page
      .locator('article img.mermaid-diagram.danger')
      .getAttribute('src'),
    null,
  )
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
  await page.getByRole('button', { name: /^search documentation$/i }).click()
  await page
    .getByRole('combobox', { name: /search commands/i })
    .fill('getting started')
  await page.getByRole('option', { name: /getting started/i }).click()
  await page.waitForFunction(() => location.hash === '#getting-started')
  await page.locator('article #doc-getting-started').waitFor()
  await page.goto(`${base}development/README.md/`)
  await page.reload()
  await page.getByRole('button', { name: /^open graph$/i }).click()
  const graph = page.getByRole('dialog', { name: /^graph$/i })
  // The graph's keyboard note starts on this page; type-ahead reaches the home page.
  await graph.getByRole('option', { name: /^open /i }).focus()
  await page.keyboard.press('r')
  await graph
    .getByRole('option', { name: 'Open README.md', exact: true })
    .waitFor()
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
  await locked.getByRole('button', { name: /^search documentation$/i }).click()
  const protectedSearch = locked.getByRole('combobox', {
    name: /search commands/i,
  })
  await protectedSearch.fill('getting started')
  await locked.getByRole('option', { name: /getting started/i }).waitFor()
  await protectedSearch.press('Enter')
  await locked.waitForFunction(
    () =>
      new URLSearchParams(location.hash.slice(1)).get('anchor') ===
      'getting-started',
  )
  await locked.locator('article #doc-getting-started').waitFor()
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
  await writeFile(
    join(workspace, 'README.md'),
    '# Garden\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n[More](more.md)',
  )
  await writeFile(join(workspace, 'more.md'), '# More\n\nMore notes.')
  await writeFile(
    join(workspace, '.private.md'),
    '# Private\n\nprivate-note-sentinel',
  )
  await mkdir(join(workspace, 'img'))
  await writeFile(
    join(workspace, 'img', 'a.png'),
    Buffer.from(pixel.split(',')[1], 'base64'),
  )
  await mkdir(profile)
  await writeFile(
    join(profile, 'workspace-settings.json'),
    JSON.stringify({
      enabled: false,
      showAllFiles: true,
      path: null,
      startup: 'empty',
      startupFolder: null,
    }),
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ mermaid: true, 'site-probe': true }),
  )
  const probe = join(profile, 'installed-addons', 'site-probe')
  await mkdir(probe, { recursive: true })
  await writeFile(
    join(probe, 'hibi-addon.json'),
    JSON.stringify({
      id: 'site-probe',
      name: 'Site probe',
      description: 'Static export integration.',
      kind: 'extension',
      apiVersion: 2,
      version: '1.0.0',
      capabilities: ['ui'],
      startup: 'background',
      defaultEnabled: true,
      requires: { addons: [{ id: 'documentation' }] },
      authors: [{ displayName: 'Test' }],
      entry: 'index.js',
    }),
  )
  await writeFile(
    join(probe, 'index.js'),
    `export default () => ({
    async start(context) {
      context.site.register({
        description: 'Adds a static export banner.',
        css: '.site-probe{font-weight:700}',
        transform: async rendered => ({
          ...rendered, html: rendered.html + '<p class="site-probe">Addon export works.</p>',
        }),
      })
      context.colorschemes.register({
        id: 'blue', name: 'Probe blue', appearance: 'light', author: 'Test',
        license: {name: 'MIT', text: 'Test theme license.'},
        colors: {background:'#eef4ff',surface:'#e0e8ff',ink:'#112244',
          muted:'#445577',accent:'#2244aa',border:'#aabbcc'},
      })
      window.siteProbe = await context.addons.ready('documentation')
    },
    stop() { delete window.siteProbe },
  })`,
  )
  await writeFile(
    join(probe, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['hibi-addon.json', 'index.js'],
      source: 'local',
    }),
  )
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
  await page.waitForFunction(() => !!window.siteProbe?.buildSite)
  assert.match(
    await page.evaluate(async () => {
      try {
        await window.siteProbe.buildSite()
        return ''
      } catch (error) {
        return error.message
      }
    }),
    /Review and save export options/,
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
  assert.deepEqual(
    (
      await modal
        .getByLabel('Home page', { exact: true })
        .locator('option')
        .allTextContents()
    ).sort(),
    ['Automatic', 'README.md', 'more.md'],
  )
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
  await modal.getByLabel(/^light theme$/i).selectOption('site-probe.blue')
  await modal.locator('summary').filter({ hasText: 'Site addons' }).click()
  assert.equal(
    await modal.getByRole('checkbox', { name: /Site probe/i }).isChecked(),
    true,
  )
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
  const exportedIndex = join(output, 'notes-site-2', 'index.html')
  const exportedHtml = await readFile(exportedIndex, 'utf8')
  assert.match(exportedHtml, /My published garden/)
  assert.match(exportedHtml, /class="site-probe"/)
  const built = await page.evaluate(() => window.siteProbe.buildSite())
  assert.equal(built.version, 1)
  assert.equal(built.pages, 2)
  assert.doesNotMatch(
    JSON.stringify(built),
    /private-note-sentinel|\.private\.md/,
  )
  const draft = await page.evaluate(() =>
    window.hibi.workspaceAction({ action: 'new-file', path: '' }),
  )
  const unsaved = '# Unsaved export draft\n\nExact unsaved text 日本語.'
  await page.evaluate((source) => window.hibi.updateDocument(source), unsaved)
  const withDraft = await page.evaluate(() => window.siteProbe.buildSite())
  assert.equal(withDraft.pages, 3)
  assert.match(
    withDraft.files.find((file) => file.path.endsWith('/workspace.js')).content,
    /Exact unsaved text 日本語/,
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    unsaved,
  )
  await assert.rejects(readFile(join(workspace, draft.path)), /ENOENT/)
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({
      response: 1,
      checkboxChecked: false,
    })
  })
  await page.evaluate(
    (id) => window.hibi.closeDocumentTab(id),
    draft.document.tabId,
  )
  const customCss = built.files.find((file) =>
    file.path.endsWith('/custom.css'),
  ).content
  assert.match(customCss, /--background:#eef4ff/)
  assert.match(customCss, /\.site-probe\{font-weight:700\}/)
  const omitted = await page.evaluate(() =>
    window.siteProbe.buildSite({
      addons: { 'site-probe': false },
    }),
  )
  assert.doesNotMatch(
    JSON.stringify(omitted),
    /Addon export works|font-weight:700/,
  )
  assert.match(
    await page.evaluate(async () => {
      try {
        await window.siteProbe.buildSite({ passwordProtected: false })
        return ''
      } catch (error) {
        return error.message
      }
    }),
    /Review and save export options/,
  )
  assert.match(
    exportedHtml.match(/<article class="tiptap">([\s\S]*?)<\/article>/)?.[1],
    /data:image\/svg\+xml,%3Csvg/,
  )
  const nextViewer = app.waitForEvent('window')
  await app.evaluate(({ BrowserWindow }, filePath) => {
    const viewer = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    })
    void viewer.loadFile(filePath)
  }, exportedIndex)
  const exportedPage = await nextViewer
  await exportedPage
    .getByRole('button', { name: /^toggle navigation$/i })
    .waitFor()
  await exportedPage.waitForFunction(() => {
    const image = document.querySelector('article img.mermaid-diagram')
    return image?.complete && image.naturalWidth > 0
  })
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
  await app.evaluate(({ dialog, BrowserWindow }, filePath) => {
    dialog.showSaveDialog = async (window, options) => {
      if (!(window instanceof BrowserWindow) || !options?.defaultPath)
        throw new Error('Export save dialog must keep its parent window.')
      return { canceled: false, filePath }
    }
  }, protectedPath)
  await modal.getByRole('button', { name: /^export$/i, exact: true }).click()
  await modal.waitFor({ state: 'hidden' })
  assert.ok(
    !(await readFile(protectedPath, 'utf8')).includes('My published garden'),
  )
  assert.match(
    await page.evaluate(async () => {
      try {
        await window.siteProbe.buildSite()
        return ''
      } catch (error) {
        return error.message
      }
    }),
    /Turn off password protection/,
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

for (const count of [100, 1000, 2000]) {
  test(`exported search indexes ${count} pages without rendering them`, {
    timeout: 90000,
  }, async (t) => {
    const folder = await mkdtemp(join(tmpdir(), 'hibi-site-search-'))
    const file = join(folder, 'site.html')
    const pages = Array.from({ length: count }, (_, index) => ({
      path: `${index}.md`,
      markdown:
        '# Page ' +
        index +
        '\n\n## Section ' +
        index +
        '\n\nsanitizer-probe-' +
        index +
        ' ' +
        'Some unicode prose 日本語. '.repeat(320) +
        (index === count - 1 ? `\n\n## raretarget${count} **日本語_é**` : ''),
    }))
    const sourceBytes = pages.reduce(
      (bytes, page) => bytes + Buffer.byteLength(page.markdown),
      0,
    )
    const site = prepareSite(
      { name: 'search fixture', pages },
      exportOptions({ graph: false }),
    )
    const files = await siteFiles(
      await readFile('out/site/template.html', 'utf8'),
      site,
    )
    await writeFile(file, files.get('index.html'))
    const app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
    })
    t.after(async () => {
      await app.close()
      await rm(folder, { recursive: true, force: true })
    })
    await app.firstWindow()
    const next = app.waitForEvent('window')
    await app.evaluate(({ BrowserWindow }, file) => {
      const viewer = new BrowserWindow({
        show: false,
        width: 1200,
        height: 850,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      })
      void viewer.loadFile(file)
    }, file)
    const page = await next
    await page
      .getByRole('button', { name: /^search documentation$/i })
      .waitFor()
    await page.evaluate(() => {
      window.siteSearchCounters = { sanitized: 0, rendered: 0 }
      window.siteSearchRankings = 0
      const post = Worker.prototype.postMessage
      Worker.prototype.postMessage = function (message, ...args) {
        if (message?.job?.kind === 'find') window.siteSearchRankings++
        return post.call(this, message, ...args)
      }
      window.siteSearchTasks = []
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          window.siteSearchTasks.push(entry.duration)
      }).observe({ type: 'longtask' })
      const parse = DOMParser.prototype.parseFromString
      DOMParser.prototype.parseFromString = function (source, ...args) {
        if (String(source).includes('sanitizer-probe-'))
          window.siteSearchCounters.sanitized++
        return parse.call(this, source, ...args)
      }
      const query = DocumentFragment.prototype.querySelectorAll
      DocumentFragment.prototype.querySelectorAll = function (selector) {
        if (selector === 'h1,h2,h3,h4,h5,h6')
          window.siteSearchCounters.rendered++
        return query.call(this, selector)
      }
    })
    await page.getByRole('button', { name: /^search documentation$/i }).click()
    const input = page.getByRole('combobox', { name: /search commands/i })
    await input.waitFor()
    assert.equal(await page.getByRole('option').count(), 50)
    const started = performance.now()
    await input.fill(`raretarget${count}`)
    await page
      .getByRole('option', { name: new RegExp(`raretarget${count}`, 'i') })
      .waitFor()
    const counters = await page.evaluate(() => window.siteSearchCounters)
    assert.deepEqual(counters, { sanitized: 0, rendered: 0 })
    assert.equal(
      page.workers().length,
      1,
      'one inline search worker owns the index',
    )
    assert.equal(await page.evaluate(() => window.siteSearchRankings), 1)
    const firstSearchMs = performance.now() - started
    for (let index = 0; index < 10; index++) await input.press('ArrowDown')
    assert.deepEqual(
      await page.evaluate(() => window.siteSearchCounters),
      counters,
    )
    await page.getByRole('option').nth(0).hover()
    await page.getByRole('option').nth(1).hover()
    assert.equal(await page.evaluate(() => window.siteSearchRankings), 1)
    t.diagnostic(
      JSON.stringify({
        pages: count,
        sourceBytes,
        searchRecordBytes: site.pages.reduce(
          (bytes, page) =>
            bytes + Buffer.byteLength(JSON.stringify(page.search)),
          0,
        ),
        firstSearchMs,
        extraSanitizedPages: counters.sanitized,
        maxObservedTaskMs: await page.evaluate(() =>
          Math.max(0, ...window.siteSearchTasks),
        ),
      }),
    )
    if (count === 100) {
      const heading = { name: /raretarget100 日本語_é/i }
      await page.getByRole('option', heading).hover()
      await page.getByRole('option', { ...heading, selected: true }).waitFor()
      await input.press('Enter')
    } else await input.press('Escape')
    await page.locator('.command-palette').waitFor({ state: 'hidden' })
    if (count === 100) {
      await page
        .locator('article h2')
        .filter({ hasText: /raretarget100 日本語_é/ })
        .waitFor()
      assert.equal(
        await page.evaluate(() =>
          new URLSearchParams(location.hash.slice(1)).get('anchor'),
        ),
        'raretarget100-日本語_é',
      )
      assert.equal(
        await page
          .locator('article h2')
          .filter({ hasText: /raretarget100 日本語_é/ })
          .getAttribute('id'),
        'doc-raretarget100-日本語_é',
      )
      for (let index = 1; index <= 10; index++) {
        await page.evaluate((index) => {
          location.hash = `page=${index}.md`
        }, index)
        await page
          .locator('article h1')
          .filter({ hasText: new RegExp(`^Page ${index}$`) })
          .waitFor()
      }
      const before = await page.evaluate(
        () => window.siteSearchCounters.sanitized,
      )
      await page.evaluate(() => {
        location.hash = 'page=0.md'
      })
      await page
        .locator('article h1')
        .filter({ hasText: /^Page 0$/ })
        .waitFor()
      assert.equal(
        await page.evaluate(() => window.siteSearchCounters.sanitized),
        before + 1,
        'the first page must leave the bounded display cache',
      )
    }
  })
}

for (const blocked of [false, true]) {
  test(blocked
    ? 'search falls back when CSP blocks workers'
    : 'pending search keeps rows and queues cold and warm enter', {
    timeout: 45000,
  }, async (t) => {
    const folder = await mkdtemp(join(tmpdir(), 'hibi-search-pending-'))
    const file = join(folder, 'site.html')
    const site = prepareSite(
      {
        name: 'search',
        pages: Array.from({ length: 100 }, (_, index) => ({
          path: index + '.md',
          markdown: '# Page ' + index + '\n\n## raretarget' + index,
        })),
      },
      exportOptions({ graph: false }),
    )
    let html = (
      await siteFiles(await readFile('out/site/template.html', 'utf8'), site)
    ).get('index.html')
    assert.equal((html.match(/worker-src /g) ?? []).length, 1)
    if (blocked) html = html.replace('worker-src blob:', "worker-src 'none'")
    await writeFile(file, html)
    const app = await electron.launch({
      args: [resolve('.'), '--user-data-dir=' + join(folder, 'profile')],
    })
    t.after(async () => {
      await app.close()
      await rm(folder, { recursive: true, force: true })
    })
    await app.firstWindow()
    const next = app.waitForEvent('window')
    await app.evaluate(({ BrowserWindow }, file) => {
      const viewer = new BrowserWindow({
        show: false,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      })
      void viewer.loadFile(file)
    }, file)
    const page = await next
    const button = page.getByRole('button', { name: /^search documentation$/i })
    await button.waitFor()
    const idleWorkers = page.workers().length
    await page.evaluate((blocked) => {
      window.holdSearch = !blocked
      window.searchMessages = []
      const post = Worker.prototype.postMessage
      Worker.prototype.postMessage = function (...args) {
        window.searchWorker = this
        if (window.holdSearch) window.searchMessages.push([this, args])
        else post.apply(this, args)
      }
      window.resumeSearch = () => {
        window.holdSearch = false
        for (const [worker, args] of window.searchMessages)
          post.apply(worker, args)
        window.searchMessages = []
      }
      window.emptySearchStatuses = []
      new MutationObserver(() => {
        const query = document.querySelector('[role=combobox]')?.value
        const status = document.querySelector('.commands-empty')
        if (query && status) window.emptySearchStatuses.push(status.textContent)
      }).observe(document.body, { childList: true, subtree: true })
    }, blocked)
    await button.click()
    const input = page.getByRole('combobox', { name: /search commands/i })
    await input.pressSequentially('raretarget99')
    if (blocked) {
      await page
        .getByRole('option', { name: /raretarget99/i })
        .first()
        .waitFor()
      assert.equal(page.workers().length, 0)
    } else {
      assert.equal(
        await page.getByRole('option').count(),
        50,
        'keep rows during hydration',
      )
      assert.equal(await page.locator('.commands-empty').count(), 0)
      assert.equal(idleWorkers, 0, 'no worker before search intent')
    }
    await input.press('Enter')
    if (!blocked) await page.evaluate(() => window.resumeSearch())
    await page.locator('.command-palette').waitFor({ state: 'hidden' })
    await page.waitForFunction(
      () => new URLSearchParams(location.hash.slice(1)).get('page') === '99.md',
    )
    if (!blocked) {
      await button.click()
      await input.fill('raretarget99')
      await page
        .getByRole('option', { name: /raretarget99/i })
        .first()
        .waitFor()
      const previous = await page.getByRole('option').allTextContents()
      await page.evaluate(async () => {
        window.holdSearch = true
        const input = document.querySelector('[role=combobox]')
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        ).set.call(input, 'raretarget98')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        await new Promise((resolve) => queueMicrotask(resolve))
        await Promise.resolve()
        input.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        )
      })
      assert.deepEqual(
        await page.getByRole('option').allTextContents(),
        previous,
        'keep rows during ranking',
      )
      assert.equal(await page.locator('.commands-empty').count(), 0)
      await page.evaluate(() => window.resumeSearch())
      await page.locator('.command-palette').waitFor({ state: 'hidden' })
      await page.waitForFunction(
        () =>
          new URLSearchParams(location.hash.slice(1)).get('page') === '98.md',
      )
      await button.click()
      await page.evaluate(() => {
        window.holdSearch = true
      })
      await input.fill('raretarget96')
      await input.press('ArrowDown')
      const highlighted = (
        await page.getByRole('option', { selected: true }).getAttribute('id')
      )
        .slice('command-'.length)
        .split('#')[0]
      assert.equal(
        await page.getByRole('listbox').getAttribute('aria-busy'),
        'true',
      )
      await input.press('Enter')
      await page.locator('.command-palette').waitFor({ state: 'hidden' })
      await page.waitForFunction(
        (path) =>
          new URLSearchParams(location.hash.slice(1)).get('page') === path,
        highlighted,
      )
      await page.evaluate(() => window.resumeSearch())
      await button.click()
      await page.evaluate(() => {
        window.holdSearch = true
      })
      await input.fill('raretarget97')
      await input.press('Enter')
      await page.waitForFunction(() =>
        window.searchMessages.some(([, args]) => args[0]?.job?.kind === 'find'),
      )
      await page.evaluate(() =>
        window.searchWorker.dispatchEvent(new MessageEvent('messageerror')),
      )
      await page.locator('.command-palette').waitFor({ state: 'hidden' })
      await page.waitForFunction(
        () =>
          new URLSearchParams(location.hash.slice(1)).get('page') === '97.md',
      )
    }
    assert.deepEqual(await page.evaluate(() => window.emptySearchStatuses), [])
  })
}
