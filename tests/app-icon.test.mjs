import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { darkAppIcon, isAppIconMode } from '../src/shared/app-icon.ts'
import { electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

test('icon appearance follows its own source independently of the app theme', () => {
  for (const app of [false, true])
    for (const system of [false, true]) {
      assert.equal(darkAppIcon('app', app, system), app)
      assert.equal(darkAppIcon('system', app, system), system)
      assert.equal(darkAppIcon('light', app, system), false)
      assert.equal(darkAppIcon('dark', app, system), true)
    }
  for (const invalid of [null, undefined, '', 'Dark', {}, true])
    assert.equal(isAppIconMode(invalid), false)
})

test('macOS icon preference changes the Dock icon, persists, and reports save failures', {
  skip: process.platform !== 'darwin',
  timeout: 60000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-app-icon-'))
  let app
  t.after(async () => {
    await app?.close()
    await rm(profile, { recursive: true, force: true })
  })
  const launch = async () => {
    app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${profile}`],
    })
    const page = await app.firstWindow()
    await clickMenu(app, 'Settings')
    await page.getByRole('tab', { name: 'Appearance', exact: true }).click()
    const select = page.getByRole('combobox', {
      name: 'App icon appearance',
      exact: true,
    })
    await select.waitFor()
    await page.waitForFunction(
      () => !document.querySelector('#app-icon-appearance').disabled,
    )
    return { page, select }
  }
  let { page, select } = await launch()
  assert.equal(await select.inputValue(), 'app')
  // Capture the real Dock API's input: macOS exposes no runtime getIcon API.
  await app.evaluate(({ app }) => {
    const setIcon = app.dock.setIcon.bind(app.dock)
    app.dock.setIcon = (image) => {
      globalThis.iconPNG = image.toPNG().toString('base64')
      setIcon(image)
    }
  })
  const choose = async (mode) => {
    await select.selectOption(mode)
    await page.waitForFunction(
      () => !document.querySelector('#app-icon-appearance').disabled,
    )
    assert.equal(await select.inputValue(), mode)
  }
  for (const [mode, theme] of [
    ['dark', 'light'],
    ['light', 'dark'],
  ]) {
    await app.evaluate(({ nativeTheme }, theme) => {
      nativeTheme.themeSource = theme
    }, theme)
    await choose(mode)
    assert.equal(
      await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource),
      theme,
    )
    assert.equal(
      await app.evaluate(
        ({ nativeImage }, dark) =>
          globalThis.iconPNG ===
          nativeImage
            .createFromPath(
              `${process.cwd()}/build/icon-mac${dark ? '-dark' : ''}.png`,
            )
            .resize({ width: 256, height: 256 })
            .toPNG()
            .toString('base64'),
        mode === 'dark',
      ),
      true,
    )
  }
  const systemDark = await app.evaluate(
    ({ systemPreferences }) =>
      systemPreferences.getUserDefault('AppleInterfaceStyle', 'string') ===
      'Dark',
  )
  await app.evaluate(({ nativeTheme }, systemDark) => {
    nativeTheme.themeSource = systemDark ? 'light' : 'dark'
  }, systemDark)
  const darkIconShown = () =>
    app.evaluate(
      ({ nativeImage }) =>
        globalThis.iconPNG ===
        nativeImage
          .createFromPath(`${process.cwd()}/build/icon-mac-dark.png`)
          .resize({ width: 256, height: 256 })
          .toPNG()
          .toString('base64'),
    )
  await choose('system')
  assert.equal(await darkIconShown(), systemDark)
  await choose('app')
  assert.equal(await darkIconShown(), !systemDark)
  await choose('dark')
  for (const invalid of [null, 'unknown', {}, false])
    await assert.rejects(
      page.evaluate((value) => window.hibi.setAppIconMode(value), invalid),
      /Invalid app icon appearance/,
    )
  assert.equal(
    JSON.parse(await readFile(join(profile, 'app-icon.json'), 'utf8')),
    'dark',
  )
  await app.close()
  ;({ page, select } = await launch())
  assert.equal(await select.inputValue(), 'dark')
  const persisted = await readFile(join(profile, 'app-icon.json'), 'utf8')
  await rm(join(profile, 'app-icon.json'))
  // A directory at the destination makes the real atomic writer fail.
  const { mkdir } = await import('node:fs/promises')
  await mkdir(join(profile, 'app-icon.json'))
  await select.selectOption('light')
  await page.getByText('App icon unavailable', { exact: true }).waitFor()
  assert.equal(await select.inputValue(), 'dark')
  await rm(join(profile, 'app-icon.json'), { recursive: true })
  await writeFile(join(profile, 'app-icon.json'), persisted)
})
