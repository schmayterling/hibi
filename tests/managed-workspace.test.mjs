import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'

test('managed workspaces stay opt-in, preserve files, import safely, and reopen at startup', {
  timeout: 90000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-managed-'))
  const profile = join(root, 'profile'),
    workspace = join(root, 'notes'),
    source = join(root, 'source'),
    moved = join(root, 'moved')
  for (const path of [profile, workspace, source, moved]) await mkdir(path)
  await writeFile(join(workspace, 'Start.md'), '# Welcome')
  await writeFile(join(workspace, 'hidden.md'), 'Hidden')
  await writeFile(join(source, 'Start.md'), '# Imported')
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'import-obsidian': true }),
  )
  let app
  t.after(async () => {
    if (app) {
      await app.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1 })
      })
      await app.close()
    }
    await rm(root, { recursive: true, force: true })
  })
  const launch = async () => {
    app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${profile}`],
    })
    const page = await app.firstWindow()
    page.setDefaultTimeout(10000)
    await page
      .getByRole('textbox', { name: 'Document editor', exact: true })
      .waitFor()
    return page
  }
  let page = await launch()
  assert.equal(
    (await page.evaluate(() => window.hibi.getWorkspaceSettings())).enabled,
    false,
  )
  assert.equal(await page.evaluate(() => window.hibi.getWorkspace()), null)
  const choose = (path) =>
    app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      })
    }, path)
  await choose(workspace)
  await page.evaluate(() => window.hibi.openWorkspace())
  let state = await page.evaluate(() => window.hibi.getWorkspaceSettings())
  assert.equal(state.manifest, null)
  await assert.rejects(
    page.evaluate(() =>
      window.hibi.importIntoWorkspace({
        id: 'folder',
        source: 'folder',
        workspaceId: '',
      }),
    ),
    /Hibi workspace/,
  )
  state = await page.evaluate(() =>
    window.hibi.updateWorkspaceSettings({ action: 'create-manifest' }),
  )
  assert.deepEqual(
    JSON.parse(
      await readFile(join(workspace, '.hibi', 'workspace.json'), 'utf8'),
    ),
    state.manifest,
  )
  await assert.rejects(readFile(join(workspace, '.hibi.json')), {
    code: 'ENOENT',
  })
  const manifest = {
    ...state.manifest,
    name: 'My library',
    description: 'Notes',
    icon: 'book-open',
    defaultFile: 'Start.md',
  }
  state = await page.evaluate(
    ({ manifest, revision }) =>
      window.hibi.updateWorkspaceSettings({
        action: 'save-manifest',
        manifest,
        revision,
        ignore: 'hidden.md\n',
      }),
    { manifest, revision: state.manifestRevision },
  )
  const snapshot = await page.evaluate(() => window.hibi.getWorkspace())
  assert.equal(
    await readFile(join(workspace, '.hibi', 'ignore'), 'utf8'),
    'hidden.md\n',
  )
  assert.ok(!snapshot.entries.some((entry) => entry.path.startsWith('.hibi')))
  assert.equal(snapshot.name, 'My library')
  assert.ok(!snapshot.entries.some((entry) => entry.path === 'hidden.md'))
  await assert.rejects(
    page.evaluate(
      (manifest) =>
        window.hibi.updateWorkspaceSettings({
          action: 'save-manifest',
          manifest,
          revision: 'stale',
          ignore: '',
        }),
      manifest,
    ),
    /changed on disk/,
  )
  await choose(workspace)
  await page.evaluate(() =>
    window.hibi.updateWorkspaceSettings({ action: 'choose' }),
  )
  await page.evaluate(() =>
    window.hibi.updateWorkspaceSettings({
      action: 'startup',
      startup: 'managed',
    }),
  )
  const importers = await page.evaluate(() => window.hibi.listImporters())
  assert.deepEqual(
    importers.map((item) => item.id),
    ['folder', 'import-obsidian'],
  )
  await choose(source)
  const imported = await page.evaluate(
    (workspaceId) =>
      window.hibi.importIntoWorkspace({
        id: 'folder',
        source: 'folder',
        workspaceId,
      }),
    snapshot.id,
  )
  assert.equal(imported.files, 1)
  assert.equal(await readFile(join(workspace, 'Start.md'), 'utf8'), '# Welcome')
  assert.equal(await readFile(join(source, 'Start.md'), 'utf8'), '# Imported')
  assert.equal(
    await readFile(
      join(workspace, imported.folder, 'Imported files', 'Start.md'),
      'utf8',
    ),
    '# Imported',
  )
  const second = await page.evaluate(
    (workspaceId) =>
      window.hibi.importIntoWorkspace({
        id: 'folder',
        source: 'folder',
        workspaceId,
      }),
    snapshot.id,
  )
  assert.notEqual(second.folder, imported.folder)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await pressShortcut(app, `${mod}+,`)
  await page
    .getByRole('tab', { name: 'Workspace settings', exact: true })
    .click()
  await page.getByLabel('Workspace name', { exact: true }).waitFor()
  await page.screenshot({ path: 'test-results/workspace-settings.png' })
  await page.getByRole('button', { name: /^Import…$/i, exact: true }).click()
  await page.getByRole('dialog', { name: /^Import into workspace$/i }).waitFor()
  await page.waitForFunction(() => {
    const dialog = document.querySelector('dialog[open]')
    return (
      dialog &&
      getComputedStyle(dialog).opacity === '1' &&
      dialog
        .getAnimations()
        .every((animation) => animation.playState === 'finished')
    )
  })
  assert.equal(
    await page
      .locator('dialog[open]')
      .evaluate((dialog) => getComputedStyle(dialog).opacity),
    '1',
  )
  await page.screenshot({
    path: 'test-results/workspace-import.png',
    animations: 'disabled',
  })
  await page.getByRole('button', { name: /^Cancel$/i, exact: true }).click()
  await choose(moved)
  await page.evaluate(() =>
    window.hibi.updateWorkspaceSettings({ action: 'relocate' }),
  )
  assert.equal(
    await readFile(join(moved, 'notes', 'Start.md'), 'utf8'),
    '# Welcome',
  )
  await app.close()
  app = null
  page = await launch()
  await page.waitForFunction(
    () =>
      document
        .querySelector('.document-tab')
        ?.textContent?.includes('Start.md') ||
      document.querySelector('.tiptap')?.textContent?.includes('Welcome'),
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getWorkspace())).name,
    'My library',
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).name,
    'Start.md',
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getWorkspaceSettings())).enabled,
    true,
  )
})
