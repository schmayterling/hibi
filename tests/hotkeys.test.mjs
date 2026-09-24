import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  defaultHotkeys,
  restoreHotkeys,
  shortcutFromEvent,
  shortcutLabels,
  validateHotkeys,
} from '../src/shared/hotkeys.ts'
import { electron, waitForAppState } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'

test('hotkey validation rejects conflicts and preserves standard editing keys', () => {
  const defaults = defaultHotkeys('darwin')
  assert.equal(defaults.normal, 'meta+shift+[')
  assert.equal(defaults.markdown, 'meta+shift+]')
  assert.equal(defaults.back, 'meta+[')
  assert.equal(defaults.forward, 'meta+]')
  assert.equal(
    restoreHotkeys({ normal: 'meta+[', _version: 2 }, 'darwin').back,
    '',
  )
  assert.equal(
    restoreHotkeys({ normal: 'meta+[' }, 'darwin').back,
    defaults.back,
  )
  assert.equal(
    restoreHotkeys(
      { ...defaults, normal: 'meta+[', markdown: 'meta+]' },
      'darwin',
    ).normal,
    defaults.normal,
  )
  assert.equal(
    restoreHotkeys({ ...defaults, normal: 'meta+[', _version: 2 }, 'darwin')
      .normal,
    'meta+[',
  )
  assert.equal(
    restoreHotkeys(
      { ...defaults, normal: 'meta+[', find: defaults.normal },
      'darwin',
    ).normal,
    'meta+[',
  )
  assert.equal(defaults['side-by-side'], 'meta+shift+\\')
  assert.equal(defaultHotkeys('linux')['side-by-side'], 'ctrl+shift+\\')
  assert.deepEqual(shortcutLabels(defaults['side-by-side'], 'darwin'), [
    '⌘',
    '|',
  ])
  assert.throws(
    () => validateHotkeys({ ...defaults, palette: defaults.save }, 'darwin'),
    /This shortcut is assigned to another action\./,
  )
  assert.throws(
    () => validateHotkeys({ ...defaults, palette: 'meta+w' }, 'darwin'),
    /This shortcut closes tabs\./,
  )
  assert.throws(
    () => validateHotkeys({ ...defaults, palette: 'k' }, 'darwin'),
    /Include Command, Control, or Option/,
  )
  assert.throws(
    () => validateHotkeys({ ...defaults, palette: 'meta+meta+k' }, 'darwin'),
    /Choose a supported key combination\./,
  )
  assert.throws(
    () => validateHotkeys({ ...defaults, palette: 12 }, 'darwin'),
    /Choose a supported key combination\./,
  )
  assert.throws(
    () => validateHotkeys([], 'darwin'),
    /Could not read these shortcut settings\./,
  )
  assert.equal(
    validateHotkeys({ ...defaults, palette: 'f1' }, 'darwin').palette,
    'f1',
  )
  assert.equal(
    shortcutFromEvent({
      key: '!',
      code: 'Digit1',
      ctrlKey: false,
      metaKey: true,
      shiftKey: true,
      altKey: false,
    }),
    'meta+shift+1',
  )
})

