import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('editor command shares rich and source action menus with guarded selection', {
  timeout: 60000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-editor-menu-'))
  const directory = join(profile, 'installed-addons', 'editor-menu-probe')
  const file = join(profile, 'note.md')
  await mkdir(directory, { recursive: true })
  await writeFile(file, 'hello')
  await writeFile(
    join(directory, 'hibi-addon.json'),
    JSON.stringify({
      id: 'editor-menu-probe',
      name: 'Editor menu probe',
      description: 'Editor command fixture.',
      kind: 'extension',
      apiVersion: 2,
      version: '1.0.0',
      authors: [{ displayName: 'Test' }],
      entry: 'index.js',
      capabilities: [],
      activation: 'command',
      commands: [
        {
          id: 'inspect',
          label: 'Inspect editor selection',
          menu: { location: 'editor', group: 'test', order: 1 },
        },
      ],
    }),
  )
  await writeFile(
    join(directory, 'index.js'),
    `export default () => ({ async start(context) {
      window.editorMenuProbeStarts = (window.editorMenuProbeStarts || 0) + 1;
      await new Promise((resolve) => { window.releaseEditorMenuProbe = resolve; });
      context.commands.register({
        id: 'inspect', label: 'Inspect editor selection',
        run(invocation) {
          window.editorMenuProbeRuns = [...(window.editorMenuProbeRuns || []), invocation];
        },
      });
      await context.editor.registerContextActionProvider((request) => {
        const from = Math.min(request.selection.anchor, request.selection.head);
        const to = Math.max(request.selection.anchor, request.selection.head);
        return from === to ? [] : [{
          label: 'Replace selection',
          edit: { from, to, insertText: 'bye' },
        }];
      });
    } });`,
  )
  await writeFile(
    join(directory, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['hibi-addon.json', 'index.js'],
      source: 'local',
    }),
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'editor-menu-probe': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await clickMenu(app, 'Open…')
  const rich = page.locator('.rich-pane .tiptap[contenteditable="true"]')
  await rich.waitFor()
  await rich.click()
  await rich.evaluate((element) =>
    element.editor.commands.setTextSelection({ from: 1, to: 6 }),
  )
  const menu = page.getByRole('menu', { name: 'Editor actions' })
  await rich.press('Shift+F10')
  await menu.getByRole('menuitem', { name: 'Inspect editor selection' }).click()
  await page.waitForFunction(() => window.editorMenuProbeStarts === 1)
  await rich.fill('changed')
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).markdown === 'changed',
  )
  await page.evaluate(() => window.releaseEditorMenuProbe())
  await page.getByText('The command target is no longer available.').waitFor()
  assert.equal(
    await page.evaluate(() => window.editorMenuProbeRuns?.length ?? 0),
    0,
  )

  await rich.evaluate((element) =>
    element.editor.commands.setTextSelection({ from: 1, to: 8 }),
  )
  await rich.press('Shift+F10')
  await menu
    .getByRole('menuitem', { name: 'Inspect editor selection' })
    .waitFor()
  await menu.getByRole('menuitem', { name: 'Replace selection' }).waitFor()
  await menu.getByRole('menuitem', { name: 'Inspect editor selection' }).click()
  await page.waitForFunction(() => window.editorMenuProbeRuns?.length === 1)
  const richInvocation = await page.evaluate(
    () => window.editorMenuProbeRuns[0],
  )
  assert.equal(richInvocation.source, 'menu')
  assert.equal(richInvocation.selection.editor, 'rich')
  assert.equal(richInvocation.selection.selectedText, 'changed')
  assert.equal(
    richInvocation.document.documentId,
    richInvocation.view.documentId,
  )

  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  const source = page.getByRole('textbox', {
    name: 'Markdown editor',
    exact: true,
  })
  await source.waitFor()
  await source.focus()
  await source.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
  await source.press('Shift+F10')
  await menu
    .getByRole('menuitem', { name: 'Inspect editor selection' })
    .waitFor()
  await menu.getByRole('menuitem', { name: 'Replace selection' }).waitFor()
  await source.press('Enter')
  await page.waitForFunction(() => window.editorMenuProbeRuns?.length === 2)
  const sourceInvocation = await page.evaluate(
    () => window.editorMenuProbeRuns[1],
  )
  assert.equal(sourceInvocation.selection.editor, 'source')
  assert.equal(sourceInvocation.selection.selectedText, 'changed')
  assert.equal(
    sourceInvocation.document.documentId,
    sourceInvocation.view.documentId,
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'changed',
  )
})
