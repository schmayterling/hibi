import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { createServer } from 'vite'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu, replaceSourceText, splitTab } from './keyboard.mjs'
import { fixtureVault } from './obsidian/harness.mjs'

async function preferences(app) {
  return app.evaluate(({ BrowserWindow, ipcMain }) => {
    const windows = BrowserWindow.getAllWindows()
    const window = windows
      .filter((window) => window.webContents.getURL() === 'app://hibi/')
      .sort((a, b) => b.id - a.id)[0]
    const prefs = window.webContents.getLastWebPreferences()
    return {
      sandbox: prefs.sandbox,
      contextIsolation: prefs.contextIsolation,
      nodeIntegration: prefs.nodeIntegration,
      remote: ipcMain
        .eventNames()
        .some((name) => String(name).startsWith('REMOTE_BROWSER_')),
    }
  })
}
async function defaults(page) {
  return page.evaluate(() => ({
    require: typeof window.require,
    process: typeof window.process,
    desktop: typeof window.hibiObsidianDesktop,
  }))
}
test('desktop consent switches a real Node workspace, preserves unsaved split tabs, and hard revokes back to the default sandbox', {
  timeout: 90000,
}, async (t) => {
  const fixture = await fixtureVault(t, 'host-desktop', { cleanup: false })
  const outside = join(fixture.root, 'outside')
  let beginHang, endHang
  const hung = new Promise((resolve) => {
    beginHang = resolve
  })
  const ended = new Promise((resolve) => {
    endHang = resolve
  })
  const network = createHttpServer(async (request, response) => {
    if (request.url === '/hang') {
      beginHang()
      response.on('close', endHang)
      return
    }
    const parts = []
    for await (const part of request) parts.push(part)
    response.setHeader('Content-Type', 'application/json')
    response.end(
      JSON.stringify({
        method: request.method,
        header: request.headers['x-fixture'],
        body: Buffer.concat(parts).toString(),
      }),
    )
  })
  await new Promise((resolve) => network.listen(0, '127.0.0.1', resolve))
  const networkBase = 'http://127.0.0.1:' + network.address().port
  t.after(() => {
    network.closeAllConnections()
    network.close()
  })
  await mkdir(outside)
  const a = join(fixture.root, 'a.md'),
    b = join(fixture.root, 'b.md')
  await writeFile(a, 'original a')
  await writeFile(b, 'original b')
  await writeFile(
    join(fixture.overlay, 'addons.json'),
    JSON.stringify({ 'quick-note': true, review: true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), '--user-data-dir=' + fixture.overlay],
  })
  t.after(async () => {
    try {
      await app.close()
      await fixture.assertUnchanged()
    } finally {
      await fixture.dispose()
    }
  })
  let page = await app.firstWindow()
  page.setDefaultTimeout(8000)
  await waitForDocumentEditor(app, page)
  assert.deepEqual(await preferences(app), {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    remote: false,
  })
  assert.deepEqual(await defaults(page), {
    require: 'undefined',
    process: 'undefined',
    desktop: 'undefined',
  })
  await page.evaluate(() => localStorage.setItem('default-view', 'markdown'))
  await page.reload()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  const open = async (file) => {
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      })
    }, file)
    await clickMenu(app, 'Open…')
    await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  }
  await open(a)
  const left = (await page.evaluate(() => window.hibi.getDocument())).tabId
  await replaceSourceText(
    page,
    page.getByRole('textbox', { name: 'Markdown editor' }),
    Array.from({ length: 130 }, (_, i) => 'unsaved left ' + i).join('\n'),
  )
  await open(b)
  const right = (await page.evaluate(() => window.hibi.getDocument())).tabId
  await replaceSourceText(
    page,
    page.getByRole('textbox', { name: 'Markdown editor' }),
    Array.from({ length: 130 }, (_, i) => 'unsaved right ' + i).join('\n'),
  )
  await page.getByRole('tab', { name: 'a.md' }).click()
  await splitTab(app, page, right)
  await page
    .locator('.editor-page[data-side="right"] .source-pane .cm-editor')
    .waitFor()
  await page.evaluate(() => {
    for (const [index, el] of [
      ...document.querySelectorAll('.editor-page .cm-scroller'),
    ].entries())
      el.scrollTop = 300 + index * 100
  })
  const scrolls = await page
    .locator('.editor-page .cm-scroller')
    .evaluateAll((elements) => elements.map((element) => element.scrollTop))
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  await page
    .getByRole('checkbox', { name: 'Obsidian plugins', exact: true })
    .click()
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  await app.evaluate(({ dialog, shell }, folder) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [folder],
    })
    dialog.showMessageBox = async () => ({ response: 1 })
    globalThis.__desktopExternal = []
    shell.openExternal = async (url) => {
      globalThis.__desktopExternal.push(url)
    }
  }, fixture.folder)
  await page
    .getByRole('button', {
      name: 'Install Obsidian plugin from folder',
      exact: true,
    })
    .click()
  const row = page.locator(
    '[data-setting-id="installed-obsidian-host-desktop"]',
  )
  await row
    .getByRole('checkbox', { name: 'Enable Desktop fixture', exact: true })
    .waitFor()
  assert.equal(
    await row
      .getByRole('checkbox', { name: 'Enable Desktop fixture', exact: true })
      .isChecked(),
    false,
  )
  await page.evaluate(
    async ({ outside, network }) => {
      await window.hibi.invokeAddon('obsidian', 'saveData', {
        id: 'host-desktop',
        value: { outside, network },
      })
    },
    { outside, network: networkBase + '/echo' },
  )
  await row
    .getByRole('checkbox', { name: 'Enable Desktop fixture', exact: true })
    .click()
  let prompt = page.getByRole('dialog', {
    name: 'Full computer access for Desktop fixture?',
    exact: true,
  })
  await prompt.waitFor()
  assert.match(await prompt.innerText(), /Fixture author/)
  assert.match(
    await prompt.innerText(),
    /read and write any file.*run programs/,
  )
  assert.match(
    await prompt.innerText(),
    /Hibi itself runs in a less isolated workspace/,
  )
  await prompt.getByRole('button', { name: 'Cancel', exact: true }).click()
  assert.deepEqual(await preferences(app), {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    remote: false,
  })
  assert.equal(
    (await page.evaluate(() => window.hibi.queryAddon('obsidian', 'list')))[0]
      .enabled,
    false,
  )
  await row
    .getByRole('checkbox', { name: 'Enable Desktop fixture', exact: true })
    .click()
  prompt = page.getByRole('dialog', {
    name: 'Full computer access for Desktop fixture?',
    exact: true,
  })
  await app.evaluate(({ app }) => {
    globalThis.__desktopPreloadErrors = []
    app.on('web-contents-created', (_event, contents) => {
      contents.on('preload-error', (_event, path, error) =>
        globalThis.__desktopPreloadErrors.push({
          path,
          error: String(error),
          stack: error.stack,
        }),
      )
    })
  })
  await app.evaluate(({ ipcMain }) => {
    const channel = 'document:flushed'
    const original = ipcMain.listeners(channel)[0]
    ipcMain.removeListener(channel, original)
    const blocked = (event, token, error) =>
      original(
        event,
        token,
        token === 'ready' ? error : 'fixture refused flush',
      )
    ipcMain.on(channel, blocked)
    globalThis.__restoreDesktopFlush = () => {
      ipcMain.removeListener(channel, blocked)
      ipcMain.on(channel, original)
    }
  })
  await prompt
    .getByRole('button', { name: 'Grant full access and enable', exact: true })
    .click()
  await page
    .getByText(
      'Could not confirm the latest edits. Keep this window open and try again.',
      { exact: true },
    )
    .waitFor()
  assert.deepEqual(await preferences(app), {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    remote: false,
  })
  assert.equal(
    await page.evaluate(() => typeof window.__hibiDesktopFixture),
    'undefined',
  )
  await app.evaluate(() => globalThis.__restoreDesktopFlush())
  const nextPage = app.waitForEvent('window')
  await page
    .getByRole('button', { name: 'Retry workspace switch', exact: true })
    .click()
  page = await nextPage
  assert.deepEqual(
    await app.evaluate(() => globalThis.__desktopPreloadErrors),
    [],
  )
  page.setDefaultTimeout(8000)
  await page.getByRole('button', { name: 'Back to app', exact: true }).click()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  await page.waitForFunction(() => !!window.__hibiDesktopFixture)
  assert.deepEqual(await preferences(app), {
    sandbox: false,
    contextIsolation: false,
    nodeIntegration: false,
    remote: true,
  })
  assert.deepEqual(await defaults(page), {
    require: 'undefined',
    process: 'undefined',
    desktop: 'object',
  })
  const checks = await page.evaluate(() => window.__hibiDesktopFixture)
  assert.deepEqual(checks.network, {
    method: 'POST',
    header: 'desktop',
    body: 'desktop body',
  })
  assert.equal(checks.event, 7)
  assert.equal(checks.output, 'fixture')
  assert.equal(checks.asynchronous, 11)
  for (const field of [
    'buffer',
    'stream',
    'stats',
    'dom',
    'clipboard',
    'ipc',
    'globalProcess',
    'globalBuffer',
  ])
    assert.equal(checks[field], true, field)
  assert.equal(checks.nodeSandboxed, false)
  assert.match(checks.hash, /^[a-f0-9]{64}$/)
  assert.equal(checks.url, 'example.test')
  assert.deepEqual(await app.evaluate(() => globalThis.__desktopExternal), [
    'https://example.test/desktop-fixture',
  ])
  assert.equal(
    await readFile(join(outside, 'desktop.txt'), 'utf8'),
    'desktop fixture',
  )
  assert.equal(
    await readFile(join(outside, 'async.txt'), 'utf8'),
    'desktop fixture',
  )
  assert.equal(await readFile(a, 'utf8'), 'original a')
  assert.equal(await readFile(b, 'utf8'), 'original b')
  assert.equal(await page.locator('.editor-page[data-side]').count(), 2)
  assert.deepEqual(
    await page
      .locator('.editor-page .cm-scroller')
      .evaluateAll((elements) => elements.map((element) => element.scrollTop)),
    scrolls,
  )
  assert.match(
    await page.locator('.editor-page[data-side="left"]').innerText(),
    /unsaved left/,
  )
  assert.match(
    await page.locator('.editor-page[data-side="right"]').innerText(),
    /unsaved right/,
  )
  await app.evaluate(
    ({ app, dialog }, file) => {
      globalThis.__desktopSecondary = []
      const snapshot = (window) => {
        const contents = window.webContents,
          prefs = contents.getLastWebPreferences()
        const metric = app
          .getAppMetrics()
          .find((metric) => metric.pid === contents.getOSProcessId())
        return {
          url: contents.getURL(),
          sandbox: prefs.sandbox,
          contextIsolation: prefs.contextIsolation,
          nodeIntegration: prefs.nodeIntegration,
          actual: metric?.sandboxed,
        }
      }
      app.on('browser-window-created', (_event, window) => {
        window.webContents.once('did-finish-load', () =>
          globalThis.__desktopSecondary.push(snapshot(window)),
        )
      })
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
    },
    join(outside, 'fixture.pdf'),
  )
  await page.evaluate(() =>
    window.hibi.openAddonWindow('quick-note', {
      id: 'desktop-audit',
      title: 'Sandbox audit',
    }),
  )
  const addon = app
    .windows()
    .find((candidate) => candidate.url().endsWith('/addon-window.html'))
  assert.ok(addon)
  await addon.waitForFunction(() => typeof window.hibiAddonWindow === 'object')
  assert.deepEqual(
    await addon.evaluate(() => ({
      require: typeof window.require,
      process: typeof window.process,
      host: typeof window.hibiObsidianDesktop,
    })),
    { require: 'undefined', process: 'undefined', host: 'undefined' },
  )
  await page.evaluate(() => window.hibi.cancelAnalysis('review'))
  const analysis = await page.evaluate(async () => {
    const document = await window.hibi.getDocument()
    return window.hibi.analyzeDocument('review', {
      id: 'desktop-sandbox-audit',
      tabId: document.tabId,
      revision: document.revision,
      contentVersion: document.contentVersion,
      text: document.markdown,
      spans: [
        {
          from: 0,
          to: document.markdown.length,
          sourceFrom: 0,
          sourceTo: document.markdown.length,
        },
      ],
    })
  })
  assert.equal(analysis.status, 'complete')
  const analyzer = app
    .windows()
    .find((candidate) => candidate.url().startsWith('hibi-analysis:'))
  assert.ok(analyzer)
  assert.deepEqual(
    await analyzer.evaluate(() => ({
      require: typeof window.require,
      process: typeof window.process,
      host: typeof window.hibiObsidianDesktop,
    })),
    { require: 'undefined', process: 'undefined', host: 'undefined' },
  )
  await page.evaluate(async () => {
    const document = await window.hibi.getDocument()
    await window.hibi.exportPdf(
      document.tabId,
      '<!doctype html><html><body><p>Sandbox fixture</p></body></html>',
    )
  })
  const childId = await page.evaluate(() =>
    window.__hibiDesktopFixture.openWindow(),
  )
  const requireChild = await page.evaluate(() =>
    window.__hibiDesktopFixture.openWindow(true),
  )
  assert.notEqual(requireChild, childId)
  const secondary = await app.evaluate(() => globalThis.__desktopSecondary)
  for (const kind of [
    'addon-window.html',
    'hibi-analysis:',
    'hibi-print:',
    'data:text/html',
  ])
    assert.ok(
      secondary.some((entry) => entry.url.includes(kind)),
      kind,
    )
  for (const entry of secondary) {
    assert.equal(entry.sandbox, true, entry.url)
    assert.equal(entry.contextIsolation, true, entry.url)
    assert.equal(entry.nodeIntegration, false, entry.url)
    if (process.platform === 'darwin' || process.platform === 'win32')
      assert.equal(entry.actual, true, entry.url)
  }
  assert.equal(
    await app.evaluate(({ app }) =>
      app.commandLine.hasSwitch('enable-sandbox'),
    ),
    false,
  )
  await page.evaluate(() =>
    window.hibi.closeAddonWindow('quick-note', 'desktop-audit'),
  )
  await page.evaluate(() => window.hibi.cancelAnalysis('review'))
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  await page.getByText('Trusted workspace mode', { exact: true }).waitFor()
  await page.evaluate((url) => {
    void window.__hibiDesktopFixture.request(url).catch(() => {})
  }, networkBase + '/hang')
  await hung
  await app.evaluate(({ ipcMain }) => {
    const channel = 'document:flushed',
      original = ipcMain.listeners(channel)[0]
    ipcMain.removeListener(channel, original)
    const blocked = (event, token, error) =>
      original(
        event,
        token,
        token === 'ready' ? error : 'fixture revoke flush blocked',
      )
    ipcMain.on(channel, blocked)
    globalThis.__restoreRevokeFlush = () => {
      ipcMain.removeListener(channel, blocked)
      ipcMain.on(channel, original)
    }
  })
  const sandboxPage = app.waitForEvent('window')
  await page
    .getByRole('button', {
      name: 'Revoke full computer access for Desktop fixture',
      exact: true,
    })
    .click()
  await page.getByText('Revocation pending', { exact: true }).waitFor()
  assert.equal(
    await page.evaluate(() => typeof window.hibiObsidianDesktop),
    'object',
  )
  await app.evaluate(() => globalThis.__restoreRevokeFlush())
  page = await sandboxPage
  await ended
  page.setDefaultTimeout(8000)
  await page.getByRole('button', { name: 'Back to app', exact: true }).click()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  await page.waitForFunction(() => !window.hibiObsidianDesktop)
  assert.deepEqual(await defaults(page), {
    require: 'undefined',
    process: 'undefined',
    desktop: 'undefined',
  })
  const prefs = await preferences(app)
  assert.equal(
    await app.evaluate(
      ({ BrowserWindow }, id) =>
        BrowserWindow.getAllWindows().some((window) => window.id === id),
      childId,
    ),
    false,
  )
  assert.equal(
    await app.evaluate(({ app }) =>
      app.commandLine.hasSwitch('enable-sandbox'),
    ),
    true,
  )
  assert.equal(prefs.sandbox, true)
  assert.equal(prefs.contextIsolation, true)
  assert.equal(prefs.nodeIntegration, false)
  const installed = await page.evaluate(() =>
    window.hibi.queryAddon('obsidian', 'list'),
  )
  assert.equal(installed[0].enabled, false)
  assert.equal(installed[0].fullAccess, undefined)
  assert.equal(await page.locator('.editor-page[data-side]').count(), 2)
  assert.match(
    await page.locator('.editor-page[data-side="left"]').innerText(),
    /unsaved left/,
  )
  assert.match(
    await page.locator('.editor-page[data-side="right"]').innerText(),
    /unsaved right/,
  )
  assert.equal(await readFile(a, 'utf8'), 'original a')
  assert.equal(await readFile(b, 'utf8'), 'original b')
  assert.equal(
    await readFile(join(outside, 'unloaded.txt'), 'utf8'),
    'unloaded\n',
  )
  await page.reload()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  const reloaded = await page.evaluate(() => window.hibi.getDocument())
  assert.match(reloaded.markdown, /unsaved (left|right)/)
  assert.equal(reloaded.tabs.length, 2)
  assert.equal(
    await page.evaluate(() => typeof window.hibiObsidianDesktop),
    'undefined',
  )
  await fixture.assertUnchanged()
})

