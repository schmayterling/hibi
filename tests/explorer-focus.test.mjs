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
import { electron, waitForDocumentEditor } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('workspace creation keeps typing in rename and accepts names on click away', {
  timeout: 60000,
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'hibi-explorer-focus-'))
  const root = join(temp, 'workspace')
  await mkdir(join(root, 'parent'), { recursive: true })
  await writeFile(join(root, 'existing.md'), '# Keep this content')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(temp, 'profile')}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      globalThis.__releaseHeldWorkspaceOpen?.()
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(temp, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(8000)
  await page.setViewportSize({ width: 1100, height: 800 })
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await app.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] })
  }, root)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await pressShortcut(app, `${mod}+Shift+o`)
  const tree = page.getByRole('tree', { name: /workspace files/i })
  await page.locator('.app[aria-busy="false"]').waitFor()
  await tree.getByRole('treeitem', { name: 'existing.md', exact: true }).click()
  await waitForAsync(
    page,
    async () =>
      (await window.hibi.getWorkspace())?.activePath === 'existing.md',
    null,
    { timeout: 8000, polling: 100 },
  )
  await page.locator('.app[aria-busy="false"]').waitFor()
  const rename = page.getByRole('textbox', { name: 'Rename item', exact: true })
  await page
    .getByRole('button', { name: 'Actions for existing.md', exact: true })
    .click()
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
  await rename.fill('interrupted.md')
  await app.evaluate(({ dialog }, root) => {
    let entered
    globalThis.__heldWorkspaceOpenEntered = new Promise((resolve) => {
      entered = resolve
    })
    dialog.showOpenDialog = () =>
      new Promise((resolve) => {
        globalThis.__releaseHeldWorkspaceOpen = () => {
          globalThis.__releaseHeldWorkspaceOpen = undefined
          resolve({ canceled: false, filePaths: [root] })
        }
        entered()
      })
  }, root)
  await pressShortcut(app, `${mod}+Shift+o`)
  await app.evaluate(() =>
    Promise.race([
      globalThis.__heldWorkspaceOpenEntered,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('workspace dialog did not open')),
          8000,
        ),
      ),
    ]),
  )
  await page.locator('.app[aria-busy="true"]').waitFor()
  assert.equal(await rename.isEnabled(), false)
  assert.equal(
    await readFile(join(root, 'existing.md'), 'utf8'),
    '# Keep this content',
  )
  await assert.rejects(access(join(root, 'interrupted.md')))
  assert.equal(
    await page
      .getByRole('button', { name: 'New workspace file', exact: true })
      .isEnabled(),
    false,
  )
  assert.equal(
    await page
      .getByRole('button', { name: 'Actions for parent', exact: true })
      .isEnabled(),
    false,
  )
  assert.equal(
    await tree
      .getByRole('treeitem', { name: 'parent', exact: true })
      .isEnabled(),
    false,
  )
  await app.evaluate(() => globalThis.__releaseHeldWorkspaceOpen())
  await page.locator('.app[aria-busy="false"]').waitFor()
  await rename.waitFor({ state: 'hidden' })
  for (const mode of ['rich', 'source']) {
    if (mode === 'source') {
      await pressShortcut(app, `${mod}+Shift+]`)
      await page.getByRole('textbox', { name: /markdown editor/i }).waitFor()
    }
    for (const parent of ['', 'parent']) {
      for (const kind of ['file', 'folder']) {
        const before = (await page.evaluate(() => window.hibi.getDocument()))
          .markdown
        if (parent) {
          await page
            .getByRole('button', { name: 'Actions for parent', exact: true })
            .click()
          await page
            .getByRole('menuitem', { name: `New ${kind}`, exact: true })
            .click()
        } else
          await page
            .getByRole('button', { name: `New workspace ${kind}`, exact: true })
            .click()
        await rename.waitFor()
        await page.waitForFunction(() =>
          document
            .querySelector('input[aria-label="Rename item"]')
            ?.matches(':enabled'),
        )
        // Let editor mounts and popover focus restoration finish before typing.
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        )
        assert.equal(
          await rename.evaluate((input) => input === document.activeElement),
          true,
          `${mode} ${parent || 'root'} ${kind} owns focus`,
        )
        const name = `${mode}-${parent || 'root'}-${kind}${kind === 'file' ? '.md' : ''}`
        await page.keyboard.type(name)
        assert.equal(await rename.inputValue(), name)
        await page
          .getByRole('button', { name: 'Refresh workspace', exact: true })
          .click()
        await rename.waitFor({ state: 'hidden' })
        await tree.getByRole('treeitem', { name, exact: true }).waitFor()
        if (kind === 'folder') await access(join(root, parent, name))
        assert.equal(
          (await page.evaluate(() => window.hibi.getDocument())).markdown,
          kind === 'file' ? '' : before,
        )
      }
    }
  }
  await page
    .getByRole('button', { name: 'Actions for parent', exact: true })
    .click()
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
  await page.keyboard.type('renamed-parent')
  assert.equal(await rename.inputValue(), 'renamed-parent')
  await page
    .getByRole('button', { name: 'Refresh workspace', exact: true })
    .click()
  await rename.waitFor({ state: 'hidden' })
  await access(join(root, 'renamed-parent', 'rich-parent-folder'))
  await access(join(root, 'renamed-parent', 'source-parent-folder'))
  // Escape cancels the edited name without a blur commit.
  await page
    .getByRole('button', { name: 'Actions for existing.md', exact: true })
    .click()
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
  await page.keyboard.type('cancelled.md')
  await page.keyboard.press('Escape')
  await rename.waitFor({ state: 'hidden' })
  await tree
    .getByRole('treeitem', { name: 'existing.md', exact: true })
    .waitFor()
  assert.equal(
    await readFile(join(root, 'existing.md'), 'utf8'),
    '# Keep this content',
  )
  await assert.rejects(access(join(root, 'cancelled.md')))
})

