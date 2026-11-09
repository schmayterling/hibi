import assert from 'node:assert/strict'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { fixtureVault } from './obsidian/harness.mjs'
import { waitForAsync } from './poll.mjs'
import { snapshotVault } from './vault-fidelity.mjs'

test('handwritten vault plugin runs through real native handlers and preserves protected vault bytes', {
  timeout: 90000,
}, async (t) => {
  const fixture = await fixtureVault(t, 'vault-api', { cleanup: false })
  await writeFile(
    join(fixture.vault, '.obsidian/app.json'),
    JSON.stringify({ trashOption: 'local', alwaysUpdateLinks: true }),
  )
  const before = await snapshotVault(fixture.vault)
  const app = await electron.launch({
    args: [resolve('.'), '--user-data-dir=' + fixture.overlay],
  })
  t.after(async () => {
    try {
      await app.close()
      const after = await snapshotVault(fixture.vault)
      for (const [path, entry] of before)
        assert.deepEqual(after.get(path), entry, path)
      await rm(join(fixture.vault, 'api-fixture'), {
        recursive: true,
        force: true,
      })
      await rm(join(fixture.vault, '.trash'), { recursive: true, force: true })
      await rm(join(fixture.vault, '.obsidian/app.json'))
      await fixture.assertUnchanged()
    } finally {
      await fixture.dispose()
    }
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(8000)
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ dialog }, vault) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [vault],
    })
    dialog.showMessageBox = async () => ({ response: 1 })
  }, fixture.vault)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await pressShortcut(app, mod + '+Shift+o')
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
  await page
    .getByRole('checkbox', { name: 'Obsidian plugins', exact: true })
    .click()
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  await page.getByRole('button', { name: 'Install copy', exact: true }).click()
  await page
    .getByRole('checkbox', { name: 'Enable Vault API fixture', exact: true })
    .click()
  const vaultId = await page.evaluate(
    async () => (await window.hibi.getWorkspace()).id,
  )
  await waitForAsync(
    page,
    async (vaultId) => {
      const data = await window.hibi.queryAddon('obsidian', 'data', {
        vaultId,
        id: 'vault-api',
      })
      return (
        data?.configDir === '.obsidian' &&
        data?.events?.some(([name]) => name === 'rename')
      )
    },
    vaultId,
  )
  const result = JSON.parse(
    await readFile(
      join(fixture.overlay, 'obsidian/global', 'state/vault-api/data.json'),
      'utf8',
    ),
  )
  assert.equal(
    await readFile(join(fixture.vault, 'api-fixture/final.md'), 'utf8'),
    result.content,
  )
  assert.ok(
    result.events.some(
      ([name, path]) => name === 'delete' && path.endsWith('pixel.png'),
    ),
  )
  assert.ok(result.content.includes('title: New # keep'))
  assert.equal(result.parent, '')
  await page
    .getByRole('checkbox', { name: 'Enable Vault API fixture', exact: true })
    .click()
})
