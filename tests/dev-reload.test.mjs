import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
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

test('development watches renderer, preload, addons, and documentation generation', {
  timeout: 180000,
}, async (t) => {
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
  const configPath = join(root, 'electron.vite.config.ts')
  await writeFile(
    configPath,
    (await readFile(configPath, 'utf8')).replace(
      "server: { host: '127.0.0.1' }",
      `server: { host: '127.0.0.1', fs: { allow: ${JSON.stringify([root, resolve('node_modules')])} } }`,
    ),
  )
  const profile = join(root, 'profile')
  await mkdir(profile)
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'typing-speed': true }),
  )
  let output = ''
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
  const collect = (data) => {
    output = (output + data.toString()).slice(-256000)
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
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
  await until(
    () => /DevTools listening on (ws:\/\/\S+)/.test(output),
    'dev app starts',
    60000,
  )
  browser = await chromium.connectOverCDP(
    output.match(/DevTools listening on (ws:\/\/\S+)/)[1],
  )
  const page = browser.contexts()[0].pages()[0]
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
  await page.waitForFunction(
    async () =>
      (await window.hibi.getDocument()).markdown === 'unsaved watch draft',
  )
  await replace(
    'src/renderer/src/Titlebar.tsx',
    'aria-label="Editor view"',
    'aria-label="Updated editor view"',
  )
  await page.getByRole('navigation', { name: 'Updated editor view' }).waitFor()
  t.diagnostic('renderer component updated')
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
  t.diagnostic('renderer stylesheet updated')
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
  t.diagnostic('addon runtime updated and draft retained')
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
  t.diagnostic('preload updated, draft retained, other navigation blocked')
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
  t.diagnostic('documentation generator updated')
})
