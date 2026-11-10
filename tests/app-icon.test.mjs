import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { readAppIcon } from '../src/shared/app-icon.ts'
import { electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

/** Runs before Hibi's main script: records every icon Hibi shows and stubs the file dialog. */
function install({ app, BrowserWindow, dialog }) {
  globalThis.iconCalls = []
  globalThis.nextIcon = null
  const encode = (icon) =>
    typeof icon === 'string' ? icon : icon.toPNG().toString('base64')
  const shown = () =>
    BrowserWindow.getAllWindows().some((window) => window.isVisible())
  if (app.dock) {
    const setIcon = app.dock.setIcon.bind(app.dock)
    app.dock.setIcon = (image) => {
      globalThis.iconCalls.push({ icon: encode(image), shown: shown() })
      setIcon(image)
    }
  } else {
    const { setIcon } = BrowserWindow.prototype
    BrowserWindow.prototype.setIcon = function (icon) {
      globalThis.iconCalls.push({ icon: encode(icon), window: this.id })
      return setIcon.call(this, icon)
    }
  }
  dialog.showOpenDialog = async () =>
    globalThis.nextIcon
      ? { canceled: false, filePaths: [globalThis.nextIcon] }
      : { canceled: true, filePaths: [] }
}

test('the app icon persists, shows before the first window, imports a custom image and resets', {
  timeout: 180000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-app-icon-'))
  const files = await mkdtemp(join(tmpdir(), 'hibi-app-icon-files-'))
  const hook = join(profile, 'icon-hook.cjs')
  await writeFile(hook, `(${install})(require('electron'))`)
  let app
  t.after(async () => {
    await app?.close()
    await rm(profile, { recursive: true, force: true })
    await rm(files, { recursive: true, force: true })
  })
  const mac = process.platform === 'darwin'
  const launch = async () => {
    app = await electron.launch({
      args: ['--require', hook, resolve('.'), `--user-data-dir=${profile}`],
    })
    const page = await app.firstWindow()
    await clickMenu(app, 'Settings')
    await page.getByRole('tab', { name: 'Appearance', exact: true }).click()
    const select = page.getByRole('combobox', { name: 'App icon', exact: true })
    await page.waitForFunction(
      () => document.querySelector('#app-icon')?.disabled === false,
    )
    return { page, select }
  }
  const calls = () => app.evaluate(() => globalThis.iconCalls.splice(0))
  /** What Hibi passes to the Dock (macOS) or each window (elsewhere) for a bundled icon. */
  const bundled = (dark) =>
    app.evaluate(({ app, nativeImage }, dark) => {
      const platform =
        process.platform === 'darwin'
          ? 'mac'
          : process.platform === 'win32'
            ? 'win'
            : 'linux'
      const path = `${app.getAppPath()}/build/icon-${platform}${dark ? '-dark' : ''}.png`
      return process.platform === 'darwin'
        ? nativeImage
            .createFromPath(path)
            .resize({ width: 256, height: 256 })
            .toPNG()
            .toString('base64')
        : path
    }, dark)
  const stored = () =>
    app.evaluate(({ app, nativeImage }) => {
      const image = nativeImage.createFromPath(
        `${app.getPath('userData')}/app-icon.png`,
      )
      return { png: image.toPNG().toString('base64'), size: image.getSize() }
    })
  const lastIcon = async () => (await calls()).at(-1)?.icon
  // A save marks the select busy within the event that starts it.
  const idle = (page) =>
    page.waitForFunction(
      () =>
        document.querySelector('#app-icon')?.getAttribute('aria-busy') ===
        'false',
    )
  const focused = () => page.evaluate(() => document.activeElement?.id)
  const pick = (file) =>
    app.evaluate((_, file) => {
      globalThis.nextIcon = file
    }, file)
  const preference = async () =>
    JSON.parse(await readFile(join(profile, 'app-icon.json'), 'utf8'))
  const exists = (path) =>
    access(path).then(
      () => true,
      () => false,
    )

  let { page, select } = await launch()
  if (mac) {
    // A development build replaces Electron's icon before any window shows.
    const startup = await calls()
    assert.equal(startup.length, 1)
    assert.equal(startup[0].shown, false)
  } else await calls()
  assert.equal(await select.inputValue(), 'app')
  for (const value of [null, 'sepia', {}, ['dark']])
    await assert.rejects(
      page.evaluate((value) => window.hibi.setAppIcon(value), value),
      /Invalid app icon setting/,
    )
  await assert.rejects(
    page.evaluate(() => window.hibi.setAppIcon('custom')),
    /Choose an image for the app icon first/,
  )

  // Start with the icon the launch did not show, so each choice changes it.
  const modes = (await app.evaluate(
    ({ nativeTheme }) => nativeTheme.shouldUseDarkColors,
  ))
    ? ['light', 'dark']
    : ['dark', 'light']
  const kept = modes[1]
  // The select stays usable while a choice saves, so keyboard focus stays on it.
  await select.focus()
  for (const mode of modes) {
    await select.selectOption(mode)
    await idle(page)
    assert.equal(await focused(), 'app-icon', mode)
    assert.equal(await lastIcon(), await bundled(mode === 'dark'))
    assert.deepEqual(await preference(), { mode })
  }

  // Canceling the dialog keeps the current icon.
  await select.selectOption('custom')
  await idle(page)
  assert.equal(await select.inputValue(), kept)
  assert.equal(await focused(), 'app-icon')
  assert.deepEqual(await calls(), [])
  if (process.platform === 'linux') {
    // Linux reports only the appearance Hibi sets, so Follow system is not offered.
    assert.equal(await select.locator('option[value="system"]').count(), 0)
    await assert.rejects(
      page.evaluate(() => window.hibi.setAppIcon('system')),
      /Invalid app icon setting/,
    )
  }

  const header = Buffer.alloc(33)
  Buffer.from('\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR', 'latin1').copy(header)
  header.writeUInt32BE(5000, 16)
  header.writeUInt32BE(5000, 20)
  const bad = [
    ['notes.png', 'not an image', /PNG, ICNS, ICO or SVG/],
    ['huge.png', header, /up to 4096 by 4096 pixels/],
    ['large.png', Buffer.alloc(8 * 1024 * 1024 + 1), /smaller than 8 MB/],
    [
      'remote.svg',
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/a.png"/></svg>',
      /content Hibi doesn't accept/,
    ],
    // Quick Look would draw a stock document icon for these; Hibi reads them itself.
    ['empty.icns', Buffer.from('icns\0\0\0\x08', 'latin1'), /ICNS has no PNG/],
    [
      'empty.ico',
      Buffer.from([0, 0, 1, 0, 1, 0, ...Array(16).fill(0)]),
      /ICO has no PNG/,
    ],
    ...(mac
      ? []
      : [
          [
            'clean.svg',
            await readFile('build/tray-tile.svg'),
            /SVG images can't be the app icon on this system/,
          ],
        ]),
  ]
  for (const [name, content, error] of bad) {
    const file = join(files, name)
    await writeFile(file, content)
    await pick(file)
    await select.selectOption('custom')
    await idle(page)
    const notice = page.locator('.document-notice', {
      hasText: 'App icon unavailable',
    })
    assert.match(await notice.textContent(), error, name)
    assert.equal(await select.inputValue(), kept, name)
    assert.equal(await exists(join(profile, 'app-icon.png')), false, name)
  }
  assert.deepEqual(await calls(), [])

  const choices = mac
    ? [
        // macOS draws a checked SVG through Quick Look.
        ['icon.svg', await readFile('build/tray-tile.svg')],
        ['icon.icns', await readFile('build/icon.icns')],
        ['icon.png', await readFile('build/icon-mac-dark.png')],
      ]
    : [
        ['icon.icns', await readFile('build/icon.icns')],
        [
          'icon.png',
          await readFile(
            `build/icon-${process.platform === 'win32' ? 'win' : 'linux'}-dark.png`,
          ),
        ],
      ]
  for (const [index, [name, content]] of choices.entries()) {
    const file = join(files, name)
    await writeFile(file, content)
    await pick(file)
    if (index === 0) await select.selectOption('custom')
    else
      await page
        .getByRole('button', { name: 'Choose image…', exact: true })
        .click()
    await idle(page)
    await page
      .getByRole('img', { name: 'Custom app icon preview', exact: true })
      .waitFor()
    if (index === 0) assert.equal(await focused(), 'app-icon', name)
    else
      assert.equal(
        await page.evaluate(() => document.activeElement?.textContent),
        'Choose image…',
        name,
      )
    assert.equal(await select.inputValue(), 'custom')
    assert.deepEqual(await preference(), { mode: 'custom' })
    const { png, size } = await stored()
    if (name === 'icon.icns')
      // Drawn from the widest PNG inside the file, not a thumbnail of it.
      assert.equal(
        png,
        await app.evaluate(
          ({ nativeImage }, embedded) =>
            nativeImage
              .createFromBuffer(Buffer.from(embedded, 'base64'))
              .resize({ width: 512, quality: 'best' })
              .toPNG()
              .toString('base64'),
          Buffer.from(readAppIcon(content).png).toString('base64'),
        ),
      )
    assert.ok(Math.max(size.width, size.height) <= 512, name)
    assert.ok(Math.min(size.width, size.height) >= 16, name)
    const icons = await calls()
    assert.equal(icons.length, mac ? 1 : (await app.windows()).length, name)
    for (const { icon } of icons) assert.equal(icon, png, name)
  }
  assert.equal(
    await page.locator('.document-notice', { hasText: 'App icon' }).count(),
    0,
  )
  const shot = process.env.HIBI_APP_ICON_SCREENSHOT
  if (shot)
    await page
      .locator('.settings-group', { has: page.locator('#app-icon') })
      .screenshot({ path: shot })

  // The choice and its image come back on the next launch, before a window shows.
  await app.close()
  ;({ page, select } = await launch())
  const { png } = await stored()
  if (mac) {
    const startup = await calls()
    assert.deepEqual(startup, [{ icon: png, shown: false }])
  } else await calls()
  assert.equal(await select.inputValue(), 'custom')
  await page
    .getByRole('img', { name: 'Custom app icon preview', exact: true })
    .waitFor()

  await page.getByRole('button', { name: 'Reset', exact: true }).click()
  await idle(page)
  await page.waitForFunction(() => document.activeElement?.id === 'app-icon')
  assert.equal(await select.inputValue(), 'app')
  assert.equal(
    await page
      .getByRole('img', { name: 'Custom app icon preview', exact: true })
      .count(),
    0,
  )
  assert.equal(await exists(join(profile, 'app-icon.png')), false)
  assert.deepEqual(await preference(), { mode: 'app' })
  const dark = await app.evaluate(
    ({ nativeTheme }) => nativeTheme.shouldUseDarkColors,
  )
  assert.equal(await lastIcon(), await bundled(dark))
})
