import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'

test('clipboard writes route through the main process and resolve absolute paths', {
  timeout: 60000,
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'hibi-clipboard-'))
  const root = join(temp, 'workspace')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'a.md'), '# a')
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
  await waitForDocumentEditor(app, page)

  await page.evaluate(() => window.hibi.writeClipboardText('hello'))
  assert.equal(
    await app.evaluate(({ clipboard }) => clipboard.readText()),
    'hello',
  )

  await app.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] })
  }, root)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await pressShortcut(app, `${mod}+Shift+o`)
  const tree = page.getByRole('tree', { name: /workspace files/i })
  await page.locator('.app[aria-busy="false"]').waitFor()
  await tree.locator('[id="sidebar-a.md"]').click({ button: 'right' })
  const menu = page.getByRole('menu')
  await menu.waitFor()
  await menu
    .getByRole('menuitem', { name: 'Copy absolute path', exact: true })
    .click()
  assert.equal(
    await app.evaluate(({ clipboard }) => clipboard.readText()),
    join(await realpath(root), 'a.md'),
  )

  await assert.rejects(
    page.evaluate(() =>
      window.hibi.copyWorkspacePaths(['../escape'], { absolute: true }),
    ),
    /inside this workspace/,
  )
})

test('no source file reuses navigator.clipboard', async () => {
  const files = await readdir(resolve('src'), { recursive: true })
  const sources = files.filter((file) => /\.(ts|tsx)$/.test(file))
  assert.ok(sources.length > 0)
  for (const file of sources) {
    const text = await readFile(resolve('src', file), 'utf8')
    assert.ok(
      !text.includes('navigator.clipboard'),
      `${file} must not use navigator.clipboard`,
    )
  }
})
