import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { waitForAsync } from './poll.mjs'

test('pending explorer pages block stale opens and drags without blocking the editor', {
  timeout: 30000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-view-pending-'))
  const first = join(root, 'first')
  const second = join(root, 'second')
  await mkdir(first)
  await mkdir(second)
  await writeFile(join(first, 'one.md'), '# One')
  await writeFile(join(second, 'two.md'), '# Two')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      globalThis.workspacePending?.release()
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ dialog }, first) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [first],
    })
  }, first)
  await page.evaluate(() => window.hibi.openWorkspace(false))
  await page.getByRole('button', { name: /toggle workspace sidebar/i }).click()
  const tree = page.getByRole('tree', { name: 'Workspace files' })
  const one = tree.getByRole('treeitem', { name: 'one.md', exact: true })
  await one.waitFor()
  await waitForAsync(
    page,
    () =>
      document
        .querySelector('.workspace-sidebar [role="tree"]')
        ?.getAttribute('aria-busy') !== 'true',
  )
  await app.evaluate(({ ipcMain }) => {
    const host = { opens: 0, actions: 0, held: null, release() {}, seen: false }
    globalThis.workspacePending = host
    host.arm = () => {
      host.seen = false
      host.held = new Promise((resolve) => {
        host.release = () => {
          host.held = null
          resolve()
        }
      })
    }
    const handlers = ipcMain._invokeHandlers
    for (const [channel, counter] of [
      ['workspace:open-file', 'opens'],
      ['workspace:action', 'actions'],
    ]) {
      const handle = handlers.get(channel)
      handlers.set(channel, (...args) => {
        host[counter]++
        return handle(...args)
      })
    }
    const read = handlers.get('workspace:view-page')
    handlers.set('workspace:view-page', async (...args) => {
      const result = await read(...args)
      if (!args[1].drafts && host.held) {
        host.seen = true
        await host.held
      }
      return result
    })
    host.arm()
  })
  const transfer = await page.evaluateHandle(() => new DataTransfer())
  await one.dispatchEvent('dragstart', { dataTransfer: transfer })
  await one.click({ button: 'right' })
  await page.getByRole('menuitem', { name: /^rename$/i }).click()
  const rename = page.getByRole('textbox', { name: 'Rename item' })
  await rename.fill('renamed.md')
  await rename.press('Enter')
  await waitForAsync(app, () => globalThis.workspacePending.seen)
  await waitForAsync(
    page,
    () => document.querySelector('.app')?.getAttribute('aria-busy') === 'false',
  )
  assert.equal(await tree.getAttribute('aria-busy'), 'true')
  assert.equal(await one.isDisabled(), true)
  await waitForDocumentEditor(app, page)
  await one.dispatchEvent('click')
  await page
    .locator('.workspace-sidebar .sidebar-scroll')
    .dispatchEvent('drop', { dataTransfer: transfer })
  assert.deepEqual(
    await app.evaluate(() => ({
      opens: globalThis.workspacePending.opens,
      actions: globalThis.workspacePending.actions,
    })),
    { opens: 0, actions: 1 },
  )
  await app.evaluate(() => globalThis.workspacePending.release())
  const renamed = tree.getByRole('treeitem', {
    name: 'renamed.md',
    exact: true,
  })
  await renamed.waitFor()
  await waitForAsync(
    page,
    () =>
      document
        .querySelector('.workspace-sidebar [role="tree"]')
        ?.getAttribute('aria-busy') !== 'true',
  )
  assert.equal(await renamed.isDisabled(), false)
  // A drag that started on the previous revision stays stale after publication.
  await page
    .locator('.workspace-sidebar .sidebar-scroll')
    .dispatchEvent('drop', { dataTransfer: transfer })
  assert.equal(await app.evaluate(() => globalThis.workspacePending.actions), 1)

  await app.evaluate(({ dialog }, second) => {
    globalThis.workspacePending.arm()
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [second],
    })
  }, second)
  await page.evaluate(() => window.hibi.openWorkspace(false))
  await waitForAsync(app, () => globalThis.workspacePending.seen)
  await page
    .locator('.workspace-sidebar .sidebar-header')
    .filter({ hasText: 'second' })
    .waitFor()
  assert.equal(await tree.getAttribute('aria-busy'), 'true')
  assert.equal(await tree.getByRole('treeitem').count(), 0)
  await app.evaluate(() => globalThis.workspacePending.release())
  await tree.getByRole('treeitem', { name: 'two.md', exact: true }).waitFor()
  await waitForAsync(
    page,
    () =>
      document
        .querySelector('.workspace-sidebar [role="tree"]')
        ?.getAttribute('aria-busy') !== 'true',
  )
  await transfer.dispose()
})

