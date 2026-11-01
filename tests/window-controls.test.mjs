import assert from 'node:assert/strict'
import { once } from 'node:events'
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForAsync, waitForDocumentEditor } from './electron.mjs'
import { clickMenu, replaceRichText } from './keyboard.mjs'

async function appearance(app, page) {
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Appearance', exact: true }).click()
  return page.getByRole('checkbox', {
    name: 'Hide window controls',
    exact: true,
  })
}

const padding = (page) =>
  page
    .locator('.titlebar')
    .evaluate((bar) => getComputedStyle(bar).paddingRight)

const restartPrompt = (page) =>
  page.getByRole('dialog', { name: 'Restart Hibi?', exact: true })
async function restartLater(page) {
  const prompt = restartPrompt(page)
  await prompt.getByRole('button', { name: 'Later', exact: true }).click()
  await prompt.waitFor({ state: 'hidden' })
  await page.waitForFunction(
    () => document.activeElement?.id === 'hide-window-controls',
  )
}

test('window controls setting is available only on Linux', async (t) => {
  const profile = await mkdtemp(
    join(tmpdir(), 'hibi-window-controls-platform-'),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  const toggle = await appearance(app, page)
  assert.equal(await toggle.count(), process.platform === 'linux' ? 1 : 0)
  if (process.platform === 'linux') {
    const cdp = await page.context().newCDPSession(page)
    const { nodes } = await cdp.send('Accessibility.getFullAXTree')
    const control = nodes.find(
      (node) =>
        node.role?.value === 'checkbox' &&
        node.name?.value === 'Hide window controls',
    )
    assert.match(control?.description?.value ?? '', /On Linux/)
    assert.match(control?.description?.value ?? '', /Restart Hibi to apply/)
    await cdp.detach()
  }
  for (const value of [null, 'true', 1, {}])
    await assert.rejects(
      page.evaluate((value) => window.hibi.setHideWindowControls(value), value),
      /Invalid window controls setting/,
    )
  if (process.platform !== 'linux')
    await assert.rejects(
      page.evaluate(() => window.hibi.setHideWindowControls(true)),
      /Invalid window controls setting/,
    )
})

test('Linux window controls persist and apply to main and addon windows after restart', {
  skip: process.platform !== 'linux',
  timeout: 60000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-window-controls-'))
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'quick-note': true }),
  )
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
    await page.locator('.app[data-platform="linux"]').waitFor()
    return page
  }
  const addon = async (page, hidden) => {
    await page.evaluate(() =>
      window.hibi.openAddonWindow('quick-note', {
        id: 'capture',
        titleBar: 'hibi',
        show: false,
      }),
    )
    const window = app
      .windows()
      .find((page) => page.url().endsWith('/addon-window.html'))
    assert.ok(window)
    await window.locator('.addon-window-titlebar').waitFor()
    const context = await window.evaluate(() =>
      window.hibiAddonWindow.context(),
    )
    assert.equal(context.windowControlsHidden, hidden)
    assert.equal(await padding(window), hidden ? '8px' : '140px')
  }

  let page = await launch()
  let toggle = await appearance(app, page)
  await toggle.waitFor({ state: 'visible' })
  assert.equal(await toggle.isChecked(), false)
  assert.equal(await restartPrompt(page).count(), 0)
  assert.equal(await padding(page), '140px')
  await toggle.check()
  await page.waitForFunction(
    () => !document.querySelector('#hide-window-controls').disabled,
  )
  assert.deepEqual(
    JSON.parse(await readFile(join(profile, 'window-controls.json'), 'utf8')),
    { hidden: true },
  )
  await restartPrompt(page).waitFor()
  await restartLater(page)
  assert.equal(
    await toggle.evaluate((control) => control === document.activeElement),
    true,
  )
  await toggle.uncheck()
  await page.waitForFunction(
    () => !document.querySelector('#hide-window-controls').disabled,
  )
  assert.equal(await restartPrompt(page).count(), 0)
  await toggle.check()
  await restartPrompt(page).press('Escape')
  await restartPrompt(page).waitFor({ state: 'hidden' })
  assert.equal(
    (await page.evaluate(() => window.hibi.getAppInfo())).windowControlsHidden,
    false,
  )
  assert.equal(await padding(page), '140px')
  // New addon windows use the applied state, even after changing the preference.
  await addon(page, false)
  await app.close()
  app = null

  page = await launch()
  toggle = await appearance(app, page)
  await page.waitForFunction(
    () => document.querySelector('#hide-window-controls')?.checked,
  )
  assert.equal(await restartPrompt(page).count(), 0)
  assert.equal(
    (await page.evaluate(() => window.hibi.getAppInfo())).windowControlsHidden,
    true,
  )
  assert.equal(await padding(page), '8px')
  await addon(page, true)
  // Theme changes must not try to update a disabled native overlay.
  await page.evaluate(() =>
    window.hibi.setAppearance({
      preferences: { mode: 'dark', light: 'hibi-light', dark: 'hibi-dark' },
      light: { background: '#ffffff', foreground: '#1b2021' },
      dark: { background: '#181818', foreground: '#e4e9e9' },
    }),
  )
  assert.equal(await padding(page), '8px')
  await toggle.uncheck()
  await page.waitForFunction(
    () => !document.querySelector('#hide-window-controls').disabled,
  )
  assert.deepEqual(
    JSON.parse(await readFile(join(profile, 'window-controls.json'), 'utf8')),
    { hidden: false },
  )
  await restartLater(page)
  assert.equal(await padding(page), '8px')
  await app.close()
  app = null

  page = await launch()
  toggle = await appearance(app, page)
  assert.equal(await toggle.isChecked(), false)
  assert.equal(await restartPrompt(page).count(), 0)
  assert.equal(await padding(page), '140px')
  await addon(page, false)
})

