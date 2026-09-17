import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('file tabs preserve independent drafts and guard closing, saving, and workspace mutations', {
  timeout: 40000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-tabs-'))
  const notes = join(root, 'notes')
  await mkdir(join(notes, 'folder'), { recursive: true })
  const a = join(notes, 'folder/a.md'),
    b = join(notes, 'b.md')
  await writeFile(a, 'original a')
  await writeFile(b, 'original b')
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
  await app.evaluate(({ dialog }) => {
    globalThis.choices = []
    globalThis.choice = 2
    dialog.showMessageBox = async (_window, options) => {
      globalThis.choices.push(options.message)
      return { response: globalThis.choice }
    }
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(6500)
  const rich = page.getByRole('textbox', { name: /document editor/i })
  await rich.waitFor()
  const read = () => page.evaluate(() => window.hibi.getDocument())
  const choose = (file) =>
    app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      })
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
    }, file)
  const waitEditable = () =>
    page.waitForFunction(
      () =>
        document.querySelector('.tiptap')?.getAttribute('contenteditable') ===
        'true',
    )
  await rich.fill('untitled draft')
  const untitled = (await read()).tabId
  await clickMenu(app, 'New')
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId !== id,
    untitled,
  )
  await page.locator(`[data-tab-id="${untitled}"]`).click()
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).markdown === 'untitled draft',
  )
  await choose(a)
  await clickMenu(app, 'Open…')
  await page.getByRole('tab', { name: /^a\.md$/i, exact: true }).waitFor()
  await waitEditable()
  await rich.fill('draft a')
  const aTab = (await read()).tabId
  await choose(b)
  await clickMenu(app, 'Open…')
  await page.getByRole('tab', { name: /^b\.md$/i, exact: true }).waitFor()
  const bTab = (await read()).tabId
  assert.equal(
    await page
      .getByRole('button', { name: /^rename document$/i, exact: true })
      .count(),
    0,
  )
  await page.getByRole('tab', { name: /^b\.md$/i, exact: true }).dblclick()
  assert.equal(
    await page
      .getByRole('textbox', { name: /^file name$/i, exact: true })
      .count(),
    0,
  )
  assert.deepEqual(await app.evaluate(() => globalThis.choices), [])
  assert.equal((await read()).tabs.find((tab) => tab.id === aTab).dirty, true)
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].close(),
  )
  assert.equal(
    await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
    1,
  )
  assert.equal((await read()).tabId, bTab)
  await page
    .getByRole('button', { name: /^close a\.md$/i, exact: true })
    .click()
  await page.waitForFunction(
    () => document.querySelector('.app').getAttribute('aria-busy') === 'false',
  )
  assert.equal(
    (await read()).tabs.some((tab) => tab.id === aTab),
    true,
  )
  await app.evaluate(() => {
    globalThis.choice = 0
  })
  await page
    .getByRole('button', { name: /^close a\.md$/i, exact: true })
    .click()
  await page
    .getByRole('tab', { name: /^a\.md$/i, exact: true })
    .waitFor({ state: 'hidden' })
  assert.equal(await readFile(a, 'utf8'), 'draft a')
  assert.equal((await read()).tabId, bTab)
  await page.locator(`[data-tab-id="${untitled}"]`).click()
  await waitEditable()
  await clickMenu(app, 'Save')
  await page
    .getByRole('alert')
    .filter({ hasText: /already open in another tab/i })
    .waitFor()
  assert.equal(await readFile(b, 'utf8'), 'original b')
  await choose(a)
  await clickMenu(app, 'Open…')
  await page.getByRole('tab', { name: /^a\.md$/i, exact: true }).waitFor()
  await waitEditable()
  await rich.fill('moved draft')
  await page.getByRole('tab', { name: /^b\.md$/i, exact: true }).click()
  await choose(notes)
  await page.evaluate(() => window.hibi.openWorkspace())
  await page.evaluate(() =>
    window.hibi.workspaceAction({
      action: 'rename',
      path: 'folder',
      destination: 'renamed',
    }),
  )
  const moved = (await read()).tabs.find((tab) => tab.name === 'a.md')
  await page.evaluate((id) => window.hibi.selectDocumentTab(id), moved.id)
  assert.equal((await read()).markdown, 'moved draft')
  await page.evaluate(() => window.hibi.saveDocument(false))
  assert.equal(
    await readFile(join(notes, 'renamed/a.md'), 'utf8'),
    'moved draft',
  )
  await page.evaluate(() => window.hibi.updateDocument('do not delete yet'))
  await page.evaluate((id) => window.hibi.selectDocumentTab(id), bTab)
  await app.evaluate(() => {
    globalThis.choice = 2
  })
  assert.equal(
    await page.evaluate(() =>
      window.hibi.workspaceAction({ action: 'delete', path: 'renamed' }),
    ),
    null,
  )
  assert.equal(
    await readFile(join(notes, 'renamed/a.md'), 'utf8'),
    'moved draft',
  )
  const first = await page.evaluate(() =>
    window.hibi.workspaceAction({ action: 'new-file', path: '' }),
  )
  const second = await page.evaluate(() =>
    window.hibi.workspaceAction({ action: 'new-file', path: '' }),
  )
  assert.notEqual(first.path, second.path)
  assert.equal(
    (await page.evaluate(() => window.hibi.getWorkspace())).entries
      .flatMap((entry) => [entry, ...(entry.children ?? [])])
      .filter((entry) => entry.dirty).length,
    3,
  )
  await page.evaluate((path) => window.hibi.openWorkspaceFile(path), first.path)
  assert.equal((await read()).tabId, first.document.tabId)
  await assert.rejects(
    page.evaluate(() =>
      window.hibi.openWorkspaceFile('../notes/' + 'untitled.md'),
    ),
    /invalid workspace/,
  )
  await assert.rejects(
    page.evaluate(() => window.hibi.selectDocumentTab('invented')),
    /no longer open/,
  )
  await app.evaluate(({ shell }) => {
    globalThis.choice = 1
    shell.trashItem = (path) =>
      process.getBuiltinModule('fs/promises').rm(path, { recursive: true })
  })
  await page.evaluate(() =>
    window.hibi.workspaceAction({ action: 'delete', path: 'renamed' }),
  )
  assert.equal(
    (await read()).tabs.some((tab) => tab.id === moved.id),
    false,
  )
  for (const tab of (await read()).tabs)
    await page.evaluate((id) => window.hibi.closeDocumentTab(id), tab.id)
  assert.equal((await read()).tabs.length, 1)
  assert.equal((await read()).markdown, '')
  await page.reload()
  await rich.waitFor()
  assert.equal(
    await page.getByRole('region', { name: /start writing/i }).count(),
    0,
  )
  const lastTab = (await read()).tabId
  await clickMenu(app, 'New')
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId !== id,
    lastTab,
  )
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+w' : 'Control+w',
  )
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId === id,
    lastTab,
  )
  assert.equal((await read()).tabs.length, 1)
})