test('external tree changes retain row focus and failed pages release busy state', {
  timeout: 30000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-tree-focus-'))
  const folder = join(root, 'notes')
  await mkdir(folder)
  await writeFile(join(folder, 'one.md'), '# One')
  await writeFile(join(folder, 'zero.md'), '# Zero')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      globalThis.focusPages?.release()
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [folder],
    })
  }, folder)
  await page.evaluate(() => window.hibi.openWorkspace(false))
  await page.getByRole('button', { name: /toggle workspace sidebar/i }).click()
  const tree = page.getByRole('tree', { name: 'Workspace files' })
  const one = tree.getByRole('treeitem', { name: 'one.md', exact: true })
  await one.waitFor()
  await waitForAsync(
    page,
    () =>
      document
        .querySelector('.workspace-sidebar [role="tree"]')
        ?.getAttribute('aria-busy') !== 'true',
  )
  await app.evaluate(({ ipcMain }) => {
    const host = { seen: false, fail: false }
    host.held = new Promise((resolve) => {
      host.release = () => {
        host.held = null
        resolve()
      }
    })
    globalThis.focusPages = host
    const handlers = ipcMain._invokeHandlers
    const read = handlers.get('workspace:view-page')
    handlers.set('workspace:view-page', async (...args) => {
      if (host.fail) {
        host.fail = false
        throw new Error('page read failed')
      }
      const result = await read(...args)
      if (!args[1].drafts && host.held) {
        host.seen = true
        await host.held
      }
      return result
    })
  })
  await one.focus()
  await writeFile(join(folder, 'z.md'), '# External')
  await waitForAsync(app, () => globalThis.focusPages.seen)
  assert.equal(await tree.getAttribute('aria-busy'), 'true')
  assert.equal(
    await one.evaluate((row) => row === document.activeElement),
    true,
  )
  assert.equal(await one.getAttribute('aria-disabled'), 'true')
  assert.equal(await one.evaluate((row) => row.disabled), false)
  const zero = tree.getByRole('treeitem', { name: 'zero.md', exact: true })
  await one.press('End')
  assert.equal(
    await zero.evaluate((row) => row === document.activeElement),
    true,
  )
  await zero.press('Home')
  assert.equal(
    await one.evaluate((row) => row === document.activeElement),
    true,
  )
  await one.press('ArrowDown')
  assert.equal(
    await zero.evaluate((row) => row === document.activeElement),
    true,
  )
  await zero.press('ArrowUp')
  assert.equal(
    await one.evaluate((row) => row === document.activeElement),
    true,
  )
  const more = page.getByRole('button', {
    name: 'Actions for one.md',
    exact: true,
  })
  await more.focus()
  assert.equal(
    await more.evaluate((button) => button === document.activeElement),
    true,
  )
  assert.equal(await more.evaluate((button) => button.disabled), false)
  assert.equal(await more.getAttribute('aria-disabled'), 'true')
  await more.dispatchEvent('click')
  assert.equal(await page.getByRole('menu').count(), 0)
  await one.focus()
  await app.evaluate(() => globalThis.focusPages.release())
  await tree.getByRole('treeitem', { name: 'z.md', exact: true }).waitFor()
  await waitForAsync(
    page,
    () =>
      document
        .querySelector('.workspace-sidebar [role="tree"]')
        ?.getAttribute('aria-busy') !== 'true',
  )
  assert.equal(
    await one.evaluate((row) => row === document.activeElement),
    true,
  )
  await app.evaluate(() => {
    globalThis.focusPages.fail = true
  })
  await writeFile(join(folder, 'two.md'), '# Retry')
  await page.getByText(/page read failed/).waitFor()
  assert.notEqual(await tree.getAttribute('aria-busy'), 'true')
  assert.equal(
    await one.evaluate((row) => row === document.activeElement),
    true,
  )
  await page
    .getByRole('button', { name: 'Refresh workspace', exact: true })
    .click()
  await tree.getByRole('treeitem', { name: 'two.md', exact: true }).waitFor()
  await waitForAsync(
    page,
    () =>
      document
        .querySelector('.workspace-sidebar [role="tree"]')
        ?.getAttribute('aria-busy') !== 'true',
  )
})