test('persisted desktop permission starts in trusted mode and an empty draft survives revocation', {
  timeout: 60000,
}, async (t) => {
  const fixture = await fixtureVault(t, 'host-desktop', { cleanup: false })
  const outside = join(fixture.root, 'outside')
  await mkdir(outside)
  const server = await createServer({
    configFile: false,
    cacheDir: join(fixture.root, 'cache'),
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom',
  })
  try {
    const { ObsidianStore, readObsidianPackage } = await server.ssrLoadModule(
      '/src/addons/obsidian/store.ts',
    )
    const store = new ObsidianStore(join(fixture.overlay, 'obsidian', 'global'))
    await store.install(await readObsidianPackage(fixture.folder))
    await store.saveData('host-desktop', { outside, skipExternal: true })
    await store.setEnabled('host-desktop', true, () => {}, true)
  } finally {
    await server.close()
  }
  await writeFile(
    join(fixture.overlay, 'addons.json'),
    JSON.stringify({ obsidian: true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), '--user-data-dir=' + fixture.overlay],
  })
  t.after(async () => {
    try {
      await app.close()
      await fixture.assertUnchanged()
    } finally {
      await fixture.dispose()
    }
  })
  let page = await app.firstWindow()
  page.setDefaultTimeout(8000)
  await waitForDocumentEditor(app, page)
  await page.waitForFunction(() => !!window.__hibiDesktopFixture)
  assert.deepEqual(await preferences(app), {
    sandbox: false,
    contextIsolation: false,
    nodeIntegration: false,
    remote: true,
  })
  const before = await page.evaluate(() => window.hibi.getDocument())
  assert.equal(before.markdown, '')
  assert.equal(before.tabs.length, 0)
  const next = app.waitForEvent('window')
  await page.evaluate(() =>
    window.hibi.invokeAddon('obsidian', 'enable', {
      id: 'host-desktop',
      enabled: false,
    }),
  )
  page = await next
  page.setDefaultTimeout(8000)
  await waitForDocumentEditor(app, page)
  assert.deepEqual(await defaults(page), {
    require: 'undefined',
    process: 'undefined',
    desktop: 'undefined',
  })
  const after = await page.evaluate(() => window.hibi.getDocument())
  assert.equal(after.markdown, '')
  assert.equal(after.tabs.length, 0)
  assert.equal(after.tabId, before.tabId)
  assert.equal((await preferences(app)).sandbox, true)
  const record = (
    await page.evaluate(() => window.hibi.queryAddon('obsidian', 'list'))
  )[0]
  assert.equal(record.enabled, false)
  assert.equal(record.fullAccess, undefined)
  await fixture.assertUnchanged()
})

