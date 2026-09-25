import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'

test('explorer command keeps clicked file through lazy startup and rejects a stale tree', {
  timeout: 60000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-explorer-command-'))
  const profile = join(root, 'profile')
  const workspace = join(root, 'notes')
  const directory = join(profile, 'installed-addons', 'explorer-probe')
  await mkdir(directory, { recursive: true })
  await mkdir(workspace)
  await writeFile(join(workspace, 'active.md'), '# active')
  await writeFile(join(workspace, 'target.md'), '# target')
  await writeFile(
    join(directory, 'hibi-addon.json'),
    JSON.stringify({
      id: 'explorer-probe',
      name: 'Explorer probe',
      description: 'Explorer command fixture',
      kind: 'extension',
      apiVersion: 2,
      version: '1.0.0',
      authors: [{ displayName: 'Test' }],
      entry: 'index.js',
      capabilities: [],
      activation: 'command',
      commands: [
        {
          id: 'inspect',
          label: 'Inspect clicked file',
          menu: { location: 'explorer', group: 'test', order: 1 },
        },
      ],
    }),
  )
  await writeFile(
    join(directory, 'index.js'),
    `export default () => ({ start(context) {
      window.explorerProbeStarts = (window.explorerProbeStarts || 0) + 1;
      return new Promise((resolve) => {
        window.releaseExplorerProbe = () => {
          context.commands.register({
            id: 'inspect', label: 'Inspect clicked file',
            run(invocation) {
              window.explorerProbeRuns = [...(window.explorerProbeRuns || []), invocation];
            },
          });
          resolve();
        };
      });
    } });`,
  )
  await writeFile(
    join(directory, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['hibi-addon.json', 'index.js'],
      source: 'local',
    }),
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'explorer-probe': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, workspace)
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  await page.locator('.titlebar').waitFor()
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  await pressShortcut(app, `${modifier}+Shift+o`)
  await page.getByRole('treeitem', { name: 'target.md' }).waitFor()
  await page.getByRole('treeitem', { name: 'active.md' }).click()
  const targetMenu = () =>
    page.getByRole('menu', { name: 'Actions for target.md' })
  await page.getByRole('button', { name: 'Actions for target.md' }).click()
  await targetMenu()
    .getByRole('menuitem', { name: 'Inspect clicked file' })
    .click()
  await page.waitForFunction(() => window.explorerProbeStarts === 1)
  await page.getByRole('button', { name: 'New workspace folder' }).click()
  const rename = page.getByRole('textbox', { name: 'Rename item' })
  await rename.fill('new folder')
  await rename.press('Enter')
  await page.getByRole('treeitem', { name: 'new folder' }).waitFor()
  await page.evaluate(() => window.releaseExplorerProbe())
  await page.waitForFunction(() =>
    document.body.textContent
      .toLowerCase()
      .includes('command target is no longer available'),
  )
  assert.equal(
    await page.evaluate(() => window.explorerProbeRuns?.length ?? 0),
    0,
  )

  await page.getByRole('button', { name: 'Actions for target.md' }).click()
  await targetMenu()
    .getByRole('menuitem', { name: 'Inspect clicked file' })
    .click()
  await page.waitForFunction(() => window.explorerProbeRuns?.length === 1)
  const [invocation] = await page.evaluate(() => window.explorerProbeRuns)
  assert.equal(invocation.source, 'menu')
  assert.equal(invocation.file.path, 'target.md')
  assert.equal(invocation.file.kind, 'file')
  assert.ok(invocation.file.fileId)
  assert.equal(invocation.workspace.workspaceId, invocation.file.workspaceId)
  assert.equal(
    await page.evaluate(() => window.hibi.getDocument().then((x) => x.name)),
    'active.md',
  )

  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  await page.locator('#addon-explorer-probe').click()
  await page.getByRole('button', { name: 'Back to app' }).click()
  await page
    .getByRole('main', { name: /^settings$/i })
    .waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'Actions for target.md' }).click()
  assert.equal(
    await targetMenu()
      .getByRole('menuitem', { name: 'Inspect clicked file' })
      .count(),
    0,
  )
})
