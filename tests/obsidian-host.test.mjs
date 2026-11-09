import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { fixtureVault, readFixturePlugin } from './obsidian/harness.mjs'
import { waitForAsync } from './poll.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

test('trusted fixture plugin loads, renders settings, persists overlay, runs commands, and unloads every registered resource', {
  timeout: 90000,
}, async (t) => {
  const fixture = await fixtureVault(t, 'host-surface', { cleanup: false })
  const pending = await readFixturePlugin('host-pending')
  const pendingFolder = join(fixture.root, 'pending-package')
  await mkdir(pendingFolder)
  await writeFile(
    join(pendingFolder, 'manifest.json'),
    JSON.stringify(pending.manifest),
  )
  await writeFile(join(pendingFolder, 'main.js'), pending.main)
  const throwing = await readFixturePlugin('host-throws')
  const throwingFolder = join(fixture.root, 'throwing-package')
  await mkdir(throwingFolder)
  await writeFile(
    join(throwingFolder, 'manifest.json'),
    JSON.stringify(throwing.manifest),
  )
  await writeFile(join(throwingFolder, 'main.js'), throwing.main)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${fixture.overlay}`],
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
  assert.equal(
    await page.evaluate(() => typeof HTMLElement.prototype.createEl),
    'undefined',
  )
  assert.equal(
    await page.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .some((entry) => /\/host-[^/]+\.js/.test(entry.name)),
    ),
    false,
  )
  await app.evaluate(({ dialog }, vault) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [vault],
    })
    dialog.showMessageBox = async () => ({ response: 1 })
  }, fixture.vault)
  await pressShortcut(app, `${mod}+Shift+o`)
  const warning = page.getByRole('dialog', {
    name: 'Back up this Obsidian vault',
  })
  await warning
    .locator('.dialog-footer')
    .getByRole('button', { name: 'Continue', exact: true })
    .click()
  await warning.waitFor({ state: 'hidden' })
  await page.locator('.app[aria-busy="false"]').waitFor()
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  const hostEnabled = page.getByRole('checkbox', {
    name: 'Obsidian plugins',
    exact: true,
  })
  assert.equal(await hostEnabled.isChecked(), false)
  await hostEnabled.click()
  await page.getByRole('tab', { name: 'Obsidian plugins', exact: true }).click()
  await page.getByRole('button', { name: 'Install copy', exact: true }).click()
  const enabled = page.getByRole('checkbox', {
    name: 'Enable Host surface',
    exact: true,
  })
  await enabled.waitFor()
  assert.equal(await enabled.isChecked(), false)
  assert.equal(
    await page.evaluate(() => typeof window.__hibiHostFixture),
    'undefined',
  )
  await enabled.click()
  await page.waitForFunction(() => window.__hibiHostFixture?.loaded)
  assert.deepEqual(
    await page.evaluate(() => {
      const f = window.__hibiHostFixture
      return [
        f.menuComponent,
        f.menuShowReturns,
        f.menuHideReturns,
        f.noticeShape,
        f.noticeFragment,
        f.modalMethods,
      ]
    }),
    [true, true, true, true, true, true],
  )
  await page.getByText('Fixture notice', { exact: true }).waitFor()
  await page.evaluate(() =>
    window.__hibiHostFixture.notice.setMessage('Updated fixture notice'),
  )
  await page.getByText('Updated fixture notice', { exact: true }).waitFor()
  await page.evaluate(() => window.__hibiHostFixture.notice.hide())
  await page
    .getByText('Updated fixture notice', { exact: true })
    .waitFor({ state: 'hidden' })
  assert.deepEqual(
    await page.evaluate(() => {
      const f = window.__hibiHostFixture
      return {
        platform: f.platform,
        path: f.path,
        yaml: f.yaml,
        moment: f.hasMoment,
        icon: f.icon,
        protocol: f.protocolRefused,
        network: f.networkRefused,
        mod: f.isMod,
      }
    }),
    {
      platform: {
        desktop: true,
        mobile: false,
        mac: process.platform === 'darwin',
      },
      path: 'folder/note',
      yaml: { fixture: true },
      moment: false,
      icon: true,
      protocol: true,
      network: true,
      mod: true,
    },
  )
  await page.getByRole('tab', { name: 'Host surface', exact: true }).click()
  const toggle = page.getByRole('checkbox', {
    name: 'Fixture toggle',
    exact: true,
  })
  await toggle.check()
  const vaultId = await page.evaluate(
    async () => (await window.hibi.getWorkspace()).id,
  )
  const data = join(
    fixture.overlay,
    'obsidian',
    'vaults',
    vaultId,
    'state',
    'host-surface',
    'data.json',
  )
  await waitForAsync(
    page,
    async (vaultId) =>
      (
        await window.hibi.queryAddon('obsidian', 'data', {
          vaultId,
          id: 'host-surface',
        })
      ).enabled === true,
    vaultId,
  )
  assert.equal(JSON.parse(await readFile(data, 'utf8')).enabled, true)
  await page
    .getByRole('textbox', { name: 'Fixture text', exact: true })
    .fill('changed')
  await page
    .getByRole('textbox', { name: 'Fixture area', exact: true })
    .fill('changed area')
  await page
    .getByRole('combobox', { name: 'Fixture choice', exact: true })
    .selectOption('second')
  await page
    .getByRole('searchbox', { name: 'Fixture search', exact: true })
    .fill('search')
  await page
    .getByRole('button', { name: 'Fixture button', exact: true })
    .click()
  await page
    .getByRole('button', { name: 'Fixture extra button', exact: true })
    .click()
  await page.evaluate(() => {
    const color = document.querySelector('input[aria-label="Fixture color"]')
    color.value = '#445566'
    color.dispatchEvent(new Event('input', { bubbles: true }))
    const slider = document.querySelector('input[aria-label="Fixture slider"]')
    slider.value = '7'
    slider.dispatchEvent(new Event('input', { bubbles: true }))
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'F6', bubbles: true }),
    )
    document.dispatchEvent(new Event('host-fixture-event'))
    window.__hibiHostFixture.emitter.trigger('fixture')
  })
  assert.deepEqual(
    await page.evaluate(() => {
      const f = window.__hibiHostFixture
      return [
        f.text,
        f.area,
        f.choice,
        f.slider,
        f.color,
        f.search,
        f.buttons,
        f.keys,
        f.clicks,
        f.events,
      ]
    }),
    ['changed', 'changed area', 'second', 7, '#445566', 'search', 2, 1, 1, 1],
  )

  async function command(name) {
    await clickMenu(app, 'Command palette')
    const palette = page.getByRole('dialog', { name: /^command palette$/i })
    await palette.getByRole('combobox', { name: /search commands/i }).fill(name)
    await palette.getByRole('option', { name: new RegExp(name, 'i') }).click()
    await palette.waitFor({ state: 'hidden' })
  }
  await command('Count fixture runs')
  await command('Checked fixture action')
  await waitForAsync(
    page,
    async (vaultId) =>
      (
        await window.hibi.queryAddon('obsidian', 'data', {
          vaultId,
          id: 'host-surface',
        })
      ).commands === 1,
    vaultId,
  )
  assert.equal(JSON.parse(await readFile(data, 'utf8')).commands, 1)
  assert.equal(await page.evaluate(() => window.__hibiHostFixture.checked), 1)
  await page.evaluate(() => window.__hibiHostFixture.openModal())
  const modal = page.getByRole('dialog', { name: 'Fixture modal', exact: true })
  await modal.getByText('Fixture modal content').waitFor()
  await modal.getByText('Seeded modal fragment').waitFor()
  await page.keyboard.press('Escape')
  await modal.waitFor({ state: 'hidden' })
  await page.evaluate(() => window.__hibiHostFixture.openMenu())
  await page.getByRole('menuitem', { name: /Fixture menu item/i }).click()
  assert.deepEqual(
    await page.evaluate(() => {
      const f = window.__hibiHostFixture
      return [
        f.modalOpened,
        f.modalClosed,
        f.modalCallback,
        f.menu,
        f.menuHidden,
      ]
    }),
    [1, 1, 1, 1, 2],
  )
  await page.getByRole('tab', { name: 'Obsidian plugins', exact: true }).click()
  await command('Schedule fixture callback')
  await page
    .getByRole('checkbox', { name: 'Enable Host surface', exact: true })
    .click()
  await page.waitForFunction(() => window.__hibiHostFixture.unloaded === 1)
  assert.equal(
    await page.evaluate(() => typeof HTMLElement.prototype.createEl),
    'undefined',
  )
  assert.equal(await page.locator('[data-obsidian-plugin]').count(), 0)
  assert.equal(
    await page.getByRole('tab', { name: 'Host surface', exact: true }).count(),
    0,
  )
  const before = await page.evaluate(() => {
    const f = window.__hibiHostFixture
    document.dispatchEvent(new Event('host-fixture-event'))
    f.emitter.trigger('fixture')
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'F6', bubbles: true }),
    )
    return {
      ticks: f.ticks,
      clicks: f.clicks,
      events: f.events,
      keys: f.keys,
      child: f.childUnloaded,
    }
  })
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 160)))
  assert.deepEqual(
    await page.evaluate(() => {
      const f = window.__hibiHostFixture
      return {
        ticks: f.ticks,
        clicks: f.clicks,
        events: f.events,
        keys: f.keys,
        child: f.childUnloaded,
      }
    }),
    before,
  )
  assert.deepEqual(
    [before.clicks, before.events, before.keys, before.child],
    [1, 1, 1, 1],
  )
  await page.evaluate(() => window.__hibiHostFixture.debounced.run())
  assert.equal(
    await page
      .locator('[data-toolbar-id^="obsidian."], [data-status-id^="obsidian."]')
      .count(),
    0,
  )
  assert.equal(await page.evaluate(() => window.__hibiHostFixture.delayed), 0)
  await page
    .getByRole('checkbox', { name: 'Enable Host surface', exact: true })
    .click()
  await page.waitForFunction(
    () =>
      window.__hibiHostFixture?.loaded &&
      window.__hibiHostFixture.unloaded === 0,
  )
  await page.getByRole('tab', { name: 'Host surface', exact: true }).click()
  assert.equal(
    await page
      .getByRole('checkbox', { name: 'Fixture toggle', exact: true })
      .isChecked(),
    true,
  )
  await page.getByRole('tab', { name: 'Obsidian plugins', exact: true }).click()
  await page
    .getByRole('checkbox', { name: 'Enable Host surface', exact: true })
    .click()
  await page.waitForFunction(
    () => typeof HTMLElement.prototype.createEl === 'undefined',
  )
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [folder],
    })
  }, throwingFolder)
  await page
    .getByRole('button', { name: 'Install from folder', exact: true })
    .click()
  await page
    .getByRole('checkbox', { name: 'Enable Host throws', exact: true })
    .click()
  await page.waitForFunction(() => window.__hibiThrowFixture?.loaded)
  await page
    .getByRole('checkbox', { name: 'Enable Host throws', exact: true })
    .click()
  await page.waitForFunction(() => window.__hibiThrowFixture.cleaned === 1)
  await waitForAsync(
    page,
    async (vaultId) => {
      const installed = await window.hibi.queryAddon('obsidian', 'list', {
        vaultId,
      })
      return (
        installed.find((plugin) => plugin.manifest.id === 'host-throws')
          ?.enabled === false
      )
    },
    vaultId,
    { timeout: 5000, label: 'disable persists after throwing onunload' },
  )
  assert.equal(await page.evaluate(() => window.__hibiThrowFixture.unloaded), 1)
  await page.getByText('Fixture unload failure.', { exact: true }).waitFor()
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [folder],
    })
  }, pendingFolder)
  await page
    .getByRole('button', { name: 'Install from folder', exact: true })
    .click()
  await page
    .getByRole('checkbox', { name: 'Enable Host pending', exact: true })
    .click()
  await page.waitForFunction(() => window.__hibiPendingFixture?.started)
  assert.equal(
    await page.evaluate(() => typeof HTMLElement.prototype.createEl),
    'function',
  )
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  await page
    .getByRole('checkbox', { name: 'Obsidian plugins', exact: true })
    .click()
  await page.waitForFunction(
    () =>
      window.__hibiPendingFixture.unloaded === 1 &&
      typeof HTMLElement.prototype.createEl === 'undefined',
  )
  const pendingTicks = await page.evaluate(
    () => window.__hibiPendingFixture.ticks,
  )
  await page.evaluate(() => window.__hibiPendingFixture.release())
  await page.waitForFunction(() => window.__hibiPendingFixture.finished)
  assert.equal(
    await page.evaluate(() => window.__hibiPendingFixture.saveRefused),
    true,
  )
  assert.equal(
    JSON.parse(
      await readFile(
        join(
          fixture.overlay,
          'obsidian',
          'vaults',
          vaultId,
          'state',
          'host-pending',
          'data.json',
        ),
        'utf8',
      ),
    ),
    null,
  )
  await page.evaluate(() => {
    document.dispatchEvent(new Event('host-pending-event'))
    document.dispatchEvent(new Event('host-pending-late'))
    window.__hibiPendingFixture.emitter.trigger('pending')
  })
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 80)))
  assert.deepEqual(
    await page.evaluate(() => {
      const f = window.__hibiPendingFixture
      return [f.events, f.lateEvents, f.unloaded]
    }),
    [0, 0, 1],
  )
  assert.equal(
    await page.evaluate(() => window.__hibiPendingFixture.ticks),
    pendingTicks,
  )
  assert.equal(
    await page
      .locator(
        '[data-obsidian-plugin], [data-status-id^="obsidian."], [data-toolbar-id^="obsidian."]',
      )
      .count(),
    0,
  )
  await fixture.assertUnchanged()
})
