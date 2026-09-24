import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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
import { build } from 'esbuild'
import { parse } from 'yaml'
import { platforms } from '../scripts/nightly.mjs'
import { updateFeed } from '../scripts/update-feed.mjs'
import {
  newerUpdate,
  updateChannel,
  updateCheckFrequency,
  updateRelease,
} from '../src/shared/updates.ts'
import { electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

const version = '0.1.0-nightly.20260921.gaaaaaaa.15.1'
const tag = 'nightly-2026-09-21-aaaaaaa-15-1'
const bytes = Buffer.from('a verified installer')
const sha512 = createHash('sha512').update(bytes).digest('base64')
const manifest = (broken = false) => ({
  tag: broken ? tag.replace('nightly-', 'nightly-broken-') : tag,
  version,
  status: broken ? 'nightly-broken' : 'nightly-green',
  assets: Object.fromEntries(
    [
      ['win32-x64', 'win-x64.exe'],
      ['linux-x64', 'linux-x86_64.AppImage'],
      ['darwin-arm64', 'mac-arm64.dmg'],
      ['darwin-x64', 'mac-x64.dmg'],
    ].map(([platform, suffix]) => [
      platform,
      {
        name: `hibi-${version}-${suffix}`,
        sha512,
        size: bytes.length,
        ...(platform.startsWith('darwin-') && {
          zip: {
            name: `hibi-${version}-mac-${platform.slice(7)}.zip`,
            sha512,
            size: bytes.length,
          },
        }),
      },
    ]),
  ),
})

test('channels fail closed and nightly ordering uses numeric runs rather than commit hashes', () => {
  assert.equal(updateChannel('nightly'), 'nightly')
  for (const input of ['stable', 'https://evil.invalid', null, {}, 1])
    assert.throws(() => updateChannel(input))
  for (const input of [0, 2, '6', null])
    assert.throws(() => updateCheckFrequency(input))
  assert.equal(updateCheckFrequency(24), 24)
  assert.equal(updateRelease(manifest(), 'nightly-green').version, version)
  assert.equal(
    updateRelease(manifest(true), 'nightly').status,
    'nightly-broken',
  )
  assert.throws(() => updateRelease(manifest(true), 'nightly-green'))
  for (const patch of [
    { tag: '../../evil' },
    { version: '../package' },
    { status: 'stable' },
    {
      assets: {
        'darwin-x64': {
          ...manifest().assets['darwin-x64'],
          name: '../evil.dmg',
        },
      },
    },
    {
      assets: {
        'darwin-x64': { ...manifest().assets['darwin-x64'], sha512: 'missing' },
      },
    },
    {
      assets: {
        'darwin-x64': { ...manifest().assets['darwin-x64'], size: -1 },
      },
    },
    {
      assets: {
        'darwin-x64': {
          ...manifest().assets['darwin-x64'],
          zip: { ...manifest().assets['darwin-x64'].zip, name: '../evil.zip' },
        },
      },
    },
  ])
    assert.throws(() => updateRelease({ ...manifest(), ...patch }, 'nightly'))
  assert.ok(newerUpdate(version, '0.1.0-nightly.20260921.gfffffff.14.9'))
  assert.ok(newerUpdate(version, '0.1.0-nightly.20260920.gfffffff.99.9'))
  assert.ok(newerUpdate(version, '0.1.0-nightly.20260921.fffffff'))
  assert.ok(newerUpdate(version, '0.1.0'))
  assert.ok(!newerUpdate(version, version))
  assert.ok(!newerUpdate(version, '0.1.0-nightly.20260921.g0000000.16.1'))
  assert.ok(!newerUpdate(version, '0.2.0'))
  assert.ok(!newerUpdate(version, 'invalid'))
})

test('publication hashes real installers and keeps both feeds pinned to a complete classified release', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-feed-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const asset of Object.values(manifest().assets)) {
    await writeFile(join(root, asset.name), bytes)
    if (asset.zip) await writeFile(join(root, asset.zip.name), bytes)
  }
  const reports = platforms.map((platform) => ({
    platform,
    sha: 'a'.repeat(40),
    build: 'success',
    package: 'success',
    checks: 'success',
  }))
  for (const broken of [false, true]) {
    const release = {
      ...manifest(broken),
      channel: 'nightly',
      sha: 'a'.repeat(40),
      reports: reports.map((report, i) => ({
        ...report,
        checks: broken && !i ? 'failure' : 'success',
      })),
    }
    const generated = await updateFeed(release, root)
    const expected = manifest(broken)
    expected.assets['linux-x64'].name = `hibi-${version}-linux-x64.AppImage`
    assert.deepEqual(generated, expected)
    assert.deepEqual(
      await readFile(join(root, expected.assets['linux-x64'].name)),
      bytes,
    )
    assert.ok(
      !(await readdir(root)).includes(manifest().assets['linux-x64'].name),
    )
    assert.deepEqual(updateRelease(generated, 'nightly'), generated)
    if (!broken)
      assert.deepEqual(updateRelease(generated, 'nightly-green'), generated)
    for (const [platform, name] of [
      ['win32-x64', 'latest.yml'],
      ['linux-x64', 'latest-linux.yml'],
    ]) {
      const feed = parse(await readFile(join(root, name), 'utf8'))
      assert.equal(feed.version, version)
      assert.deepEqual(feed.files, [
        { url: expected.assets[platform].name, sha512, size: bytes.length },
      ])
    }
    const macFeed = parse(await readFile(join(root, 'latest-mac.yml'), 'utf8'))
    assert.equal(macFeed.version, version)
    assert.deepEqual(macFeed.files, [
      {
        url: expected.assets['darwin-x64'].zip.name,
        sha512,
        size: bytes.length,
      },
      {
        url: expected.assets['darwin-arm64'].zip.name,
        sha512,
        size: bytes.length,
      },
    ])
  }
  await assert.rejects(
    updateFeed(
      {
        ...manifest(),
        channel: 'nightly',
        sha: 'a'.repeat(40),
        reports: reports.slice(1),
      },
      root,
    ),
    /Every release platform/,
  )
  const workflow = parse(
    await readFile('.github/workflows/nightly.yml', 'utf8'),
  )
  const steps = workflow.jobs.publish.steps
  assert.ok(
    steps.findIndex((step) => step.name === 'Generate verified update feeds') <
      steps.findIndex((step) => step.id === 'publish'),
  )
  const green = steps.find(
    (step) => step.name === 'Update recommended nightly pointer',
  )
  assert.equal(green.if, "steps.classify.outputs.status == 'nightly-green'")
  assert.match(
    green.run,
    /gh release upload nightly-green installers\/update.json/,
  )
  const all = steps.find((step) => step.name === 'Update all-nightlies feed')
  assert.equal(all.if, "needs.prepare.outputs.channel == 'nightly'")
  assert.ok(
    steps.indexOf(all) <
      steps.findIndex((step) => step.name === 'Surface broken nightly checks'),
  )
})

