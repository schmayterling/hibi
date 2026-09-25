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
import { electron } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'

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
  await page.waitForFunction(
    async () =>
      (await window.hibi.getWorkspace())?.activePath === 'existing.md',
    null,
    { polling: 100 },
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
