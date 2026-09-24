import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { crashAndReload, electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

test('desktop launch, isolation, offline reload, and recovery', {
  timeout: 60000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-test-'))
  const started = performance.now()
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
    colorScheme: null,
  })
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  t.diagnostic(
    `launch to ready content: ${Math.round(performance.now() - started)} ms`,
  )
  assert.equal(page.url(), 'app://hibi/')
  if (process.platform === 'darwin')
    assert.equal(await app.evaluate(({ app }) => app.dock.isVisible()), false)
  const windowState = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    return {
      maximized: window.isMaximized(),
      fullscreen: window.isFullScreen(),
      visible: window.isVisible(),
      focused: window.isFocused(),
    }
  })
  assert.equal(windowState.maximized, false)
  assert.equal(windowState.fullscreen, false)
  assert.equal(windowState.visible, process.env.GITHUB_ACTIONS === 'true')
  if (process.env.GITHUB_ACTIONS !== 'true')
    assert.equal(windowState.focused, false)
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^about$/i, exact: true }).click()
  await page
    .locator('.settings-sidebar .settings-versions')
    .getByText(/^electron 44\.3\.0$/i, { exact: true })
    .waitFor()
  await page.keyboard.press('Escape')
  assert.deepEqual(
    await page.evaluate(() => ({
      node: typeof window.require,
      process: typeof window.process,
      api: Object.keys(window.hibi).sort(),
    })),
    {
      node: 'undefined',
      process: 'undefined',
      api: [
        'getUpdateState',
        'setUpdateChannel',
        'setUpdateCheckFrequency',
        'setUpdateStartupCheck',
        'checkForUpdates',
        'downloadUpdate',
        'installUpdate',
        'onUpdateChanged',
        'getDependencies',
        'checkDependency',
        'installDependency',
        'configureDependency',
        'openDependencyGuide',
        'analyzeDocument',
        'cancelAnalysis',
        'appendDocumentChange',
        'appendSourceOperation',
        'admitSourceOperation',
        'getDocumentRecoveryState',
        'onDocumentCheckpoint',
        'flushDocumentChanges',
        'bootstrap',
        'getAddonDocumentation',
        'openAddonDocumentationLink',
        'getFileAssociations',
        'setFileAssociation',
        'navigateDocument',
        'openDocumentLink',
        'openRemoteDocument',
        'onOpenRemote',
        'attachMedia',
        'readDocumentMedia',
        'openDroppedFile',
        'getInstalledAddons',
        'installAddon',
        'openAddonsFolder',
        'openAddonGarden',
        'removeAddon',
        'listVersions',
        'previewVersion',
        'restoreVersion',
        'onNotice',
        'getLicenses',
        'getLicense',
        'openSponsor',
        'setAppearance',
        'getAddonStates',
        'setAddonEnabled',
        'invokeAddon',
        'queryAddon',
        'getWorkspace',
        'listImporters',
        'importIntoWorkspace',
        'getWorkspaceSettings',
        'updateWorkspaceSettings',
        'getRecentWorkspaces',
        'getKnownWorkspaces',
        'openRecentWorkspace',
        'setKnownWorkspace',
        'deleteKnownWorkspace',
        'getWorkspaceSnapshot',
        'getWorkspaceIndex',
        'workspaceAction',
        'openWorkspace',
        'refreshWorkspace',
        'openWorkspaceFile',
        'onWorkspaceChanged',
        'onWorkspaceListChanged',
        'getAppInfo',
        'setUiCase',
        'getDocument',
        'selectDocumentTab',
        'closeDocumentTab',
        'moveDocumentTab',
        'setTabsEnabled',
        'updateDocument',
        'openDocument',
        'openExternalDocuments',
        'onExternalDocuments',
        'newDocument',
        'saveDocument',
        'autosaveDocument',
        'renameDocument',
        'readDocumentImage',
        'getHotkeys',
        'saveHotkeys',
        'setHotkeyRecording',
        'onCommand',
      ].sort(),
    },
  )
  const preferences = await app.evaluate(({ BrowserWindow }) => {
    const prefs =
      BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()
    return {
      sandbox: prefs.sandbox,
      contextIsolation: prefs.contextIsolation,
      nodeIntegration: prefs.nodeIntegration,
    }
  })
  assert.deepEqual(preferences, {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
  })

  await t.test(
    'csp blocks injected scripts and outside connections',
    async () => {
      const blocked = await page.evaluate(async () => {
        const script = document.createElement('script')
        script.textContent = 'window.injected = true'
        document.body.append(script)
        let networkBlocked = false
        try {
          await fetch('https://example.com')
        } catch {
          networkBlocked = true
        }
        return { inlineBlocked: window.injected !== true, networkBlocked }
      })
      assert.deepEqual(blocked, { inlineBlocked: true, networkBlocked: true })
    },
  )

  await t.test(
    'asset protocol rejects traversal and unrecognized hosts',
    async () => {
      const statuses = await app.evaluate(async ({ net }) => {
        const urls = [
          'app://hibi/..%2fmain/index.js',
          'app://other/index.html',
          'app://hibi/missing.js',
        ]
        return Promise.all(
          urls.map(async (url) => (await net.fetch(url)).status),
        )
      })
      assert.deepEqual(statuses, [403, 403, 404])
    },
  )

  await t.test('other windows cannot use privileged ipc', async () => {
    const denied = await app.evaluate(async ({ app, BrowserWindow }) => {
      const rogue = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: `${app.getAppPath()}/out/preload/index.cjs`,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      })
      try {
        await rogue.loadURL('app://hibi/')
        return await rogue.webContents.executeJavaScript(
          `Promise.all([
            window.hibi.getAppInfo(),
            window.hibi.getAddonDocumentation('keybeats', 'README.md'),
            window.hibi.openAddonDocumentationLink('https://example.com'),
          ].map(request => request.then(() => false, () => true))).then(results => results.every(Boolean))`,
        )
      } finally {
        rogue.destroy()
      }
    })
    assert.equal(denied, true)
  })

  await t.test('navigation and popup requests are denied', async () => {
    for (const destination of [
      'https://example.com',
      'app://hibi/assets/index.html',
      'app://hibi/?injected=1',
    ]) {
      await app.evaluate(({ BrowserWindow }) => {
        const contents = BrowserWindow.getAllWindows()[0].webContents
        globalThis.navigationPrevented = new Promise((resolve) =>
          contents.once('will-frame-navigate', (event) =>
            resolve(event.defaultPrevented),
          ),
        )
      })
      await page.evaluate((destination) => {
        location.href = destination
      }, destination)
      assert.equal(
        await app.evaluate(() => globalThis.navigationPrevented),
        true,
      )
      assert.equal(page.url(), 'app://hibi/')
    }
    assert.equal(
      await page.evaluate(() => window.open('https://example.com') === null),
      true,
    )
    assert.equal(
      await app.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
      ),
      1,
    )
  })

  await t.test(
    'offline reload and both system themes work at minimum window size',
    async () => {
      await app.context().setOffline(true)
      await page.reload()
      await page.getByRole('textbox', { name: /document editor/i }).waitFor()
      await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.unmaximize()
        window.setSize(480, 360)
      })
      await mkdir('test-results', { recursive: true })
      for (const theme of ['light', 'dark']) {
        await app.evaluate(({ nativeTheme }, theme) => {
          nativeTheme.themeSource = theme
        }, theme)
        await page.waitForFunction(
          (theme) =>
            matchMedia('(prefers-color-scheme: dark)').matches ===
            (theme === 'dark'),
          theme,
        )
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
        )
        await page.screenshot({ path: `test-results/${theme}.png` })
      }
      assert.deepEqual(errors, [])
      await app.context().setOffline(false)
    },
  )

  if (process.platform === 'darwin') {
    await t.test('macos closes and reopens its window', async () => {
      const opened = app.waitForEvent('window')
      await app.evaluate(async ({ app, BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        const closed = new Promise((resolve) => window.once('closed', resolve))
        window.close()
        await closed
        app.emit('activate')
      })
      const reopened = await opened
      await reopened
        .getByRole('textbox', { name: /document editor/i })
        .waitFor()
      assert.equal(
        (await reopened.evaluate(() => window.hibi.getAppInfo())).version,
        '0.1.0',
      )
    })
  }

  await t.test('renderer crash offers reload and recovers', async () => {
    await crashAndReload(app)
    const recovered = await app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents
      // Playwright retains its crashed target; inspect the new renderer through Electron.
      return contents.executeJavaScript(
        'new Promise(resolve => { const check = () => document.querySelector(".tiptap") ? window.hibi.getAppInfo().then(info => resolve({ editor: true, version: info.version })) : requestAnimationFrame(check); check() })',
      )
    })
    assert.deepEqual(recovered, {
      editor: true,
      version: '0.1.0',
    })
  })
})
