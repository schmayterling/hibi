import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'
import { waitForAsync } from './poll.mjs'

test('development watches main, renderer, preload, addons, and documentation generation', {
  timeout: 180000,
}, async (t) => {
  const started = performance.now()
  const mark = (message) =>
    t.diagnostic(`${message} (${Math.round(performance.now() - started)} ms)`)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hibi-dev-watch-')))
  for (const name of [
    'src',
    'scripts',
    'docs',
    'build',
    'package.json',
    'package-lock.json',
    'electron.vite.config.ts',
    'tsconfig.json',
    'tsconfig.node.json',
    'tsconfig.web.json',
  ])
    await cp(resolve(name), join(root, name), {
      recursive: true,
      filter: (file) => !file.split(sep).includes('useraddons'),
    })
  await symlink(resolve('node_modules'), join(root, 'node_modules'), 'junction')
  const holdMainBuild = join(root, 'hold-main-build')
  const mainBuildPaused = join(root, 'main-build-paused')
  const releaseMainBuild = join(root, 'release-main-build')
  const configPath = join(root, 'electron.vite.config.ts')
  const config = (await readFile(configPath, 'utf8')).replace(
    'analysisBundles(),',
    `analysisBundles(),
      {
        name: 'hold-main-rebuild',
        async writeBundle() {
          const fs = await import('node:fs/promises')
          try { await fs.access(${JSON.stringify(holdMainBuild)}) } catch { return }
          await fs.writeFile(${JSON.stringify(mainBuildPaused)}, '')
          while (true) {
            try { await fs.access(${JSON.stringify(releaseMainBuild)}); return } catch {}
            await new Promise((done) => setTimeout(done, 50))
          }
        },
      },`,
  )
  assert.ok(config.includes("name: 'hold-main-rebuild'"))
  await writeFile(
    configPath,
    config.replace(
      "server: { host: '127.0.0.1' }",
      `server: { host: '127.0.0.1', fs: { allow: ${JSON.stringify([root, resolve('node_modules')])} } }`,
    ),
  )
  const cancelNextClose = join(root, 'cancel-next-close')
  const closePromptCanceled = join(root, 'close-prompt-canceled')
  const documentPath = join(root, 'src/main/document.ts')
  const documentSource = await readFile(documentPath, 'utf8')
  const documentImport =
    "import { app, type BrowserWindow, dialog } from 'electron'"
  assert.ok(documentSource.includes(documentImport))
  await writeFile(
    documentPath,
    documentSource.replace(
      documentImport,
      `${documentImport}
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'

const showMessageBox = dialog.showMessageBox.bind(dialog)
dialog.showMessageBox = (...args) => {
  const options = args.at(-1)
  if (options?.message?.startsWith('Save changes to ') && existsSync(${JSON.stringify(cancelNextClose)})) {
    unlinkSync(${JSON.stringify(cancelNextClose)})
    writeFileSync(${JSON.stringify(closePromptCanceled)}, '')
    return Promise.resolve({ response: 2, checkboxChecked: false })
  }
  return showMessageBox(...args)
}`,
    ),
  )
  const profile = join(root, 'profile')
  await mkdir(profile)
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'typing-speed': true }),
  )
  let output = ''
  const seenEndpoints = []
  const pendingLines = { stdout: '', stderr: '' }
  const child = spawn(
    process.execPath,
    [
      'scripts/dev.mjs',
      '--',
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      `--user-data-dir=${profile}`,
      ...(process.env.GITHUB_ACTIONS ? [] : ['--hibi-test']),
    ],
    {
      cwd: root,
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        REMOTE_DEBUGGING_PORT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const collect = (data, stream) => {
    const chunk = data.toString()
    output = (output + chunk).slice(-256000)
    const lines = (pendingLines[stream] + chunk).split(/\r?\n/)
    pendingLines[stream] = lines.pop()
    for (const line of lines) {
      const endpoint = line.match(/DevTools listening on (ws:\/\/\S+)/)?.[1]
      if (endpoint && !seenEndpoints.includes(endpoint))
        seenEndpoints.push(endpoint)
    }
  }
  child.stdout.on('data', (data) => collect(data, 'stdout'))
  child.stderr.on('data', (data) => collect(data, 'stderr'))
  let browser
  t.after(async () => {
    if (process.platform === 'win32') {
      await new Promise((done) =>
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f']).once(
          'close',
          done,
        ),
      )
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {}
    }
    if (child.exitCode === null && child.signalCode === null)
      await new Promise((done) => child.once('close', done))
    await browser?.close().catch(() => {})
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    })
  })
  async function until(predicate, label, timeout = 20000) {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      if (await predicate()) return
      await delay(100)
    }
    assert.fail(`${label}\n${output.slice(-2500)}`)
  }
  async function replace(file, before, after) {
    const path = join(root, file)
    const original = await readFile(path, 'utf8')
    assert.ok(original.includes(before), `${file}: marker exists`)
    await writeFile(path, original.replace(before, after))
  }
  await until(() => seenEndpoints.length > 0, 'dev app starts', 60000)
  browser = await chromium.connectOverCDP(seenEndpoints[0])
  let page = browser.contexts()[0].pages()[0]
  page.setDefaultTimeout(30000)
  await page.locator('[data-status-id="typing-speed.wpm"]').waitFor()
  assert.equal(
    await page.evaluate(
      async () =>
        (await window.hibi.getAddonStates()).find(
          (entry) => entry.id === 'diagnostics',
        ).enabled,
    ),
    true,
  )
  await page
    .getByRole('textbox', { name: 'Document editor', exact: true })
    .fill('unsaved watch draft')
  await waitForAsync(
    page,
    async () =>
      (await window.hibi.getDocument()).markdown === 'unsaved watch draft',
  )
  await replace(
    'src/renderer/src/Titlebar.tsx',
    'aria-label="Editor view"',
    'aria-label="Updated editor view"',
  )
  await page.getByRole('navigation', { name: 'Updated editor view' }).waitFor()
  mark('renderer component updated')
  const css = join(root, 'src/renderer/src/styles.css')
  await writeFile(
    css,
    `${await readFile(css, 'utf8')}\nbody { --dev-watch-probe: updated; }\n`,
  )
  await page.waitForFunction(
    () =>
      getComputedStyle(document.body)
        .getPropertyValue('--dev-watch-probe')
        .trim() === 'updated',
  )
  mark('renderer stylesheet updated')
  let viteReady = false
  const viteEvents = []
  const onViteSocket = (socket) => {
    if (!socket.url().includes('?token=')) return
    viteEvents.push(`created ${socket.url().split('?')[0]}`)
    socket.on('framereceived', ({ payload }) => {
      if (String(payload).includes('"type":"connected"')) {
        viteReady = true
        viteEvents.push('connected')
      }
    })
  }
  page.on('websocket', onViteSocket)
  await replace(
    'src/addons/typing-speed/index.ts',
    'This estimates how many words you type per minute.',
    'Updated typing speed runtime.',
  )
  await page.waitForFunction(() =>
    document
      .querySelector('[data-status-id="typing-speed.wpm"]')
      ?.getAttribute('data-tooltip')
      ?.startsWith('Updated typing speed runtime.'),
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'unsaved watch draft',
  )
  mark('addon runtime updated and draft retained')
  // The addon change reloads the page; a preload rebuild must reach its new Vite socket.
  await until(
    () => viteReady,
    'vite websocket reconnects after addon reload',
  ).catch((error) => {
    t.diagnostic(`vite websocket events: ${viteEvents.join(', ') || 'none'}`)
    throw error
  })
  page.off('websocket', onViteSocket)
  const preload = join(root, 'src/preload/index.ts')
  await writeFile(
    preload,
    `${await readFile(preload, 'utf8')}\ncontextBridge.exposeInMainWorld('devWatchProbe', 'updated')\n`,
  )
  await page
    .waitForFunction(() => window.devWatchProbe === 'updated')
    .catch((error) => {
      assert.fail(
        `preload did not update: ${error.message}\n${output.slice(-2500)}`,
      )
    })
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'unsaved watch draft',
  )
  const appUrl = page.url()
  for (const target of [
    'https://example.com/',
    new URL('/other.html', appUrl).href,
    `${appUrl}?other-page`,
  ]) {
    assert.equal(
      await page.evaluate(
        (url) =>
          new Promise((done) => {
            location.href = url
            setTimeout(() => done(location.href), 100)
          }),
        target,
      ),
      appUrl,
    )
  }
  mark('preload updated, draft retained, other navigation blocked')
  await page.evaluate(() => window.hibi.setAddonEnabled('diagnostics', false))
  await page.reload()
  assert.equal(
    await page.evaluate(
      async () =>
        (await window.hibi.getAddonStates()).find(
          (entry) => entry.id === 'diagnostics',
        ).enabled,
    ),
    false,
  )
  async function clearDraft(expected) {
    await page.waitForFunction(
      (expected) =>
        document.querySelector('[role="textbox"][aria-label="Document editor"]')
          ?.textContent === expected,
      expected,
    )
    const editor = page.getByRole('textbox', {
      name: 'Document editor',
      exact: true,
    })
    await editor.fill('')
    await page.evaluate(() => window.hibi.flushDocumentChanges())
    try {
      await waitForAsync(page, async () => {
        const document = await window.hibi.getDocument()
        return (
          document.markdown === '' &&
          !document.dirty &&
          document.tabs.every((tab) => !tab.dirty)
        )
      })
    } catch (error) {
      const state = await page.evaluate(async () => {
        const editor = document.querySelector(
          '[role="textbox"][aria-label="Document editor"]',
        )
        return {
          native: await window.hibi.getDocument(),
          editor: {
            text: editor?.textContent,
            html: editor?.innerHTML,
            contenteditable: editor?.getAttribute('contenteditable'),
            readonly: editor?.getAttribute('aria-readonly'),
          },
          sourceReady: document
            .querySelector('.editor-panes')
            ?.getAttribute('data-source-ready'),
          notices: [...document.querySelectorAll('.document-notice')].map(
            (notice) => notice.textContent,
          ),
        }
      })
      assert.fail(
        `draft did not clear: ${error.message}\n${JSON.stringify(state)}`,
      )
    }
  }
  // Main rebuild restarts Electron; close the draft without a discard prompt.
  await clearDraft('unsaved watch draft')
  async function connectRestartedPage(previousStarts) {
    await until(
      () => seenEndpoints.length > previousStarts,
      'main process restarts after rebuild',
      60000,
    ).catch(() => {
      assert.fail(
        `main process did not restart; ${seenEndpoints.length} devtools endpoints seen\n${output.slice(-2500)}`,
      )
    })
    let lastCdpError
    await until(
      async () => {
        try {
          browser = await chromium.connectOverCDP(seenEndpoints.at(-1), {
            timeout: 1000,
          })
          return true
        } catch (error) {
          lastCdpError = error
          return false
        }
      },
      'restarted devtools is available',
      15000,
    ).catch(() => {
      assert.fail(
        `restarted devtools is unavailable: ${lastCdpError instanceof Error ? lastCdpError.message : String(lastCdpError)}\n${output.slice(-1000)}`,
      )
    })
    await until(
      () => browser.contexts()[0]?.pages()[0],
      'restarted app opens a page',
    )
    page = browser.contexts()[0].pages()[0]
    await page.waitForFunction(() => Boolean(window.hibi))
  }
  const initialStarts = seenEndpoints.length
  await writeFile(holdMainBuild, '')
  await replace(
    'src/main/imports.ts',
    "instructions: '',",
    "instructions: 'Updated folder importer.',",
  )
  await until(
    () =>
      access(mainBuildPaused).then(
        () => true,
        () => false,
      ),
    'main rebuild writes output before restart',
    60000,
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.listImporters())).find(
      (importer) => importer.id === 'folder',
    ).instructions,
    '',
    'running main process still loads its original importer chunk',
  )
  await writeFile(releaseMainBuild, '')
  await connectRestartedPage(initialStarts)
  assert.equal(
    (await page.evaluate(() => window.hibi.listImporters())).find(
      (importer) => importer.id === 'folder',
    ).instructions,
    'Updated folder importer.',
  )
  mark('main rebuild keeps old importer code until restart')

  await page
    .getByRole('textbox', { name: 'Document editor', exact: true })
    .fill('draft protected from restart')
  await waitForAsync(page, async () => {
    const document = await window.hibi.getDocument()
    return (
      document.markdown === 'draft protected from restart' &&
      document.dirty &&
      document.tabs.some((tab) => tab.dirty)
    )
  })
  const canceledStarts = seenEndpoints.length
  await writeFile(cancelNextClose, '')
  await replace(
    'src/main/imports.ts',
    "instructions: 'Updated folder importer.',",
    "instructions: 'Canceled rebuild importer.',",
  )
  await until(
    () =>
      access(closePromptCanceled).then(
        () => true,
        () => false,
      ),
    'save prompt canceled on dev restart',
    60000,
  )
  await until(
    () => output.includes('electron restart canceled; keeping current app'),
    'watcher acknowledges canceled restart',
    60000,
  )
  assert.equal(seenEndpoints.length, canceledStarts)
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'draft protected from restart',
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.listImporters())).find(
      (importer) => importer.id === 'folder',
    ).instructions,
    'Updated folder importer.',
  )
  mark('canceled restart keeps running app and dirty draft')

  await clearDraft('draft protected from restart')
  await replace(
    'src/main/imports.ts',
    "instructions: 'Canceled rebuild importer.',",
    "instructions: 'Latest folder importer.',",
  )
  await connectRestartedPage(canceledStarts)
  assert.equal(
    (await page.evaluate(() => window.hibi.listImporters())).find(
      (importer) => importer.id === 'folder',
    ).instructions,
    'Latest folder importer.',
  )
  mark('clean rebuild restarts after earlier cancellation')

  await replace('scripts/addon-reference.mjs', '[Source]', '[Updated source]')
  await until(
    async () =>
      (
        await readFile(
          join(root, 'docs/development/addon-api-reference/Sidebar.md'),
          'utf8',
        )
      ).includes('[Updated source]'),
    'documentation generator reloads',
  )
  mark('documentation generator updated')
})