async function seedPlugins(fixture, entries) {
  const server = await createServer({
    configFile: false,
    cacheDir: join(fixture.root, 'seed-cache'),
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom',
  })
  try {
    const { ObsidianStore, readObsidianPackage } = await server.ssrLoadModule(
      '/src/addons/obsidian/store.ts',
    )
    const store = new ObsidianStore(join(fixture.overlay, 'obsidian', 'global'))
    const records = []
    for (const entry of entries) {
      const source = await readObsidianPackage(entry.folder)
      await store.install(source)
      if (entry.data) await store.saveData(source.manifest.id, entry.data)
      records.push(
        await store.setEnabled(
          source.manifest.id,
          true,
          () => {},
          entry.fullAccess === true,
        ),
      )
    }
    await writeFile(
      join(fixture.overlay, 'addons.json'),
      JSON.stringify({ obsidian: true }),
    )
    return records
  } finally {
    await server.close()
  }
}

test('trusted workspace pauses a portable peer until its own native full-access consent and resumes only granted code', {
  timeout: 60000,
}, async (t) => {
  const fixture = await fixtureVault(t, 'host-desktop', { cleanup: false })
  const peer = await fixtureVault(t, 'host-portable-peer')
  const outside = join(fixture.root, 'outside')
  await mkdir(outside)
  await seedPlugins(fixture, [
    {
      folder: fixture.folder,
      fullAccess: true,
      data: { outside, skipExternal: true },
    },
    { folder: peer.folder },
  ])
  const hibiPeer = join(fixture.overlay, 'installed-addons', 'installed-peer')
  await mkdir(hibiPeer, { recursive: true })
  await writeFile(
    join(hibiPeer, 'hibi-addon.json'),
    JSON.stringify({
      id: 'installed-peer',
      name: 'Installed peer',
      authors: [{ displayName: 'Fixture author' }],
      description: 'A renderer fixture held in trusted mode.',
      kind: 'extension',
      apiVersion: 3,
      version: '1.0.0',
      capabilities: [],
      startup: 'background',
      entry: 'index.js',
    }),
  )
  await writeFile(
    join(hibiPeer, 'index.js'),
    'window.__hibiInstalledPeerRuns = (window.__hibiInstalledPeerRuns || 0) + 1; export default () => ({ start(context) { window.__hibiInstalledPeerStarted = true; context.commands.register({id:"peer",label:"Installed peer",run(){}}); } });',
  )
  await writeFile(
    join(hibiPeer, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['hibi-addon.json', 'index.js'],
      source: 'local',
    }),
  )
  await writeFile(
    join(fixture.overlay, 'addons.json'),
    JSON.stringify({ obsidian: true, 'installed-peer': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), '--user-data-dir=' + fixture.overlay],
  })
  t.after(async () => {
    try {
      await app.close()
      await fixture.assertUnchanged()
    } finally {
      await fixture.dispose()
    }
  })
  let page = await app.firstWindow()
  page.setDefaultTimeout(8000)
  await waitForDocumentEditor(app, page)
  await page.waitForFunction(() => !!window.__hibiDesktopFixture)
  assert.equal(
    await page.evaluate(() => typeof window.__hibiPortablePeer),
    'undefined',
  )
  await assert.rejects(
    page.evaluate(() =>
      window.hibi.invokeAddonProfile('obsidian', 'preparePluginLoad', {
        id: 'host-portable-peer',
        hash: 'a'.repeat(64),
      }),
    ),
    /need full computer access/,
  )
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  const hibiRow = page.locator('[data-setting-id="addon-installed-peer"]')
  await hibiRow
    .getByText(
      'Paused while full computer access is on. Turn off full access to use this addon, or disable it.',
      { exact: true },
    )
    .waitFor()
  assert.equal(
    await page.evaluate(() => window.__hibiInstalledPeerRuns),
    undefined,
  )
  const row = page.locator(
    '[data-setting-id="installed-obsidian-host-portable-peer"]',
  )
  await row
    .getByText(
      'Paused in trusted workspace mode. Grant full computer access or disable this plugin.',
      { exact: true },
    )
    .waitFor()
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0 })
  })
  const grant = row.getByRole('button', {
    name: 'Grant full computer access to Portable peer',
    exact: true,
  })
  await grant.click()
  await page
    .getByRole('dialog', {
      name: 'Full computer access for Portable peer?',
      exact: true,
    })
    .getByRole('button', { name: 'Grant full access and enable', exact: true })
    .click()
  await row
    .getByText(
      'Paused in trusted workspace mode. Grant full computer access or disable this plugin.',
      { exact: true },
    )
    .waitFor()
  assert.equal(
    await page.evaluate(() => typeof window.__hibiPortablePeer),
    'undefined',
  )
  await page.waitForFunction(() => {
    const button = document.querySelector(
      '[aria-label="Grant full computer access to Portable peer"]',
    )
    return button && !button.disabled
  })
  const declined = (
    await page.evaluate(() => window.hibi.queryAddon('obsidian', 'list'))
  ).find((plugin) => plugin.manifest.id === 'host-portable-peer')
  assert.equal(declined.fullAccess, undefined)
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  await grant.click()
  const next = app.waitForEvent('window')
  await page
    .getByRole('dialog', {
      name: 'Full computer access for Portable peer?',
      exact: true,
    })
    .getByRole('button', { name: 'Grant full access and enable', exact: true })
    .click()
  page = await next
  page.setDefaultTimeout(8000)
  await page.waitForFunction(() => window.__hibiPortablePeer?.loaded)
  assert.equal(await page.evaluate(() => window.__hibiPortablePeer.node), true)
  assert.deepEqual(await defaults(page), {
    require: 'undefined',
    process: 'undefined',
    desktop: 'object',
  })
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  const sandbox = app.waitForEvent('window')
  assert.equal(
    await page.evaluate(() => window.__hibiInstalledPeerRuns),
    undefined,
  )
  await page
    .locator('[data-setting-id="addon-installed-peer"]')
    .getByRole('button', { name: 'Turn off full computer access', exact: true })
    .click()
  page = await sandbox
  await page.getByRole('button', { name: 'Back to app', exact: true }).click()
  await waitForDocumentEditor(app, page)
  await page.waitForFunction(() => !window.hibiObsidianDesktop)
  await page.waitForFunction(() => window.__hibiInstalledPeerStarted === true)
  assert.equal(await page.evaluate(() => window.__hibiInstalledPeerRuns), 1)
  assert.equal(
    await page.evaluate(() => typeof window.__hibiPortablePeer),
    'undefined',
  )
  for (const plugin of await page.evaluate(() =>
    window.hibi.queryAddon('obsidian', 'list'),
  )) {
    assert.equal(plugin.enabled, false)
    assert.equal(plugin.fullAccess, undefined)
  }
  await fixture.assertUnchanged()
  await peer.assertUnchanged()
})

