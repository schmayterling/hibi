import assert from 'node:assert/strict'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForAsync, waitForDocumentEditor } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

const theme = (apiVersion, version) => ({
  id: 'old-theme',
  name: 'Old theme',
  description: 'A theme installed before addon API 3',
  kind: 'theme',
  apiVersion,
  version,
  authors: [{ displayName: 'Fixture author' }],
  themes: [
    {
      id: 'night',
      name: 'Old night',
      appearance: 'dark',
      author: 'Fixture author',
      license: { name: 'MIT', text: 'Fixture license notice.' },
      colors: {
        background: '#111111',
        surface: '#222222',
        ink: '#eeeeee',
        muted: '#aaaaaa',
        accent: '#88cccc',
        border: '#333333',
      },
    },
  ],
})
const tool = {
  id: 'old-tool',
  name: 'Old tool',
  description: 'An extension installed before addon API 3',
  kind: 'extension',
  apiVersion: 1,
  version: '0.4.0',
  authors: [{ displayName: 'Fixture author' }],
  capabilities: ['rich'],
  entry: 'index.js',
}

async function installed(profile, manifest, files = []) {
  const folder = join(profile, 'installed-addons', manifest.id)
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'hibi-addon.json'), JSON.stringify(manifest))
  await writeFile(join(folder, 'README.md'), `# ${manifest.name}`)
  for (const file of files) await writeFile(join(folder, file), '')
  await writeFile(
    join(folder, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['hibi-addon.json', 'README.md', ...files],
      source: 'third-party',
    }),
  )
  return folder
}

async function launch(t, profile) {
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  await waitForDocumentEditor(app, page)
  return { app, page }
}

const row = (page, name) =>
  page.locator('.addon-list .setting-row', { hasText: name })

test('addons installed for an earlier addon API can be updated or uninstalled, and say so once', {
  timeout: 180000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-addon-outdated-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const profile = join(root, 'profile')
  const themeFolder = await installed(profile, theme(2, '1.0.0'))
  const toolFolder = await installed(profile, tool, ['index.js'])
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'old-theme': true, 'old-tool': true }),
  )
  const update = join(root, 'update', 'old-theme')
  await mkdir(update, { recursive: true })
  await writeFile(
    join(update, 'hibi-addon.json'),
    JSON.stringify(theme(3, '1.1.0')),
  )
  await writeFile(join(update, 'README.md'), '# Old theme, updated')

  await t.test(
    'one notice leads to both addons in the addon manager',
    async (t) => {
      const { page } = await launch(t, profile)
      const notice = page.locator('.toast', {
        hasText: '2 addons need an update for addon API 3.',
      })
      await notice.waitFor()
      assert.equal(await page.locator('.toast').count(), 1)
      await notice.getByRole('button', { name: 'Open addon manager' }).click()
      const theme = row(page, 'Old theme')
      await theme.waitFor()
      assert.match(await theme.innerText(), /needs an update for addon API 3/i)
      assert.match(await row(page, 'Old tool').innerText(), /0\.4\.0/)
    },
  )

  await t.test('the notice does not return, but the rows stay', async (t) => {
    const { app, page } = await launch(t, profile)
    await page.locator('.app[aria-busy="false"]').waitFor()
    // The addon list is ready once settings show it.
    await clickMenu(app, 'Settings')
    await page.getByRole('tab', { name: /^addon manager$/i }).click()
    await row(page, 'Old theme').waitFor()
    assert.equal(
      await page
        .locator('.toast', { hasText: 'need an update for addon API 3' })
        .count(),
      0,
    )
  })

  await t.test(
    'an update replaces the old install and keeps its setting, uninstall removes the other, and the notice follows',
    async (t) => {
      const { app, page } = await launch(t, profile)
      // Announce again in this session to watch the notice follow the list.
      await page.evaluate(() =>
        localStorage.removeItem('hibi:outdated-addons-announced'),
      )
      await page.reload()
      await waitForDocumentEditor(app, page)
      const notice = page.locator('.toast', {
        hasText: /needs? an update for addon API 3/,
      })
      await notice
        .filter({ hasText: '2 addons need an update for addon API 3.' })
        .waitFor()
      await page.evaluate(() =>
        window.hibi.setAddonTrustSettings({
          allowUnsigned: true,
          checkRevocations: false,
        }),
      )
      await app.evaluate(({ dialog, shell, ipcMain }, source) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [source],
        })
        globalThis.reviews = []
        dialog.showMessageBox = async (_window, options) => {
          globalThis.reviews.push(options?.buttons ?? [])
          return { response: 1 }
        }
        const fs = process.getBuiltinModule('fs/promises')
        shell.trashItem = (path) => fs.rename(path, `${path}.trashed`)
        globalThis.gardenInstalls = []
        ipcMain.removeHandler('addons:directory')
        ipcMain.handle('addons:directory', () => ({
          entries: [
            {
              id: 'old-theme',
              name: 'Old theme',
              description: 'A theme installed before addon API 3',
              kind: 'theme',
              version: '1.1.0',
              apiVersion: 3,
              authors: [{ displayName: 'Fixture author' }],
              license: 'MIT',
              repository: {
                url: 'https://github.com/example/old-theme',
                commit: 'a'.repeat(40),
              },
            },
          ],
          fetchedAt: '2026-10-31T00:00:00.000Z',
        }))
        ipcMain.removeHandler('addons:directory-install')
        ipcMain.handle('addons:directory-install', (_event, id) => {
          globalThis.gardenInstalls.push(id)
          return null
        })
      }, update)
      await clickMenu(app, 'Settings')
      await page.getByRole('tab', { name: /^addon manager$/i }).click()
      // Hibi garden lists an API 3 version, so the row offers it.
      await page.getByRole('button', { name: 'Update Old theme' }).click()
      await waitForAsync(app, () => globalThis.gardenInstalls.length > 0)
      assert.deepEqual(await app.evaluate(() => globalThis.gardenInstalls), [
        'old-theme',
      ])
      // The same replacement from a local folder, as a command.
      await clickMenu(app, 'Command palette')
      const input = page.getByRole('combobox', { name: /search commands/i })
      await input.fill('install addon')
      await page.getByRole('option').first().waitFor()
      await input.press('Enter')
      await notice
        .filter({ hasText: 'Old tool needs an update for addon API 3.' })
        .waitFor()
      const manifest = JSON.parse(
        await readFile(join(themeFolder, 'hibi-addon.json'), 'utf8'),
      )
      assert.deepEqual([manifest.apiVersion, manifest.version], [3, '1.1.0'])
      // It replaced an install, and a theme asks for no access, so it stays enabled.
      assert.deepEqual(await app.evaluate(() => globalThis.reviews), [
        ['Cancel', 'Replace addon'],
      ])
      assert.equal(
        (await page.evaluate(() => window.hibi.getAddonStates())).find(
          (state) => state.id === 'old-theme',
        )?.enabled,
        true,
      )
      await page.getByRole('button', { name: 'Uninstall Old tool' }).click()
      await page.waitForFunction(
        () =>
          ![...document.querySelectorAll('.addon-list .setting-row')].some(
            (element) => element.textContent.includes('Old tool'),
          ),
      )
      await access(`${toolFolder}.trashed`)
      assert.deepEqual(
        (await page.evaluate(() => window.hibi.getOutdatedAddons())).map(
          (addon) => addon.id,
        ),
        [],
      )
      // Nothing is left to update, so the notice goes.
      await notice.waitFor({ state: 'detached' })
    },
  )
})
