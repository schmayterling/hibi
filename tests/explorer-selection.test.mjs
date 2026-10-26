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
import { basename, join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('workspace files support multiple selection and group actions', {
  timeout: 60000,
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'hibi-explorer-selection-'))
  const root = join(temp, 'workspace')
  await mkdir(join(root, 'docs'), { recursive: true })
  await mkdir(join(root, 'target'))
  for (const name of ['a', 'b', 'c', 'z'])
    await writeFile(join(root, `${name}.md`), `# ${name}`)
  await writeFile(join(root, 'docs', 'd.md'), '# d')
  await writeFile(join(root, 'target', 'z.md'), '# existing z')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(temp, 'profile')}`],
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
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ dialog, shell }, root) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] })
    globalThis.trashed = []
    shell.trashItem = async (path) => {
      globalThis.trashed.push(path)
      const { rm } = process.getBuiltinModule('node:fs/promises')
      await rm(path, { recursive: true })
    }
  }, root)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await pressShortcut(app, `${mod}+Shift+o`)
  const tree = page.getByRole('tree', { name: /workspace files/i })
  const idle = page.locator('.app[aria-busy="false"]')
  await idle.waitFor()
  const row = (path) => tree.locator(`[id="sidebar-${path}"]`)
  const selected = () =>
    tree.evaluate((element) =>
      [...element.querySelectorAll('[aria-selected="true"]')]
        .map((row) => row.id.slice('sidebar-'.length))
        .join(' '),
    )
  const active = async () =>
    (await page.evaluate(() => window.hibi.getWorkspace())).activePath
  const menu = page.getByRole('menu')
  const openMenu = async (path, label) => {
    await row(path).click({ button: 'right' })
    await menu.waitFor()
    // The release that ends the right-click must not dismiss the menu.
    assert.ok(
      await menu.evaluate((element) => element.matches(':popover-open')),
    )
    assert.match(await menu.getAttribute('aria-label'), label)
    return menu
      .getByRole('menuitem')
      .evaluateAll((items) => items.map((item) => item.textContent.trim()))
  }
  const closeMenu = async () => {
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'hidden' })
  }
  const files = async (...paths) => {
    const present = []
    for (const path of paths)
      if (
        await access(join(root, path)).then(
          () => true,
          () => false,
        )
      )
        present.push(path)
    return present
  }

  // Only the workspace tree opts into multiple selection.
  assert.equal(await tree.getAttribute('aria-multiselectable'), 'true')
  assert.equal(await page.locator('[aria-multiselectable]').count(), 1)

  await row('a.md').click()
  await waitForAsync(
    page,
    async () => (await window.hibi.getWorkspace())?.activePath === 'a.md',
  )
  await idle.waitFor()
  assert.equal(await selected(), 'a.md')

  // Modifier clicks toggle without opening files or expanding folders.
  await row('c.md').click({ modifiers: [mod] })
  await row('docs').click({ modifiers: [mod] })
  assert.equal(await selected(), 'docs a.md c.md')
  assert.equal(await active(), 'a.md')
  assert.equal(await row('docs').getAttribute('aria-expanded'), 'false')
  assert.equal(await tree.locator('.sidebar-row[data-selected]').count(), 3)
  assert.equal(await tree.locator('.sidebar-selection').count(), 0)
  await row('docs').click({ modifiers: [mod] })
  assert.equal(await selected(), 'a.md c.md')

  // Shift ranges start at the last toggled row and cover visible rows only.
  await row('c.md').click({ modifiers: [mod] })
  await row('c.md').click({ modifiers: [mod] })
  assert.equal(await selected(), 'a.md c.md')
  await row('target').click({ modifiers: ['Shift'] })
  assert.equal(await selected(), 'target a.md b.md c.md')
  await row('docs').click({ modifiers: ['Shift'] })
  assert.equal(await selected(), 'docs target a.md b.md c.md')
  assert.equal(await active(), 'a.md')

  // A selected row keeps its group; an unselected row replaces it.
  const group = await openMenu('b.md', /actions for 5 items/i)
  assert.ok(
    !group.some((item) => /^(rename|new file|new folder|open)$/i.test(item)),
    group.join(', '),
  )
  assert.match(
    group.join(', '),
    /duplicate, copy to…, move to…, copy relative paths, copy absolute paths, move to trash/i,
  )
  await closeMenu()
  assert.match((await openMenu('z.md', /actions for z\.md/i)).join(), /rename/i)
  assert.equal(await selected(), 'z.md')
  await closeMenu()

  // Arrows move focus only; Space toggles, Shift extends, and Ctrl/Cmd+A selects visible rows.
  await row('z.md').focus()
  await page.keyboard.press('ArrowUp')
  assert.equal(await selected(), 'z.md')
  await page.keyboard.press('Space')
  assert.equal(await selected(), 'c.md z.md')
  await page.keyboard.press(`${mod}+Space`)
  assert.equal(await selected(), 'z.md')
  assert.equal(await active(), 'a.md')
  await page.keyboard.press('Shift+ArrowUp')
  assert.equal(await selected(), 'b.md c.md')
  await page.keyboard.press(`${mod}+a`)
  assert.equal(await selected(), 'docs target a.md b.md c.md z.md')
  await page.keyboard.press('Shift+F10')
  await menu.waitFor()
  assert.match(await menu.getAttribute('aria-label'), /actions for 6 items/i)
  await closeMenu()

  // A file group opens each file in a tab.
  await row('b.md').click({ modifiers: [mod] })
  await row('a.md').click({ modifiers: ['Shift'] })
  assert.equal(await selected(), 'a.md b.md')
  assert.ok((await openMenu('a.md', /actions for 2 items/i)).includes('Open'))
  await menu.getByRole('menuitem', { name: /^open$/i }).click()
  await waitForAsync(
    page,
    async () => (await window.hibi.getWorkspace())?.activePath === 'b.md',
  )
  await idle.waitFor()
  assert.ok(
    (await page.locator('[role="tab"][id^="document-tab-"]').count()) >= 2,
  )

  // Group copy keeps the originals; canceling the prompt changes nothing.
  await row('a.md').click({ modifiers: [mod] })
  assert.equal(await selected(), 'a.md b.md')
  await openMenu('a.md', /actions for 2 items/i)
  await menu.getByRole('menuitem', { name: /copy to/i }).click()
  const copy = page.getByRole('dialog', { name: /copy 2 items/i })
  await copy.getByRole('button', { name: /cancel/i }).click()
  await copy.waitFor({ state: 'hidden' })
  assert.deepEqual(await files('docs/a.md', 'docs/b.md'), [])
  await openMenu('a.md', /actions for 2 items/i)
  await menu.getByRole('menuitem', { name: /copy to/i }).click()
  await copy.getByRole('textbox').fill('docs/')
  await copy.getByRole('textbox').press('Enter')
  await idle.waitFor()
  await waitForAsync(page, async () =>
    (await window.hibi.getWorkspace()).entries
      .find((entry) => entry.path === 'docs')
      .children.some((entry) => entry.path === 'docs/b.md'),
  )
  assert.equal(await readFile(join(root, 'docs', 'b.md'), 'utf8'), '# b')
  assert.deepEqual(await files('a.md', 'b.md'), ['a.md', 'b.md'])

  // A collision stops the group, reports finished items, and overwrites nothing.
  await row('c.md').click({ modifiers: [mod] })
  await row('z.md').click({ modifiers: ['Shift'] })
  assert.equal(await selected(), 'c.md z.md')
  await openMenu('z.md', /actions for 2 items/i)
  await menu.getByRole('menuitem', { name: /move to…/i }).click()
  const move = page.getByRole('dialog', { name: /move 2 items/i })
  await move.getByRole('textbox').fill('target')
  await move.getByRole('textbox').press('Enter')
  await page
    .locator('.toast-copy', { hasText: /moved 1 of 2 items/i })
    .filter({ hasText: /A file or folder exists/ })
    .waitFor()
  await idle.waitFor()
  assert.deepEqual(await files('c.md', 'target/c.md'), ['target/c.md'])
  assert.equal(await readFile(join(root, 'z.md'), 'utf8'), '# z')
  assert.equal(
    await readFile(join(root, 'target', 'z.md'), 'utf8'),
    '# existing z',
  )

  // Dragging a selected row moves the whole group.
  await row('a.md').click({ modifiers: [mod] })
  await row('b.md').click({ modifiers: ['Shift'] })
  assert.equal(await selected(), 'a.md b.md')
  const transfer = await page.evaluateHandle(() => new DataTransfer())
  await row('b.md').dispatchEvent('dragstart', { dataTransfer: transfer })
  await row('target').dispatchEvent('dragover', { dataTransfer: transfer })
  await row('target').dispatchEvent('drop', { dataTransfer: transfer })
  await waitForAsync(
    page,
    async () =>
      (await window.hibi.getWorkspace()).entries.filter(
        (entry) => entry.kind === 'file',
      ).length === 1,
  )
  await idle.waitFor()
  assert.deepEqual(await files('a.md', 'b.md', 'target/a.md', 'target/b.md'), [
    'target/a.md',
    'target/b.md',
  ])

  // Trash skips descendants of a selected folder and asks once.
  await row('docs').click()
  await row('docs/d.md').click({ modifiers: [mod] })
  await row('z.md').click({ modifiers: [mod] })
  assert.equal(await selected(), 'docs docs/d.md z.md')
  await openMenu('docs/d.md', /actions for 3 items/i)
  await menu.getByRole('menuitem', { name: /move to trash/i }).click()
  const trash = page.getByRole('dialog', { name: /move 2 items to trash/i })
  await trash.getByRole('button', { name: /move to trash/i }).click()
  await row('docs').waitFor({ state: 'detached' })
  await idle.waitFor()
  assert.deepEqual(
    (await app.evaluate(() => globalThis.trashed)).map((path) =>
      basename(path),
    ),
    ['docs', 'z.md'],
  )

  // A stale workspace target never reaches the filesystem.
  const stale = { workspaceId: 'stale', workspaceGeneration: -1 }
  await assert.rejects(
    page.evaluate(
      (target) =>
        window.hibi.workspaceAction({
          action: 'delete',
          path: 'target/c.md',
          target,
        }),
      stale,
    ),
    /workspace changed/,
  )
  await assert.rejects(
    page.evaluate(
      (target) => window.hibi.openWorkspaceFile('target/c.md', target),
      stale,
    ),
    /workspace changed/,
  )
  assert.deepEqual(await files('target/c.md'), ['target/c.md'])
})
