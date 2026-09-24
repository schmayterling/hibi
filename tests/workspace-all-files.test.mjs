import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForAppState } from './electron.mjs'

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
  await source.fill('{"enabled":false}')
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
