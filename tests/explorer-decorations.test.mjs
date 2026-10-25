import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { pressShortcut, replaceRichText } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('explorer status updates keep the tree model and wait while the explorer is closed', {
  timeout: 60000,
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'hibi-explorer-decorations-'))
  const root = join(temp, 'workspace')
  const profile = join(temp, 'profile')
  const addon = join(profile, 'installed-addons', 'decoration-probe')
  await mkdir(join(root, 'notes'), { recursive: true })
  await mkdir(addon, { recursive: true })
  for (let index = 0; index < 300; index++)
    await writeFile(
      join(root, 'notes', `note-${String(index).padStart(3, '0')}.md`),
      `# Note ${index}`,
    )
  await writeFile(join(root, 'a.md'), '# A')
  await writeFile(
    join(addon, 'hibi-addon.json'),
    JSON.stringify({
      id: 'decoration-probe',
      name: 'Decoration probe',
      description: 'Explorer decoration fixture',
      kind: 'extension',
      version: '1.0.0',
      apiVersion: 2,
      authors: [{ displayName: 'Test' }],
      capabilities: [],
      startup: 'background',
      entry: 'index.js',
    }),
  )
  await writeFile(
    join(addon, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['hibi-addon.json', 'index.js'],
      source: 'local',
    }),
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'decoration-probe': true }),
  )
  await writeFile(
    join(addon, 'index.js'),
    `export default () => ({ start(context) {
      const probe = window.decorationProbe = { calls: 0, result: [] };
      context.workspace.registerDecorations({ id: 'probe', async provide() {
        probe.calls++;
        return probe.result.map(item => ({ ...item }));
      } });
    } });`,
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(temp, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(8000)
  await page.setViewportSize({ width: 1100, height: 800 })
  const editor = page.getByRole('textbox', { name: /document editor/i })
  await editor.waitFor()
  await page.waitForFunction(() => window.decorationProbe)
  await app.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] })
  }, root)
  await pressShortcut(
    app,
    `${process.platform === 'darwin' ? 'Meta' : 'Control'}+Shift+o`,
  )
  // CSS locators keep the closed, inert explorer's rows readable.
  const tree = page.locator('.workspace-sidebar [role="tree"]')
  const row = (path) => tree.locator(`[role="treeitem"][id="sidebar-${path}"]`)
  const badge = (path) => row(path).locator('.sidebar-decoration')
  await page.locator('.app[aria-busy="false"]').waitFor()
  await row('notes').click()
  await row('notes/note-000.md').waitFor()
  const refresh = async (result) => {
    const calls = await page.evaluate((result) => {
      if (result) window.decorationProbe.result = result
      window.dispatchEvent(new Event('focus'))
      return window.decorationProbe.calls
    }, result)
    await page.waitForFunction(
      (calls) => window.decorationProbe.calls > calls,
      calls,
    )
  }
  const status = (badge) => [
    { path: 'notes', label: 'Folder status', badge: '●' },
    { path: 'notes/note-000.md', label: `Status ${badge}`, badge },
  ]
  await refresh(status('1'))
  await badge('notes/note-000.md').filter({ hasText: '1' }).waitFor()

  // Each sidebar model change re-observes the scroller to measure its window.
  await page.evaluate(() => {
    const scroll = document.querySelector('.workspace-sidebar .sidebar-scroll')
    const observe = ResizeObserver.prototype.observe
    window.sidebarModels = 0
    ResizeObserver.prototype.observe = function (target, options) {
      if (target === scroll) window.sidebarModels++
      return observe.call(this, target, options)
    }
  })
  await refresh()
  await refresh(status('2'))
  await badge('notes/note-000.md').filter({ hasText: '2' }).waitFor()
  assert.equal(
    await row('notes/note-000.md').getAttribute('aria-description'),
    'Status 2',
  )
  for (const path of ['notes/note-001.md', 'notes/note-002.md']) {
    await row(path).click()
    await waitForAsync(
      page,
      async (path) => (await window.hibi.getWorkspace())?.activePath === path,
      path,
    )
    await page.locator('.app[aria-busy="false"]').waitFor()
  }
  assert.equal(
    await row('notes/note-002.md').getAttribute('aria-selected'),
    'true',
  )
  await replaceRichText(page, editor, 'unsaved edits')
  await row('notes/note-002.md').locator('.sidebar-dirty').waitFor()
  assert.equal(await row('notes').getAttribute('aria-expanded'), 'true')
  assert.ok((await tree.locator('.sidebar-row').count()) < 60)
  assert.equal(await page.evaluate(() => window.sidebarModels), 0)

  const toggle = page.getByRole('button', { name: /toggle workspace sidebar/i })
  await toggle.click()
  await page.locator('.workspace-sidebar[data-open="false"]').waitFor({
    state: 'attached',
  })
  await refresh(status('3'))
  // Provider results settle in microtasks; one task later an open explorer would show them.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve)))
  assert.equal(await badge('notes/note-000.md').textContent(), '2')
  const calls = await page.evaluate(() => window.decorationProbe.calls)
  await toggle.click()
  await page.locator('.workspace-sidebar[data-open="true"]').waitFor()
  assert.equal(await badge('notes/note-000.md').textContent(), '3')
  assert.equal(
    await page.evaluate(() => window.decorationProbe.calls),
    calls,
    'reopening uses the latest provider result',
  )
  assert.equal(await page.evaluate(() => window.sidebarModels), 0)
  // Expansion still replaces the model, so the counter observes real rebuilds.
  await row('notes').click()
  await page.waitForFunction(() => window.sidebarModels === 1)
  assert.equal(await row('notes').getAttribute('aria-expanded'), 'false')
})