test('tampered granted package starts safely, stays visible for repair and can revoke without reading its code', {
  timeout: 60000,
}, async (t) => {
  const fixture = await fixtureVault(t, 'host-desktop', { cleanup: false })
  const [record] = await seedPlugins(fixture, [
    { folder: fixture.folder, fullAccess: true },
  ])
  await writeFile(
    join(
      fixture.overlay,
      'obsidian',
      'global',
      'packages',
      record.manifest.id,
      record.hash,
      'main.js',
    ),
    'throw new Error("tampered fixture must never run")',
  )
  const app = await electron.launch({
    args: [resolve('.'), '--user-data-dir=' + fixture.overlay],
  })
  t.after(async () => {
    try {
      await app.close()
      await fixture.assertUnchanged()
    } finally {
      await fixture.dispose()
    }
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(8000)
  await waitForDocumentEditor(app, page)
  assert.deepEqual(await defaults(page), {
    require: 'undefined',
    process: 'undefined',
    desktop: 'undefined',
  })
  assert.equal((await preferences(app)).sandbox, true)
  assert.equal((await preferences(app)).remote, false)
  const [damaged] = await page.evaluate(() =>
    window.hibi.queryAddon('obsidian', 'list'),
  )
  assert.equal(damaged.fullAccess, undefined)
  assert.equal(damaged.enabled, false)
  assert.match(damaged.error, /stored plugin hash/)
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  await page.getByText(damaged.error, { exact: true }).waitFor()
  await page.evaluate(() =>
    window.hibi.invokeAddon('obsidian', 'revokeFullAccess'),
  )
  const raw = JSON.parse(
    await readFile(
      join(
        fixture.overlay,
        'obsidian',
        'global',
        'state',
        record.manifest.id,
        'package.json',
      ),
      'utf8',
    ),
  )
  assert.equal(raw.enabled, false)
  assert.equal(raw.fullAccess, undefined)
  assert.equal(raw.fullAccessHash, undefined)
  await page.evaluate(() =>
    window.hibi.invokeAddon('obsidian', 'remove', { id: 'host-desktop' }),
  )
  assert.deepEqual(
    await page.evaluate(() => window.hibi.queryAddon('obsidian', 'list')),
    [],
  )
  await fixture.assertUnchanged()
})

test('turning the host off retains capture support until trusted renderer is destroyed', {
  timeout: 60000,
}, async (t) => {
  const fixture = await fixtureVault(t, 'host-desktop', { cleanup: false })
  const outside = join(fixture.root, 'outside')
  await mkdir(outside)
  await seedPlugins(fixture, [
    {
      folder: fixture.folder,
      fullAccess: true,
      data: { outside, skipExternal: true },
    },
  ])
  const app = await electron.launch({
    args: [resolve('.'), '--user-data-dir=' + fixture.overlay],
  })
  t.after(async () => {
    try {
      await app.close()
      await fixture.assertUnchanged()
    } finally {
      await fixture.dispose()
    }
  })
  let page = await app.firstWindow()
  page.setDefaultTimeout(8000)
  await waitForDocumentEditor(app, page)
  await page.waitForFunction(() => !!window.__hibiDesktopFixture)
  const sandbox = app.waitForEvent('window')
  await page.evaluate(() => window.hibi.setAddonEnabled('obsidian', false))
  page = await sandbox
  page.setDefaultTimeout(8000)
  await waitForDocumentEditor(app, page)
  assert.deepEqual(await defaults(page), {
    require: 'undefined',
    process: 'undefined',
    desktop: 'undefined',
  })
  assert.equal((await preferences(app)).sandbox, true)
  assert.equal(
    (await page.evaluate(() => window.hibi.getAddonStates())).find(
      (addon) => addon.id === 'obsidian',
    ).enabled,
    false,
  )
  await page.reload()
  await waitForDocumentEditor(app, page)
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    '',
  )
  await fixture.assertUnchanged()
})