async function adapter(t, platform = 'darwin', arch = 'x64', packaged = true) {
  const root = await mkdtemp(join(tmpdir(), 'hibi-updater-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const output = join(root, 'updates.mjs')
  await build({
    stdin: {
      contents: `export * from './src/main/updates.ts'; export { state as mock } from 'electron';`,
      resolveDir: resolve('.'),
    },
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    define: {
      'process.platform': JSON.stringify(platform),
      'process.arch': JSON.stringify(arch),
      'process.env.APPIMAGE': JSON.stringify('/tmp/hibi.AppImage'),
    },
    plugins: [
      {
        name: 'update-host',
        setup(build) {
          build.onResolve(
            { filter: /^(electron|electron-updater)$/ },
            ({ path }) => ({ path, namespace: 'mock' }),
          )
          build.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({
            contents:
              path === 'electron'
                ? `
        export const state = { requests: [], events: [], quit: 0, packaged: ${packaged}, version: '0.1.0', response: undefined, installs: 0, downloads: 0, listeners: {}, failInstall: false };
        export const app = { get isPackaged() { return state.packaged }, getPath: () => ${JSON.stringify(root)}, getVersion: () => state.version, quit: () => { state.quit++ } };
        export const BrowserWindow = { getAllWindows: () => [{ webContents: { send: (...args) => state.events.push(args) } }] };
        export const net = { fetch: async (url) => { state.requests.push(url); if (state.wait) await state.wait; if (state.error) throw new Error('offline'); return new Response(JSON.stringify(state.response), { status: state.http ?? 200 }); } };
      `
                : `
        import { state } from 'electron';
        const autoUpdater = { on: (event, callback) => { state.listeners[event] = callback }, setFeedURL: (feed) => { state.feed = feed },
          checkForUpdates: async () => {
            const assets = state.response.assets;
            const selected = ${platform === 'darwin' ? "[assets['darwin-arm64'].zip, assets['darwin-x64'].zip]" : `[assets[${JSON.stringify(`${platform}-${arch}`)}]]`};
            const files = selected.map((asset) => ({ url: asset.name, sha512: asset.sha512, size: asset.size }));
            if (state.badMetadata) files[0].sha512 = 'wrong';
            return { isUpdateAvailable: true, updateInfo: { version: state.response.version, files } };
          },
          downloadUpdate: async () => { state.downloads++; state.listeners['download-progress']({ percent: 50 }); if(state.failDownload) throw new Error('download failed'); return ['/tmp/update']; },
          quitAndInstall: () => { if (state.failInstall) state.listeners.error(new Error('install failed')); else state.installs++ }
        }; state.client = autoUpdater; export default { autoUpdater };
      `,
          }))
        },
      },
    ],
  })
  const manager = await import(pathToFileURL(output).href)
  manager.mock.response = manifest()
  await manager.loadUpdates()
  return { ...manager, root }
}

test('mac pins both signed ZIPs, installs after close confirmation, and persists channel choice', async (t) => {
  const manager = await adapter(t, 'darwin', 'arm64')
  const { mock } = manager
  assert.equal(manager.getUpdateState().channel, 'nightly-green')
  assert.equal((await manager.checkForUpdates()).status, 'available')
  assert.equal(
    manager.getUpdateState().message,
    `An update is available: ${version}`,
  )
  assert.match(mock.requests[0], /nightly-green\/update.json$/)
  mock.badMetadata = true
  assert.equal((await manager.downloadUpdate()).status, 'error')
  assert.match(manager.getUpdateState().message, /metadata changed/)
  assert.equal(mock.downloads, 0)
  await assert.rejects(manager.installUpdate(), /Download an update/)
  mock.badMetadata = false
  assert.equal((await manager.downloadUpdate()).status, 'downloaded')
  assert.equal(
    manager.getUpdateState().message,
    `An update is available: ${version}`,
  )
  assert.match(mock.feed.url, new RegExp(`${tag}/$`))
  assert.equal(mock.downloads, 1)
  await manager.setUpdateChannel('nightly')
  assert.equal(manager.getUpdateState().version, undefined)
  await assert.rejects(manager.installUpdate())
  assert.equal(
    JSON.parse(
      await readFile(join(manager.root, 'update-channel.json'), 'utf8'),
    ),
    'nightly',
  )
  await manager.loadUpdates()
  assert.equal(manager.getUpdateState().channel, 'nightly')
  mock.response = manifest(true)
  assert.equal((await manager.checkForUpdates()).broken, true)
  assert.match(mock.requests.at(-1), /\/nightly\/update.json$/)
  await manager.setUpdateChannel('nightly-green')
  assert.equal((await manager.checkForUpdates()).status, 'error')

  const install = await adapter(t, 'darwin', 'x64')
  let failedInstall = 0
  install.onUpdateInstallFailure(() => failedInstall++)
  await install.checkForUpdates()
  assert.equal((await install.downloadUpdate()).status, 'downloaded')
  await install.installUpdate()
  assert.equal(install.mock.quit, 1)
  install.cancelUpdateInstall()
  assert.equal(install.finishUpdateInstall(), undefined)
  await install.installUpdate()
  assert.equal(install.finishUpdateInstall(), true)
  assert.equal(install.mock.installs, 1)
  install.mock.listeners.error(new Error('late install failure'))
  assert.equal(failedInstall, 1)
  assert.equal(install.getUpdateState().status, 'error')
  assert.equal((await install.downloadUpdate()).status, 'downloaded')
})

test('checks handle missing feeds, offline failures, concurrent actions, and installed versions without downgrading', async (t) => {
  const manager = await adapter(t)
  manager.mock.http = 404
  assert.match(
    (await manager.checkForUpdates()).message,
    /No build is available/,
  )
  manager.mock.http = 200
  manager.mock.error = true
  assert.equal((await manager.checkForUpdates()).status, 'error')
  manager.mock.error = false
  let resume
  manager.mock.wait = new Promise((resolve) => {
    resume = resolve
  })
  const checking = manager.checkForUpdates()
  await assert.rejects(manager.setUpdateChannel('nightly'), /Wait for/)
  await assert.rejects(manager.checkForUpdates(), /Wait for/)
  resume()
  await checking
  manager.mock.version = '0.2.0'
  assert.equal((await manager.checkForUpdates()).status, 'idle')
  assert.equal(manager.getUpdateState().version, undefined)
  const development = await adapter(t, 'darwin', 'x64', false)
  development.startUpdateChecks()
  assert.equal((await development.checkForUpdates()).status, 'error')
  assert.equal(development.mock.requests.length, 0)
})

test('startup and frequency choices persist and reschedule checks', async (t) => {
  const manager = await adapter(t, 'win32')
  assert.equal(manager.getUpdateState().checkOnStartup, true)
  assert.equal(manager.getUpdateState().checkFrequency, 6)
  assert.throws(() => manager.setUpdateStartupCheck('false'), /startup/)
  assert.throws(() => manager.setUpdateCheckFrequency('12'), /frequency/)
  await manager.setUpdateStartupCheck(false)
  assert.equal(manager.getUpdateState().checkOnStartup, false)
  assert.equal(
    JSON.parse(
      await readFile(join(manager.root, 'update-startup-check.json'), 'utf8'),
    ),
    false,
  )
  await manager.loadUpdates()
  assert.equal(manager.getUpdateState().checkOnStartup, false)

  const scheduled = []
  const cleared = []
  const originalTimeout = globalThis.setTimeout
  const originalInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  try {
    globalThis.setTimeout = (callback, delay) => {
      scheduled.push({ callback, delay })
      return { unref() {} }
    }
    globalThis.setInterval = (callback, delay) => {
      const timer = { unref() {} }
      scheduled.push({ callback, delay, timer })
      return timer
    }
    globalThis.clearInterval = (timer) => cleared.push(timer)
    manager.startUpdateChecks()
    await manager.setUpdateCheckFrequency(12)
  } finally {
    globalThis.setTimeout = originalTimeout
    globalThis.setInterval = originalInterval
    globalThis.clearInterval = originalClearInterval
  }
  assert.deepEqual(
    scheduled.map(({ delay }) => delay),
    [15_000, 6 * 60 * 60 * 1000, 12 * 60 * 60 * 1000],
  )
  assert.deepEqual(cleared, [scheduled[1].timer])
  assert.equal(manager.getUpdateState().checkFrequency, 12)
  assert.equal(
    JSON.parse(
      await readFile(join(manager.root, 'update-check-frequency.json'), 'utf8'),
    ),
    12,
  )
  await manager.loadUpdates()
  assert.equal(manager.getUpdateState().checkFrequency, 12)
  manager.mock.version = version
  scheduled[0].callback()
  assert.equal(manager.mock.requests.length, 0)
  scheduled[2].callback()
  await new Promise(setImmediate)
  assert.equal(manager.mock.requests.length, 1)
  assert.equal(manager.getUpdateState().status, 'idle')

  await manager.setUpdateStartupCheck(true)
  scheduled[0].callback()
  await new Promise(setImmediate)
  assert.equal(manager.mock.requests.length, 2)
  assert.equal(manager.getUpdateState().checkOnStartup, true)
})

test('windows and linux pin downloads and install only after close confirmation; cancellation and errors keep protection', async (t) => {
  for (const platform of ['win32', 'linux']) {
    const manager = await adapter(t, platform)
    await manager.checkForUpdates()
    manager.mock.failDownload = true
    assert.equal((await manager.downloadUpdate()).status, 'error')
    manager.mock.failDownload = false
    assert.equal((await manager.downloadUpdate()).status, 'downloaded')
    assert.match(manager.mock.feed.url, new RegExp(`${tag}/$`))
    assert.equal(manager.mock.client.autoInstallOnAppQuit, false)
    assert.equal(manager.mock.installs, 0)
    await manager.installUpdate()
    assert.equal(manager.mock.quit, 1)
    assert.equal(manager.mock.installs, 0)
    manager.cancelUpdateInstall()
    assert.equal(manager.finishUpdateInstall(), undefined)
    assert.equal(manager.mock.installs, 0)
    await manager.installUpdate()
    manager.mock.failInstall = true
    assert.equal(manager.finishUpdateInstall(), false)
    assert.equal(manager.getUpdateState().status, 'error')
    manager.mock.failInstall = false
    await manager.downloadUpdate()
    await manager.installUpdate()
    assert.equal(manager.finishUpdateInstall(), true)
    assert.equal(manager.mock.installs, 1)
  }
})

test('update settings expose both channels, persist choice, and fit narrow windows', {
  timeout: 45000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-update-ui-'))
  let app
  t.after(async () => {
    await app?.close()
    await rm(profile, { recursive: true, force: true })
  })
  for (const expected of ['nightly-green', 'nightly']) {
    app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${profile}`],
    })
    const page = await app.firstWindow()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await clickMenu(app, 'Settings')
    await page.getByRole('tab', { name: 'About', exact: true }).click()
    const picker = page.getByLabel('Update channel', { exact: true })
    await picker.waitFor()
    await page.waitForFunction(
      () => !document.querySelector('#update-channel').disabled,
    )
    assert.equal(await picker.inputValue(), expected)
    const frequency = page.getByLabel('Check frequency', { exact: true })
    assert.equal(
      await frequency.inputValue(),
      expected === 'nightly' ? '12' : '6',
    )
    const startup = page.getByRole('checkbox', {
      name: 'Check for updates on startup',
    })
    assert.equal(await startup.isChecked(), expected === 'nightly-green')
    if (expected === 'nightly') {
      assert.deepEqual(errors, [])
      await app.close()
      app = undefined
      continue
    }
    assert.deepEqual(await picker.locator('option').allTextContents(), [
      'Recommended nightly',
      'Nightly',
    ])
    await assert.rejects(
      page.evaluate(() => window.hibi.setUpdateChannel('https://evil.invalid')),
      /valid update channel/,
    )
    await assert.rejects(
      page.evaluate(() => window.hibi.setUpdateStartupCheck('false')),
      /startup/,
    )
    await assert.rejects(
      page.evaluate(() => window.hibi.setUpdateCheckFrequency(2)),
      /frequency/,
    )
    await frequency.selectOption('12')
    await page.waitForFunction(
      async () => (await window.hibi.getUpdateState()).checkFrequency === 12,
    )
    await startup.uncheck()
    await page.waitForFunction(
      async () => !(await window.hibi.getUpdateState()).checkOnStartup,
    )
    await page.waitForFunction(
      () => !document.querySelector('#update-startup-check').checked,
    )
    assert.equal(await startup.isChecked(), false)
    await picker.selectOption('nightly')
    await page.waitForFunction(
      async () => (await window.hibi.getUpdateState()).channel === 'nightly',
    )
    assert.equal(
      await page
        .getByRole('button', { name: 'Check for updates', exact: true })
        .isDisabled(),
      true,
    )
    const showUpdate = (status, progress, broken = false) =>
      app.evaluate(
        ({ BrowserWindow }, update) => {
          BrowserWindow.getAllWindows()[0].webContents.send(
            'updates:changed',
            update,
          )
        },
        {
          channel: 'nightly',
          status,
          supported: true,
          checkOnStartup: false,
          version,
          broken,
          progress,
          message: `An update is available: ${version}`,
        },
      )
    await showUpdate('available', 0)
    await page
      .locator('#install-update-description')
      .getByText(`An update is available: ${version}`, { exact: true })
      .waitFor()
    await showUpdate('downloading', 50)
    const download = page.getByRole('button', {
      name: 'Downloading 50%',
      exact: true,
    })
    await download.waitFor()
    assert.equal(await download.isDisabled(), true)
    assert.equal(
      await download.evaluate((element) =>
        getComputedStyle(element).backgroundImage.includes('50%'),
      ),
      true,
    )
    assert.equal(
      await page.locator('#install-update-description').textContent(),
      `An update is available: ${version}`,
    )
    assert.equal(await picker.isDisabled(), true)
    assert.equal(await startup.isDisabled(), true)
    for (const width of [480, 1000]) {
      await page.setViewportSize({ width, height: 760 })
      await mkdir('test-results', { recursive: true })
      await page.screenshot({
        path: `test-results/update-downloading-${width}.png`,
        animations: 'disabled',
      })
    }
    await showUpdate('downloading', 75)
    await page
      .getByRole('button', { name: 'Downloading 75%', exact: true })
      .waitFor()
    await showUpdate('downloaded', 100)
    await page
      .getByRole('button', { name: 'Restart and install', exact: true })
      .waitFor()
    await showUpdate('available', 0, true)
    await page
      .getByRole('button', { name: 'Download update', exact: true })
      .waitFor()
    await page
      .getByRole('status')
      .filter({ hasText: 'failed required checks' })
      .waitFor()
    for (const width of [480, 1000]) {
      await page.setViewportSize({ width, height: 760 })
      await picker.scrollIntoViewIfNeeded()
      const panel = page.getByRole('tabpanel', { name: 'About', exact: true })
      assert.equal(
        await panel.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
        true,
      )
      await mkdir('test-results', { recursive: true })
      await page.screenshot({
        path: `test-results/update-settings-${width}.png`,
        animations: 'disabled',
      })
    }
    assert.deepEqual(errors, [])
    await app.close()
    app = undefined
  }
})