test('cancelling unsaved-work confirmation cancels the requested restart', {
  skip: process.platform !== 'linux',
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(
    join(tmpdir(), 'hibi-window-controls-restart-cancel-'),
  )
  const marker = join(profile, 'relaunch.txt')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  let closed = false
  t.after(async () => {
    if (!closed) {
      await app.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1 })
      })
      await app.close()
    }
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await waitForDocumentEditor(app, page)
  await replaceRichText(
    page,
    page.getByRole('textbox', { name: 'Document editor', exact: true }),
    'Keep this unsaved draft.',
  )
  await app.evaluate(({ app, dialog }, marker) => {
    globalThis.restartSavePrompts = 0
    dialog.showMessageBox = async () => {
      globalThis.restartSavePrompts++
      return { response: 2 }
    }
    app.relaunch = () =>
      process.getBuiltinModule('fs').writeFileSync(marker, 'relaunch')
  }, marker)
  const toggle = await appearance(app, page)
  await toggle.check()
  await restartPrompt(page)
    .getByRole('button', { name: 'Restart Hibi', exact: true })
    .click()
  await waitForAsync(app, () => globalThis.restartSavePrompts === 1)
  assert.equal(page.isClosed(), false)
  assert.match(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    /Keep this unsaved draft\./,
  )
  assert.equal(
    await page.evaluate(() => window.hibi.getHideWindowControls()),
    true,
  )
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  await app.close()
  closed = true
  assert.equal(await readFile(marker, 'utf8').catch(() => null), null)
})

test('confirming restart saves unsaved work before requesting relaunch', {
  skip: process.platform !== 'linux',
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(
    join(tmpdir(), 'hibi-window-controls-restart-save-'),
  )
  const marker = join(profile, 'relaunch.txt')
  const note = join(profile, 'saved-note.md')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    if (app.process().exitCode === null) {
      await app.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1 })
      })
      await app.close()
    }
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await waitForDocumentEditor(app, page)
  await replaceRichText(
    page,
    page.getByRole('textbox', { name: 'Document editor', exact: true }),
    'Save this draft before restarting.',
  )
  await app.evaluate(
    ({ app, dialog }, { marker, note }) => {
      dialog.showMessageBox = async () => ({ response: 0 })
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: note })
      app.relaunch = () => {
        const fs = process.getBuiltinModule('fs')
        fs.writeFileSync(marker, fs.readFileSync(note))
      }
    },
    { marker, note },
  )
  const toggle = await appearance(app, page)
  await toggle.check()
  const exited = once(app.process(), 'exit')
  await restartPrompt(page)
    .getByRole('button', { name: 'Restart Hibi', exact: true })
    .click()
  const [code, signal] = await exited
  assert.equal(code, 0)
  assert.equal(signal, null)
  const saved = await readFile(note, 'utf8')
  assert.equal(saved.trim(), 'Save this draft before restarting.')
  assert.equal(await readFile(marker, 'utf8'), saved)
})

