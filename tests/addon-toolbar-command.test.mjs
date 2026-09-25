import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

async function install(profile, id, source) {
  const directory = join(profile, 'installed-addons', id)
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'hibi-addon.json'),
    JSON.stringify({
      id,
      name: id,
      description: 'Toolbar command fixture.',
      kind: 'extension',
      apiVersion: 2,
      version: '1.0.0',
      defaultEnabled: true,
      startup: 'background',
      capabilities: [],
      authors: [{ displayName: 'Test' }],
      entry: 'index.js',
    }),
  )
  await writeFile(join(directory, 'index.js'), source)
  await writeFile(
    join(directory, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['hibi-addon.json', 'index.js'],
      source: 'local',
    }),
  )
}

async function clickToolbar(page, id) {
  const inline = page.locator(
    `.editor-toolbar > button[data-toolbar-id="${id}"]`,
  )
  if (await inline.count()) {
    await inline.click()
    return
  }
  await page.getByRole('button', { name: 'More formatting actions' }).click()
  await page.locator(`.toolbar-menu button[data-toolbar-id="${id}"]`).click()
}

test('installed toolbar command captures rich and source selection and stays owner scoped', {
  timeout: 60000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-toolbar-command-'))
  const file = join(profile, 'note.md')
  await writeFile(file, 'hello\n\n`world`')
  await install(
    profile,
    'toolbar-probe',
    `export default () => ({ start(context) {
      window.toolbarProbe = { runs: [], legacy: 0 };
      context.commands.register({
        id: 'inspect', label: 'Inspect selection',
        run(invocation) { window.toolbarProbe.runs.push(invocation); },
      });
      context.toolbar.register({
        id: 'inspect', label: 'Inspect toolbar selection', commandId: 'inspect',
      });
      context.toolbar.register({
        id: 'legacy', label: 'Legacy toolbar action',
        onClick() { window.toolbarProbe.legacy++; },
      });
      context.toolbar.register({
        id: 'foreign', label: 'Foreign toolbar action', commandId: 'foreign',
      });
    } });`,
  )
  await install(
    profile,
    'other-addon',
    `export default () => ({ start(context) {
      window.otherAddonReady = true;
      context.commands.register({
        id: 'foreign', label: 'Foreign command',
        run() { window.foreignCommandRuns = (window.foreignCommandRuns || 0) + 1; },
      });
    } });`,
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'toolbar-probe': true, 'other-addon': true }),
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
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.locator('.titlebar').waitFor()
  await page.evaluate(() =>
    localStorage.setItem(
      'hibi:toolbar',
      JSON.stringify({ visible: true, autoHide: false, mode: 'icons' }),
    ),
  )
  await page.reload()
  await page.waitForFunction(
    () => window.toolbarProbe && window.otherAddonReady,
  )
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await clickMenu(app, 'Open…')
  const rich = page.locator('.rich-pane .tiptap[contenteditable="true"]')
  await rich.waitFor()
  await rich.click()
  await rich.evaluate((element) =>
    element.editor.commands.setTextSelection({
      from: 1,
      to: element.editor.state.doc.content.size - 1,
    }),
  )
  await clickToolbar(page, 'toolbar-probe.inspect')
  await page.waitForFunction(() => window.toolbarProbe.runs.length === 1)
  const richInvocation = await page.evaluate(() => window.toolbarProbe.runs[0])
  assert.equal(richInvocation.source, 'toolbar')
  assert.equal(richInvocation.selection.editor, 'rich')
  assert.equal(richInvocation.selection.selectedText, 'hello\nworld')
  assert.equal(
    richInvocation.document.documentId,
    richInvocation.view.documentId,
  )

  await rich.click()
  await rich.evaluate((element) =>
    element.editor.commands.setTextSelection({ from: 8, to: 13 }),
  )
  await clickToolbar(page, 'toolbar-probe.inspect')
  await page.waitForFunction(() => window.toolbarProbe.runs.length === 2)
  const codeInvocation = await page.evaluate(() => window.toolbarProbe.runs[1])
  assert.equal(codeInvocation.selection.selectedText, 'world')

  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  const source = page.getByRole('textbox', {
    name: 'Markdown editor',
    exact: true,
  })
  await source.waitFor()
  await source.focus()
  await source.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
  await clickToolbar(page, 'toolbar-probe.inspect')
  await page.waitForFunction(() => window.toolbarProbe.runs.length === 3)
  const sourceInvocation = await page.evaluate(
    () => window.toolbarProbe.runs[2],
  )
  assert.equal(sourceInvocation.source, 'toolbar')
  assert.equal(sourceInvocation.selection.editor, 'source')
  assert.equal(sourceInvocation.selection.selectedText, 'hello\n\n`world`')
  assert.equal(
    sourceInvocation.document.documentId,
    sourceInvocation.view.documentId,
  )

  await clickToolbar(page, 'toolbar-probe.legacy')
  await page.waitForFunction(() => window.toolbarProbe.legacy === 1)
  await clickToolbar(page, 'toolbar-probe.foreign')
  await page.getByText('This command is no longer available.').waitFor()
  assert.equal(await page.evaluate(() => window.foreignCommandRuns ?? 0), 0)

  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  await page.locator('#addon-toolbar-probe').click()
  await page.waitForFunction(
    () => !document.querySelector('[data-toolbar-id="toolbar-probe.inspect"]'),
  )
})
