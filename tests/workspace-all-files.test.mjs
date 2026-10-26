import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForAppState } from './electron.mjs'
import { replaceSourceText } from './keyboard.mjs'

test('workspace can show all files and opens unsupported text in source only', {
  timeout: 60000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-all-files-'))
  const folder = join(root, 'workspace')
  await mkdir(join(folder, '.hidden'), { recursive: true })
  await mkdir(join(folder, 'node_modules'))
  await writeFile(join(folder, 'note.md'), '# note')
  await writeFile(join(folder, 'config.json'), '{"enabled":true}')
  await writeFile(join(folder, '.env'), 'LOCAL=value')
  await writeFile(join(folder, '.hidden', 'secret.json'), '{}')
  await writeFile(join(folder, 'node_modules', 'package.json'), '{}')
  await writeFile(join(root, 'outside.json'), '{}')
  await symlink(join(root, 'outside.json'), join(folder, 'linked.json'))
  await mkdir(join(root, 'profile'))
  await writeFile(
    join(root, 'profile', 'workspace-settings.json'),
    JSON.stringify({
      enabled: false,
      showAllFiles: false,
      entryLimit: 50000,
      path: null,
      startup: 'empty',
      startupFolder: null,
    }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  await page.getByRole('textbox', { name: 'Document editor' }).waitFor()
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, folder)
  await page.evaluate(() => window.hibi.openWorkspace())
  const entries = () =>
    page.evaluate(() =>
      window.hibi.getWorkspace().then((state) => state.entries),
    )
  assert.deepEqual(
    (await entries()).map((entry) => entry.name),
    ['note.md'],
  )

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page
    .getByRole('tab', { name: 'Workspace settings', exact: true })
    .click()
  assert.equal(
    await page.getByRole('combobox', { name: 'Workspace item limit' }).count(),
    0,
  )
  const toggle = page.getByRole('checkbox', {
    name: 'Show all files in sidebar',
  })
  await toggle.click()
  await waitForAppState(page, () =>
    window.hibi.getWorkspaceSettings().then((state) => state.showAllFiles),
  )
  const shown = await entries()
  assert.ok(shown.some((entry) => entry.name === 'config.json'))
  assert.ok(shown.some((entry) => entry.name === '.env'))
  assert.ok(!shown.some((entry) => entry.name === '.hidden'))
  assert.ok(!shown.some((entry) => entry.name === 'node_modules'))
  assert.ok(!shown.some((entry) => entry.name === 'linked.json'))
  await assert.rejects(
    page.evaluate(() =>
      window.hibi.updateWorkspaceSettings({
        action: 'entry-limit',
        limit: 50000,
      }),
    ),
    /Unknown workspace action/,
  )
  const preferences = JSON.parse(
    await readFile(join(root, 'profile', 'workspace-settings.json'), 'utf8'),
  )
  assert.equal(Object.hasOwn(preferences, 'entryLimit'), false)
  assert.equal(preferences.showAllFiles, true)
  const index = await page.evaluate(() => window.hibi.getWorkspaceIndex())
  assert.deepEqual(
    index.pages.map((page) => page.path),
    ['note.md'],
  )
  await assert.rejects(
    page.evaluate(() => window.hibi.openWorkspaceFile('../outside.json')),
    /inside this workspace/,
  )
  await assert.rejects(
    page.evaluate(() => window.hibi.openWorkspaceFile('linked.json')),
    /Symbolic links cannot be opened/,
  )
  await page.getByRole('button', { name: 'Back to app' }).click()
  await page.getByRole('button', { name: 'Toggle workspace sidebar' }).click()
  await page.getByRole('treeitem', { name: 'config.json' }).click()
  const source = page.getByRole('textbox', { name: 'source editor' })
  await source.waitFor()
  assert.equal(await source.textContent(), '{"enabled":true}')
  assert.equal(
    await page.getByRole('button', { name: 'side-by-side' }).isDisabled(),
    true,
  )
  assert.equal(
    await page.getByRole('button', { name: 'normal' }).isDisabled(),
    true,
  )
  await replaceSourceText(page, source, '{"enabled":false}')
  await waitForAppState(page, () =>
    window.hibi
      .getDocument()
      .then(
        (document) =>
          document.markdown === '{"enabled":false}' && document.dirty,
      ),
  )
  await page.evaluate(() => window.hibi.saveDocument(false))
  assert.equal(
    await readFile(join(folder, 'config.json'), 'utf8'),
    '{"enabled":false}',
  )

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page
    .getByRole('tab', { name: 'Workspace settings', exact: true })
    .click()
  await toggle.click()
  await waitForAppState(page, () =>
    window.hibi.getWorkspaceSettings().then((state) => !state.showAllFiles),
  )
  assert.ok(!(await entries()).some((entry) => entry.name === 'config.json'))
})

test('workspace scan accepts uncapped entries and bounded core header responses', {
  timeout: 30000,
}, async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'hibi-workspace-limit-')),
  )
  const folder = join(root, 'workspace')
  await mkdir(folder)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await page.getByRole('textbox', { name: 'Document editor' }).waitFor()
  // Stream virtual entries instead of creating 100,001 disk fixtures.
  await app.evaluate(({ dialog, BrowserWindow }, folder) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [folder],
    })
    const fs = process.getBuiltinModule('node:fs/promises')
    const opendir = fs.opendir
    const host = {
      total: 21000,
      supported: false,
      read: 0,
      closed: 0,
      legacyBroadcasts: 0,
    }
    globalThis.workspaceLimitFixture = host
    const contents = BrowserWindow.getAllWindows()[0].webContents
    const send = contents.send.bind(contents)
    contents.send = (channel, ...args) => {
      if (channel === 'workspace:changed') host.legacyBroadcasts++
      return send(channel, ...args)
    }
    fs.opendir = async (path, ...args) => {
      if (path !== folder) return opendir(path, ...args)
      return {
        async *[Symbol.asyncIterator]() {
          host.read = 0
          try {
            for (let index = 0; index < host.total; index++) {
              host.read++
              yield {
                name: `file-${index}.${host.supported ? 'md' : 'unsupported'}`,
                isDirectory: () => false,
                isSymbolicLink: () => false,
                isFile: () => true,
              }
            }
          } finally {
            host.closed++
          }
        },
      }
    }
    process.getBuiltinModule('node:module').syncBuiltinESMExports()
  }, folder)
  const opened = await page.evaluate(() => window.hibi.openWorkspace(false))
  assert.deepEqual(opened.entries, [])
  assert.equal(
    await app.evaluate(() => globalThis.workspaceLimitFixture.read),
    21000,
  )
  const header = await page.evaluate(() => window.hibi.getWorkspaceHeader())
  assert.equal(Object.hasOwn(header, 'entries'), false)
  assert.equal(header.complete, true)
  assert.equal(header.capReached, false)
  await app.evaluate(() => {
    globalThis.workspaceLimitFixture.total = 100001
  })
  await page.evaluate(() => window.hibi.refreshWorkspace(false))
  assert.equal(
    await app.evaluate(() => globalThis.workspaceLimitFixture.read),
    100001,
  )
  assert.equal(
    await app.evaluate(() => globalThis.workspaceLimitFixture.closed),
    2,
  )
  await app.evaluate(() => {
    globalThis.workspaceLimitFixture.total = 20001
    globalThis.workspaceLimitFixture.supported = true
  })
  const refreshed = await page.evaluate(() =>
    window.hibi.refreshWorkspace(false),
  )
  assert.deepEqual(refreshed.entries, [])
  await page.getByRole('button', { name: 'Toggle workspace sidebar' }).click()
  const first = page.getByRole('treeitem', { name: 'file-0.md', exact: true })
  await first.waitFor()
  await first.focus()
  await first.press('End')
  await page
    .getByRole('treeitem', { name: 'file-20000.md', exact: true })
    .waitFor()
  assert.ok(
    (await page.getByRole('treeitem').count()) < 200,
    'large explorer stays windowed',
  )
  assert.equal(
    await app.evaluate(() => globalThis.workspaceLimitFixture.legacyBroadcasts),
    0,
  )
  await page.evaluate(() => {
    globalThis.legacyEntries = null
    globalThis.stopLegacyWorkspace = window.hibi.onWorkspaceChanged(
      (workspace) => {
        globalThis.legacyEntries = workspace.entries.length
      },
    )
  })
  await page.evaluate(() => window.hibi.refreshWorkspace(false))
  await waitForAppState(page, () => globalThis.legacyEntries === 20001)
  assert.equal(
    await app.evaluate(() => globalThis.workspaceLimitFixture.legacyBroadcasts),
    1,
  )
  await page.evaluate(() => globalThis.stopLegacyWorkspace())
  await page.evaluate(() => window.hibi.refreshWorkspace(false))
  assert.equal(
    await app.evaluate(() => globalThis.workspaceLimitFixture.legacyBroadcasts),
    1,
  )
})
