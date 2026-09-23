import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'
import { uiName } from './ui.mjs'

test('startup placeholder stays out of documents and reopens persisted recent workspaces', {
  timeout: 45000,
}, async (t) => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'hibi-startup-')))
  const profile = join(temp, 'profile')
  let app
  async function launch() {
    app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${profile}`],
    })
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    const page = await app.firstWindow()
    page.setDefaultTimeout(6500)
    await page.getByRole('textbox', { name: /document editor/i }).waitFor()
    return page
  }
  t.after(async () => {
    await app?.close()
    await rm(temp, { recursive: true, force: true })
  })
  let page = await launch()
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  const bootstrap = await page.evaluate(() => window.hibi.bootstrap.document())
  assert.equal(bootstrap.externalPending, false)
  assert.equal(bootstrap.document.markdown, '')
  assert.equal(bootstrap.document.tabs.length, 0)
  assert.equal(bootstrap.workspace, null)
  assert.deepEqual(
    await page.evaluate(() => window.hibi.bootstrap.addons()),
    await page.evaluate(async () => ({
      states: await window.hibi.getAddonStates(),
      packages: await window.hibi.getInstalledAddons(),
      notices: [],
    })),
  )
  const welcome = () => page.getByRole('region', { name: /start writing/i })
  await welcome()
    .getByRole('heading', { name: /start typing/i })
    .waitFor()
  await welcome()
    .getByText(/no recent workspaces yet\./i)
    .waitFor()
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    '',
  )
  const rich = page.getByRole('textbox', { name: /document editor/i })
  await pressShortcut(app, `${mod}+Shift+]`)
  assert.equal(await welcome().isVisible(), true)
  await pressShortcut(app, `${mod}+Shift+[`)
  await rich.press('a')
  await welcome().waitFor({ state: 'hidden' })
  assert.deepEqual(
    (await page.evaluate(() => window.hibi.getDocument())).tabs.map(
      (tab) => tab.name,
    ),
    ['untitled.md'],
  )
  await rich.fill('')
  assert.equal(await welcome().count(), 0)
  await page.locator('.document-tab .tab-close').click()
  await welcome().waitFor()
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).tabs.length,
    0,
  )
  await pressShortcut(app, `${mod}+n`)
  await welcome().waitFor({ state: 'hidden' })

  const folders = []
  for (let index = 1; index <= 6; index++) {
    const path = join(temp, `workspace ${index}`)
    folders.unshift(path)
    await mkdir(path)
    await writeFile(join(path, 'empty.md'), '')
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      })
    }, path)
    await page.evaluate(() => window.hibi.openWorkspace())
  }
  const recent = await page.evaluate(() => window.hibi.getRecentWorkspaces())
  assert.deepEqual(
    recent.map((item) => item.path),
    folders.slice(0, 5),
  )
  await assert.rejects(
    page.evaluate(() => window.hibi.openRecentWorkspace('/unapproved/path')),
    /recent list/,
  )
  await page.evaluate((id) => window.hibi.openRecentWorkspace(id), recent[1].id)
  const reordered = [folders[1], folders[0], ...folders.slice(2, 5)]
  assert.deepEqual(
    JSON.parse(await readFile(join(profile, 'recent-workspaces.json'), 'utf8')),
    reordered,
  )
  await app.close()
  app = null

  // A fresh process has an empty startup draft and the same workspace history.
  page = await launch()
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).tabs.length,
    0,
  )
  await welcome()
    .getByRole('button', { name: uiName(reordered[0], true), exact: true })
    .waitFor()
  assert.equal(await welcome().locator('li').count(), 5)
  await rm(reordered[0], { recursive: true })
  await welcome()
    .getByRole('button', { name: uiName(reordered[0], true), exact: true })
    .click()
  await page
    .locator('.toast')
    .filter({ hasText: /ENOENT|no such file/i })
    .waitFor()
  assert.equal(await welcome().isVisible(), true)
  await welcome()
    .getByRole('button', { name: uiName(reordered[1], true), exact: true })
    .click()
  assert.equal(await welcome().isVisible(), true)
  await page
    .getByRole('treeitem', { name: /^empty\.md$/i, exact: true })
    .click()
  await welcome().waitFor({ state: 'hidden' })
  await page.locator('.tiptap p[data-placeholder="Start typing"]').waitFor()
  assert.equal(
    await page.locator('.tiptap p').getAttribute('data-placeholder'),
    'Start typing',
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    '',
  )
  await app.close()
  app = null

  const outside = join(temp, 'outside.md')
  await writeFile(outside, 'outside note')
  page = await launch()
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).tabs.length,
    0,
  )
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    })
  }, outside)
  await welcome()
    .getByRole('button', { name: /open a file/i })
    .click()
  await welcome().waitFor({ state: 'hidden' })
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'outside note',
  )
  await app.close()
  app = null

  page = await launch()
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).tabs.length,
    0,
  )
  await welcome()
    .getByRole('button', { name: /dismiss this screen/i })
    .click()
  await welcome().waitFor({ state: 'hidden' })
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).tabs.length,
    1,
  )
  assert.equal(
    await page
      .getByRole('textbox', { name: /document editor/i })
      .evaluate((element) => element === document.activeElement),
    true,
  )
  await page.reload()
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  assert.equal(await welcome().count(), 0)
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    '',
  )
})