async function pendingRename(t) {
  const temp = await mkdtemp(join(tmpdir(), 'hibi-rename-refresh-'))
  const root = join(temp, 'notes')
  await mkdir(root)
  await writeFile(join(root, 'existing.md'), '# Existing')
  await writeFile(join(root, 'other.md'), '# Other')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(temp, 'profile')}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      globalThis.renamePages?.release()
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(temp, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(8000)
  await page.setViewportSize({ width: 1100, height: 800 })
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] })
  }, root)
  await pressShortcut(
    app,
    `${process.platform === 'darwin' ? 'Meta' : 'Control'}+Shift+o`,
  )
  const tree = page.getByRole('tree', { name: 'Workspace files' })
  await tree.getByRole('treeitem', { name: 'existing.md', exact: true }).click()
  await waitForAsync(
    page,
    async () =>
      (await window.hibi.getWorkspace())?.activePath === 'existing.md',
  )
  await waitForDocumentEditor(app, page)
  await waitForAsync(
    page,
    () =>
      document
        .querySelector('.workspace-sidebar [role="tree"]')
        ?.getAttribute('aria-busy') !== 'true',
  )
  await app.evaluate(({ ipcMain }) => {
    const state = {
      held: null,
      seen: false,
      failed: false,
      release() {},
    }
    globalThis.renamePages = state
    state.hold = () => {
      state.seen = false
      state.held = new Promise((resolve) => {
        state.release = () => {
          state.held = null
          resolve()
        }
      })
    }
    const handlers = ipcMain._invokeHandlers
    const read = handlers.get('workspace:view-page')
    handlers.set('workspace:view-page', async (...args) => {
      const result = await read(...args)
      if (state.held && !args[1].drafts) {
        state.seen = true
        await state.held
      }
      return result
    })
    const action = handlers.get('workspace:action')
    handlers.set('workspace:action', async (...args) => {
      try {
        return await action(...args)
      } catch (error) {
        state.failed = true
        throw error
      }
    })
  })
  const rename = page.getByRole('textbox', { name: 'Rename item', exact: true })
  const editor = page.getByRole('textbox', {
    name: 'Document editor',
    exact: true,
  })
  const begin = async () => {
    await page
      .getByRole('button', { name: 'Actions for other.md', exact: true })
      .click()
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
    await rename.waitFor()
  }
  const refresh = async () => {
    await app.evaluate(() => globalThis.renamePages.hold())
    await writeFile(join(root, 'external.md'), '# External')
    await waitForAsync(app, () => globalThis.renamePages.seen)
    assert.equal(await tree.getAttribute('aria-busy'), 'true')
  }
  const release = async () => {
    await app.evaluate(() => globalThis.renamePages.release())
    await waitForAsync(
      page,
      () =>
        document
          .querySelector('.workspace-sidebar [role="tree"]')
          ?.getAttribute('aria-busy') !== 'true',
    )
  }
  return { app, page, root, tree, rename, editor, begin, refresh, release }
}

