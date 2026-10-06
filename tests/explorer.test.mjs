import assert from 'node:assert/strict'
import {
  access,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  electron,
  waitForAppState,
  waitForDocumentEditor,
} from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('workspace popovers, durable folders, ephemeral files, inline rename, dirty state, and safe file actions', {
  timeout: 45000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-explorer-profile-'))
  const root = await mkdtemp(join(tmpdir(), 'hibi-explorer-files-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] })
    dialog.showMessageBox = async () => ({ response: 1 })
  }, root)
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await waitForDocumentEditor(app, page)
  await pressShortcut(app, `${mod}+Shift+o`)
  await waitForAppState(page, async () => !!(await window.hibi.getWorkspace()))
  await waitForDocumentEditor(app, page)
  await page.getByRole('button', { name: /new workspace folder/i }).click()
  const rename = page.getByRole('textbox', { name: /rename item/i })
  await rename.waitFor()
  const renameStyle = await rename.evaluate((input) => {
    const style = getComputedStyle(input)
    return {
      border: style.borderTopWidth,
      fontSize: style.fontSize,
      height: input.getBoundingClientRect().height,
      outlineOffset: style.outlineOffset,
      shadow: style.boxShadow,
      icons: input.parentElement.querySelectorAll('svg').length,
    }
  })
  assert.deepEqual(renameStyle, {
    border: '1px',
    fontSize: '13px',
    height: 24,
    outlineOffset: '-2px',
    shadow: 'none',
    icons: 2,
  })
  await access(join(root, 'untitled folder'))
  await rename.fill('guides')
  await rename.press('Enter')
  await rename.waitFor({ state: 'hidden' })
  await access(join(root, 'guides'))
  const more = page.getByRole('button', { name: /actions for guides/i })
  await more.click()
  const menu = page.getByRole('menu', { name: /actions for guides/i })
  await menu.waitFor()
  await page.keyboard.press('Escape')
  await page.waitForFunction(
    () => !document.querySelector('.ui-menu').matches(':popover-open'),
  )
  await more.click()
  await menu.getByRole('menuitem', { name: /^new file$/i, exact: true }).click()
  await rename.waitFor()
  const textLeft = await rename.evaluate(
    (input) =>
      input.getBoundingClientRect().left +
      parseFloat(getComputedStyle(input).paddingLeft) +
      parseFloat(getComputedStyle(input).borderLeftWidth),
  )
  await assert.rejects(access(join(root, 'guides', 'untitled.md')))
  await rename.fill('hello.md')
  await rename.press('Enter')
  await rename.waitFor({ state: 'hidden' })
  const labelLeft = await page
    .getByRole('treeitem', { name: /^hello\.md$/i, exact: true })
    .locator('.sidebar-label')
    .evaluate((label) => label.getBoundingClientRect().left)
  assert.ok(
    Math.abs(textLeft - labelLeft) < 1,
    'rename text retains the filename indentation',
  )
  const rich = page.getByRole('textbox', { name: /document editor/i })
  await waitForDocumentEditor(app, page)
  await rich.fill('unsaved text')
  assert.equal(await page.locator('.sidebar-dirty').count(), 1)
  await assert.rejects(access(join(root, 'guides', 'hello.md')))
  await pressShortcut(app, `${mod}+s`)
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  assert.equal(
    await readFile(join(root, 'guides', 'hello.md'), 'utf8'),
    'unsaved text',
  )
  await page.waitForFunction(() => !document.querySelector('.sidebar-dirty'))
  await rich.fill('still editing')
  await page.getByRole('button', { name: /actions for hello\.md/i }).click()
  await page.getByRole('menuitem', { name: /^rename$/i, exact: true }).click()
  await rename.fill('renamed.md')
  await rename.press('Enter')
  await rename.waitFor({ state: 'hidden' })
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'still editing',
  )
  await page.evaluate(() =>
    window.hibi.workspaceAction({
      action: 'duplicate',
      path: 'guides/renamed.md',
    }),
  )
  assert.equal(
    await readFile(join(root, 'guides', 'renamed copy.md'), 'utf8'),
    'unsaved text',
  )
  await assert.rejects(
    page.evaluate(() =>
      window.hibi.workspaceAction({
        action: 'rename',
        path: 'guides/renamed.md',
        destination: 'renamed copy.md',
      }),
    ),
    /A file or folder exists at that location\./,
  )
  await assert.rejects(
    page.evaluate(() =>
      window.hibi.workspaceAction({ action: 'delete', path: '../outside.md' }),
    ),
    /Choose a file or folder name without slashes or reserved characters\./,
  )
  await symlink(profile, join(root, 'escape'))
  await assert.rejects(
    page.evaluate(() =>
      window.hibi.workspaceAction({ action: 'new-file', path: 'escape' }),
    ),
    /This path is missing or contains a symbolic link\./,
  )
  await page.evaluate(() =>
    window.hibi.workspaceAction({
      action: 'move',
      path: 'guides/renamed.md',
      destination: 'moved.md',
    }),
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'still editing',
  )
  await assert.rejects(access(join(root, 'guides', 'renamed.md')))
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  await page.evaluate(() =>
    window.hibi.workspaceAction({ action: 'new-file', path: '' }),
  )
  await writeFile(join(root, 'untitled.md'), 'external file')
  await assert.rejects(
    page.evaluate(() => window.hibi.saveDocument(false)),
    /EEXIST/,
  )
  assert.equal(
    await readFile(join(root, 'untitled.md'), 'utf8'),
    'external file',
  )
})