test('rebind, conflict, clear, reset, native menus, and relaunch persistence', {
  timeout: 60000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-hotkeys-'))
  let app
  const launch = async () => {
    app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${profile}`],
      colorScheme: null,
    })
    await app.evaluate(({ dialog }) => {
      globalThis.saveCalls = 0
      dialog.showSaveDialog = async () => {
        globalThis.saveCalls++
        return { canceled: true }
      }
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      })
    })
    return app.firstWindow()
  }
  t.after(async () => {
    await app?.close()
    await rm(profile, { recursive: true, force: true })
  })
  let page = await launch()
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  const storedMod = process.platform === 'darwin' ? 'meta' : 'ctrl'
  const rich = page.getByRole('textbox', { name: /document editor/i })
  await rich.waitFor()
  await rich.fill('keyboard checks')
  for (const [key, mode] of [
    ['Shift+]', 'markdown'],
    ['Shift+\\', 'side-by-side'],
    ['Shift+[', 'normal'],
  ]) {
    await pressShortcut(app, `${mod}+${key}`)
    await page.waitForFunction(
      (mode) =>
        document
          .querySelector('.editor-panes')
          .classList.contains(`mode-${mode}`),
      mode,
    )
  }
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'keyboard checks',
  )
  await pressShortcut(app, `${mod}+k`)
  const palette = page.getByRole('dialog', { name: /command palette/i })
  const search = page.getByRole('combobox', { name: /search commands/i })
  await palette.waitFor()
  await search.fill('preferences settings')
  await search.press('Enter')
  await palette.waitFor({ state: 'hidden' })
  await page.getByRole('tab', { name: /^hotkeys$/i, exact: true }).click()
  const binding = page.getByRole('button', {
    name: /^rebind command palette$/i,
    exact: true,
  })
  await binding.click()
  await page.waitForFunction(() =>
    document.querySelector('.hotkey-recorder[aria-pressed="true"]'),
  )
  await pressShortcut(app, `${mod}+s`)
  await page
    .getByRole('status')
    .filter({ hasText: /already used by save document/i })
    .waitFor()
  assert.equal(await app.evaluate(() => globalThis.saveCalls), 0)
  await pressShortcut(app, `${mod}+w`)
  await page
    .getByRole('status')
    .filter({ hasText: /this shortcut closes tabs/i })
    .waitFor()
  assert.equal(app.windows().length, 1)
  await pressShortcut(app, `${mod}+j`)
  await binding.press('Enter')
  await page.waitForFunction(
    () => !document.querySelector('.hotkey-recorder[aria-pressed="true"]'),
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getHotkeys())).palette,
    `${storedMod}+j`,
  )

  const saveBinding = page.getByRole('button', {
    name: /^rebind save document$/i,
    exact: true,
  })
  await saveBinding.click()
  await page.waitForFunction(() =>
    document.querySelector('.hotkey-recorder[aria-pressed="true"]'),
  )
  await pressShortcut(app, `${mod}+Shift+d`)
  await saveBinding.press('Enter')
  await page.waitForFunction(
    () => !document.querySelector('.hotkey-recorder[aria-pressed="true"]'),
  )
  const menuSave = await app.evaluate(
    ({ Menu }) =>
      Menu.getApplicationMenu()
        .items.find((item) => item.label === 'File')
        .submenu.items.find((item) => item.label === 'Save').accelerator,
  )
  assert.equal(
    menuSave.toLowerCase(),
    `${process.platform === 'darwin' ? 'super' : 'ctrl'}+shift+d`,
  )
  await binding.click()
  await page.waitForFunction(() =>
    document.querySelector('.hotkey-recorder[aria-pressed="true"]'),
  )
  await binding.press('Escape')
  assert.equal(
    await page
      .getByRole('main', { name: /^settings$/i, exact: true })
      .isVisible(),
    true,
  )

  await page
    .getByRole('button', {
      name: /^clear shortcut for find in document$/i,
      exact: true,
    })
    .click()
  await waitForAppState(page, () =>
    window.hibi.getHotkeys().then((keys) => keys.find === ''),
  )
  await page
    .getByRole('button', {
      name: /^reset shortcut for find in document$/i,
      exact: true,
    })
    .click()
  await waitForAppState(page, () =>
    window.hibi.getHotkeys().then((keys) => !!keys.find),
  )
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .map((animation) => animation.finished.catch(() => {})),
    ),
  )
  await mkdir('test-results', { recursive: true })
  await page.screenshot({ path: 'test-results/hotkeys.png' })
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await rich.waitFor()
  await rich.focus()
  await pressShortcut(app, `${mod}+k`)
  assert.equal(await palette.count(), 0)
  await pressShortcut(app, `${mod}+s`)
  assert.equal(await app.evaluate(() => globalThis.saveCalls), 0)
  await pressShortcut(app, `${mod}+Shift+d`)
  await page.waitForFunction(
    () =>
      document.querySelector('.titlebar')?.getAttribute('aria-busy') ===
      'false',
  )
  assert.equal(await app.evaluate(() => globalThis.saveCalls), 1)
  await pressShortcut(app, `${mod}+j`)
  await palette.waitFor()
  await search.fill('save document')
  assert.equal(
    await palette
      .locator('.command-results .shortcut-keys kbd')
      .last()
      .innerText(),
    'd',
  )
  await search.press('Escape')
  await palette.waitFor({ state: 'hidden' })
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'keyboard checks',
  )

  await app.close()
  page = await launch()
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await pressShortcut(app, `${mod}+j`)
  await page.getByRole('dialog', { name: /command palette/i }).waitFor()
  assert.equal(
    (await page.evaluate(() => window.hibi.getHotkeys())).save,
    `${storedMod}+shift+d`,
  )
  await page
    .getByRole('combobox', { name: /search commands/i })
    .fill('preferences settings')
  await page.getByRole('combobox', { name: /search commands/i }).press('Enter')
  await page.getByRole('tab', { name: /^hotkeys$/i, exact: true }).click()
  await page.getByRole('button', { name: /^reset all$/i, exact: true }).click()
  await waitForAppState(page, () =>
    window.hibi.getHotkeys().then((keys) => keys.palette.endsWith('+k')),
  )
  assert.deepEqual(
    await page.evaluate(() => window.hibi.getHotkeys()),
    defaultHotkeys(process.platform),
  )
})
