import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { pressShortcut, replaceSourceText } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('unsaved link edits update the graph while switching notes keeps it', {
  timeout: 60000,
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'hibi-graph-refresh-'))
  const root = join(temp, 'notes'),
    profile = join(temp, 'profile')
  await mkdir(root)
  await mkdir(profile)
  const alpha = '# alpha\n\n[next](b.md)'
  await writeFile(join(root, 'a.md'), alpha)
  await writeFile(join(root, 'b.md'), '# beta\n\n[back](a.md)')
  await writeFile(join(root, 'c.md'), '# gamma')
  await writeFile(join(profile, 'addons.json'), JSON.stringify({ graph: true }))
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
  page.setDefaultTimeout(10000)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await app.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] })
  }, root)
  await pressShortcut(app, `${mod}+Shift+o`)
  const tree = page.getByRole('tree', { name: /workspace files/i })
  await tree.getByRole('treeitem', { name: /^a\.md$/i, exact: true }).click()
  await pressShortcut(app, `${mod}+k`)
  await page
    .getByRole('combobox', { name: /search commands/i })
    .fill('Open workspace graph')
  await page.getByRole('option').first().click()
  const graph = page.getByRole('complementary', {
    name: /^workspace graph$/i,
    exact: true,
  })
  await graph
    .getByText('3 of 3 notes · 1 connection', { exact: true })
    .waitFor()
  const connections = graph.getByRole('region', { name: 'Connections' })
  await connections.getByRole('button', { name: 'b.md', exact: true }).waitFor()
  // Switching notes moves the connections without changing the graph.
  await connections.getByRole('button', { name: 'b.md', exact: true }).click()
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).name === 'b.md',
  )
  await connections.getByRole('button', { name: 'a.md', exact: true }).click()
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).name === 'a.md',
  )
  await connections.getByRole('button', { name: 'b.md', exact: true }).waitFor()
  await graph
    .getByText('3 of 3 notes · 1 connection', { exact: true })
    .waitFor()
  // A link typed but not saved appears at once.
  await pressShortcut(app, `${mod}+Shift+]`)
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  await replaceSourceText(page, source, `${alpha} [gamma](c.md)`)
  await graph
    .getByText('3 of 3 notes · 2 connections', { exact: true })
    .waitFor()
  await connections.getByRole('button', { name: 'c.md', exact: true }).waitFor()
  await waitForAsync(page, async () => (await window.hibi.getDocument()).dirty)
  assert.equal(await readFile(join(root, 'a.md'), 'utf8'), alpha)
  // Removing it again is just as live.
  await replaceSourceText(page, source, alpha)
  await graph
    .getByText('3 of 3 notes · 1 connection', { exact: true })
    .waitFor()
  assert.deepEqual(errors, [])
})