for (const [name, contents, initial] of [
  ['default preference', null, false],
  ['saved hidden preference', '{"hidden":true}', true],
  ['corrupt preferences file', '{broken', false],
])
  test(`a failed save preserves the ${name} and allows a retry`, {
    skip: process.platform !== 'linux',
  }, async (t) => {
    const profile = await mkdtemp(
      join(tmpdir(), 'hibi-window-controls-failure-'),
    )
    const location = join(profile, 'window-controls.json')
    if (contents !== null) await writeFile(location, contents)
    const app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${profile}`],
    })
    t.after(async () => {
      await app.close()
      await rm(profile, { recursive: true, force: true })
    })
    const page = await app.firstWindow()
    const toggle = await appearance(app, page)
    await page.waitForFunction(
      () => !document.querySelector('#hide-window-controls').disabled,
    )
    assert.equal(await toggle.isChecked(), initial)
    await app.evaluate(() => {
      const original = console.error
      globalThis.windowControlsErrors = []
      console.error = (...args) => {
        if (args[0] === 'Could not save window controls preferences:')
          globalThis.windowControlsErrors.push(args.slice(0, 2))
        original(...args)
      }
    })
    if (contents !== null) await rename(location, `${location}.before-failure`)
    await mkdir(location)
    await toggle.click()
    await page
      .getByText('Window controls unavailable', { exact: true })
      .waitFor()
    await page
      .getByText('Could not save your window controls preference. Try again.', {
        exact: true,
      })
      .waitFor()
    assert.equal(await toggle.isChecked(), initial)
    assert.equal(
      await page.evaluate(() => window.hibi.getHideWindowControls()),
      initial,
    )
    assert.deepEqual(
      await app.evaluate(() => globalThis.windowControlsErrors),
      [['Could not save window controls preferences:', location]],
    )
    await rm(location, { recursive: true })
    if (contents !== null) {
      await rename(`${location}.before-failure`, location)
      assert.equal(await readFile(location, 'utf8'), contents)
    }
    await toggle.setChecked(!initial)
    await restartLater(page)
    await page.waitForFunction(
      () => !document.querySelector('#hide-window-controls').disabled,
    )
    assert.equal(await toggle.isChecked(), !initial)
    assert.deepEqual(JSON.parse(await readFile(location, 'utf8')), {
      hidden: !initial,
    })
  })

for (const [name, contents, hidden] of [
  ['invalid hidden value', '{"hidden":"true"}', false],
  ['missing hidden field', '{}', false],
])
  test(`window controls load ${name} safely`, {
    skip: process.platform !== 'linux',
  }, async (t) => {
    const profile = await mkdtemp(join(tmpdir(), 'hibi-window-controls-load-'))
    const location = join(profile, 'window-controls.json')
    await writeFile(location, contents)
    const app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${profile}`],
    })
    t.after(async () => {
      await app.close()
      await rm(profile, { recursive: true, force: true })
    })
    const page = await app.firstWindow()
    await page.locator('.app[data-platform="linux"]').waitFor()
    assert.equal(
      await page.evaluate(() => window.hibi.getHideWindowControls()),
      hidden,
    )
    assert.equal(
      (await page.evaluate(() => window.hibi.getAppInfo()))
        .windowControlsHidden,
      hidden,
    )
    assert.equal(await readFile(location, 'utf8'), contents)
  })