test('rename text survives a pending explorer refresh', async (t) => {
  const { page, root, rename, begin, refresh, release } = await pendingRename(t)
  await begin()
  await page.keyboard.type('quarterly-')
  await refresh()
  await page.keyboard.press('Enter')
  assert.equal(await rename.isVisible(), true)
  await access(join(root, 'other.md'))
  await release()
  await page.keyboard.type('report')
  assert.equal(await rename.inputValue(), 'quarterly-report.md')
  await page.keyboard.press('Enter')
  await rename.waitFor({ state: 'hidden' })
  assert.equal(
    await readFile(join(root, 'quarterly-report.md'), 'utf8'),
    '# Other',
  )
})

test('rename refresh keeps intentional editor focus', async (t) => {
  const { page, rename, editor, begin, refresh, release } =
    await pendingRename(t)
  await begin()
  await page.keyboard.type('draft-name')
  await refresh()
  await editor.click()
  await page.keyboard.type('Hello ')
  await release()
  await page.keyboard.type('world')
  assert.equal(
    await editor.evaluate((element) => element === document.activeElement),
    true,
  )
  assert.equal(await rename.inputValue(), 'draft-name.md')
  assert.equal(await rename.isVisible(), true)
  assert.match(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    /Hello world/,
  )
})

test('new rename captures typing before pending pages finish', async (t) => {
  const { page, tree, rename, refresh, release } = await pendingRename(t)
  await page
    .getByRole('button', { name: 'New workspace file', exact: true })
    .click()
  await rename.waitFor()
  await waitForAsync(
    page,
    () =>
      document
        .querySelector('.workspace-sidebar [role="tree"]')
        ?.getAttribute('aria-busy') !== 'true',
  )
  await refresh()
  await page.keyboard.type('meet')
  await release()
  await page.keyboard.type('ing.md')
  assert.equal(await rename.inputValue(), 'meeting.md')
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    '',
  )
  await page.keyboard.press('Enter')
  await rename.waitFor({ state: 'hidden' })
  await tree
    .getByRole('treeitem', { name: 'meeting.md', exact: true })
    .waitFor()
})

test('failed rename keeps focus in the editor', async (t) => {
  const { app, page, rename, editor, begin } = await pendingRename(t)
  await begin()
  await page.keyboard.type('existing')
  assert.equal(await rename.inputValue(), 'existing.md')
  await editor.click()
  await waitForAsync(app, () => globalThis.renamePages.failed)
  await page.waitForFunction(
    () =>
      document
        .querySelector('input[aria-label="Rename item"]')
        ?.matches(':enabled') &&
      document.querySelector('.app')?.getAttribute('aria-busy') === 'false',
  )
  await page.keyboard.type('typed')
  assert.equal(
    await editor.evaluate((element) => element === document.activeElement),
    true,
  )
  assert.equal(await rename.isVisible(), true)
  assert.equal(await rename.inputValue(), 'existing.md')
  assert.match(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    /typed/,
  )
})
