import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

const manifest = (id, name) => ({
  id,
  name,
  description: `${name} fixture.`,
  apiVersion: 2,
  kind: 'extension',
  version: '1.0.0',
  authors: [{ displayName: 'Fixture author' }],
  capabilities: [],
  entry: 'index.js',
})

test('addon trust settings, install review marks, and revoked rows', {
  timeout: 45000,
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'hibi-addon-trust-ui-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(temp, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(temp, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await waitForDocumentEditor(app, page)
  const reason = 'It sends document contents to an unknown server.'
  await app.evaluate(
    ({ ipcMain }, { candidates, installed }) => {
      globalThis.trustSettings = {
        allowUnsigned: false,
        checkRevocations: true,
      }
      globalThis.trustChanges = []
      globalThis.installedAddons = installed
      const replace = (channel, handler) => {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, handler)
      }
      replace('addons:trust-settings', () => globalThis.trustSettings)
      replace('addons:trust-settings-set', (_event, changes) => {
        if (globalThis.failTrustSave)
          throw new Error('Could not save addon security settings.')
        globalThis.trustChanges.push(changes)
        Object.assign(globalThis.trustSettings, changes)
        return globalThis.trustSettings
      })
      replace('addons:install', () => ({
        id: 'trust-session',
        source: 'third-party',
        host: 'example.com',
        candidates,
        providers: [],
      }))
      replace('addons:install-cancel', () => {})
      replace('addons:installed', () => globalThis.installedAddons)
    },
    {
      reason,
      candidates: [
        {
          key: 'signed',
          folder: 'signed',
          manifest: manifest('trust-signed', 'Trust signed'),
          status: 'installable',
          reasons: [],
          trust: { status: 'signed', keyId: '1b43eadedb48d51d' },
        },
        {
          key: 'unsigned',
          folder: 'unsigned',
          manifest: manifest('trust-unsigned', 'Trust unsigned'),
          status: 'blocked',
          reasons: ['This addon is unsigned.'],
          trust: { status: 'unsigned' },
        },
        {
          key: 'invalid',
          folder: 'invalid',
          manifest: manifest('trust-invalid', 'Trust invalid'),
          status: 'blocked',
          reasons: ['Its signature does not match its files.'],
          trust: { status: 'invalid', reason: 'Signature mismatch.' },
        },
        {
          key: 'revoked',
          folder: 'revoked',
          manifest: manifest('trust-revoked', 'Trust revoked'),
          status: 'blocked',
          reasons: [`Hibi revoked this version. ${reason}`],
          trust: { status: 'signed', keyId: '1b43eadedb48d51d' },
          revoked: { reason },
        },
      ],
      installed: [
        {
          manifest: manifest('trust-signed', 'Trust signed'),
          url: null,
          themes: [],
          source: 'third-party',
          trust: 'signed',
        },
        {
          manifest: manifest('trust-legacy', 'Trust legacy'),
          url: null,
          themes: [],
          source: 'third-party',
        },
        {
          manifest: manifest('trust-revoked', 'Trust revoked'),
          url: null,
          themes: [],
          source: 'third-party',
          trust: 'signed',
          revoked: { reason },
        },
      ],
    },
  )
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^addon manager$/i }).click()
  const addons = page.locator('#settings-addons')
  const unsigned = addons.getByRole('checkbox', {
    name: 'Allow unsigned addons',
  })
  const revocations = addons.getByRole('checkbox', {
    name: 'Check for revoked addons',
  })
  const confirm = page.getByRole('dialog', { name: /^allow unsigned addons$/i })

  await t.test(
    'security toggles confirm before allowing unsigned addons',
    async () => {
      await addons.locator('#allow-unsigned-addons:enabled').waitFor()
      assert.equal(await unsigned.isChecked(), false)
      assert.equal(await revocations.isChecked(), true)
      assert.match(
        await addons.locator('#check-revoked-addons-description').innerText(),
        /sends no information about your addons/,
      )
      await unsigned.click()
      await confirm.waitFor()
      assert.match(
        await confirm.innerText(),
        /access to your documents, and Hibi cannot confirm who made them/,
      )
      await confirm.getByRole('button', { name: /^cancel$/i }).click()
      await confirm.waitFor({ state: 'hidden' })
      assert.equal(await unsigned.isChecked(), false)
      await unsigned.click()
      await confirm
        .getByRole('button', { name: /^allow unsigned addons$/i })
        .click()
      await addons.locator('#allow-unsigned-addons:checked:enabled').waitFor()
      await revocations.click()
      await addons
        .locator('#check-revoked-addons:not(:checked):enabled')
        .waitFor()
      assert.deepEqual(await app.evaluate(() => globalThis.trustChanges), [
        // Main accepts only complete settings.
        { allowUnsigned: true, checkRevocations: true },
        { allowUnsigned: true, checkRevocations: false },
      ])
      await app.evaluate(() => {
        globalThis.failTrustSave = true
      })
      await revocations.click()
      await addons
        .getByRole('alert')
        .filter({ hasText: 'Could not save addon security settings.' })
        .waitFor()
      assert.equal(await revocations.isChecked(), false)
      assert.equal(await revocations.isEnabled(), true)
    },
  )

  const dialog = page.getByRole('dialog', { name: /^install addons$/i })
  const row = (name) =>
    dialog.locator('li').filter({
      has: page.getByRole('checkbox', { name: `Trust ${name}`, exact: true }),
    })

  await t.test(
    'install review marks signed, unsigned, invalid, and revoked packages',
    async () => {
      await clickMenu(app, 'Command palette')
      const input = page.getByRole('combobox', { name: /search commands/i })
      await input.fill('install addon')
      await page.getByRole('option').first().waitFor()
      await input.press('Enter')
      await dialog.waitFor()
      assert.match(await row('signed').innerText(), /Signed by Hibi/)
      assert.equal(
        await dialog
          .getByRole('checkbox', { name: 'Trust signed' })
          .isChecked(),
        true,
      )
      assert.match(
        await row('unsigned').innerText(),
        /Unsigned.*Blocked package.*This addon is unsigned\./s,
      )
      for (const name of ['unsigned', 'revoked'])
        assert.doesNotMatch(await row(name).innerText(), /Signed by Hibi/)
      assert.match(
        await row('invalid').innerText(),
        /Invalid signature.*does not match its files/s,
      )
      assert.match(
        await row('revoked').innerText(),
        new RegExp(`Revoked package.*${reason}`, 's'),
      )
      for (const name of ['unsigned', 'invalid', 'revoked'])
        assert.equal(
          await dialog
            .getByRole('checkbox', { name: `Trust ${name}` })
            .isDisabled(),
          true,
        )
      await dialog.getByRole('button', { name: /^cancel$/i }).click()
      await dialog.waitFor({ state: 'hidden' })
    },
  )

  await t.test(
    'installed rows show unsigned and revoked states, and update on trust changes',
    async () => {
      const setting = (id) => addons.locator(`[data-setting-id="addon-${id}"]`)
      await setting('trust-legacy').waitFor()
      assert.match(await setting('trust-legacy').innerText(), /Unsigned/)
      assert.doesNotMatch(await setting('trust-signed').innerText(), /Unsigned/)
      assert.match(
        await setting('trust-revoked').innerText(),
        new RegExp(
          `Hibi disabled this addon because it was revoked: ${reason}`,
        ),
      )
      const toggle = addons.locator('#addon-trust-revoked')
      assert.equal(await toggle.isDisabled(), true)
      assert.equal(await toggle.isChecked(), false)
      assert.equal(
        await addons.locator('#addon-trust-signed').isDisabled(),
        false,
      )
      await app.evaluate(({ BrowserWindow }, reason) => {
        globalThis.installedAddons[0].revoked = { reason }
        for (const window of BrowserWindow.getAllWindows())
          window.webContents.send('addons:trust-changed')
      }, reason)
      await addons.locator('#addon-trust-signed:disabled').waitFor()
      assert.match(
        await setting('trust-signed').innerText(),
        /because it was revoked/,
      )
    },
  )
  assert.deepEqual(errors, [])
})
