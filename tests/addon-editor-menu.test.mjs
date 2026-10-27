import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  electron,
  startupDiagnostics,
  waitForDocumentEditor,
} from './electron.mjs'
import {
  selectFormattedEngine,
  testFormattedEngines as test,
} from './formatted-engine.mjs'
import { clickMenu, replaceRichText } from './keyboard.mjs'
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
        }, ...(window.editorMenuExtraActions ? Array.from({ length: 19 }, (_, index) => ({
          label: 'Extra action ' + (index + 1),
          detail: 'Replaces the selection with bye.',
          edit: { from, to, insertText: 'bye' },
        })) : [])];
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
  await selectFormattedEngine(app, page, t.formattedEngine)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await clickMenu(app, 'Open…')
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).name === 'note.md',
  )
  await waitForDocumentEditor(app, page)
  const rich = page.locator(
    t.formattedEngine === 'tiptap'
      ? '.rich-pane .tiptap[contenteditable="true"]'
      : '.rich-pane .hibi-formatted .cm-content[contenteditable="true"]',
  )
  await rich.click()
  if (t.formattedEngine === 'tiptap')
    await rich.evaluate((element) =>
      element.editor.commands.setTextSelection({ from: 1, to: 6 }),
    )
  else await rich.press('ControlOrMeta+a')
  const menu = page.getByRole('menu', { name: 'Editor actions' })
  // Hosted runners sometimes lose the menu before its first click; record why.
  await page.evaluate(() => {
    const log = []
    window.editorMenuLog = log
    const started = performance.now()
    const record = (event) => {
      if (log.length === 30) log.shift()
      log.push([Math.round(performance.now() - started), event])
    }
    for (const event of ['blur', 'focus'])
      window.addEventListener(event, () => record(`window ${event}`))
    document
      .querySelector('.rich-pane [aria-label="Document editor"]')
      .addEventListener('blur', () => record('editor blur'))
    document.addEventListener(
      'scroll',
      (event) =>
        record(
          `scroll ${event.target === document ? 'document' : event.target.className}`,
        ),
      true,
    )
    for (const panel of document.querySelectorAll(
      '[role="menu"][aria-label="Editor actions"]',
    )) {
      new MutationObserver(() =>
        record(`menu items ${panel.children.length}`),
      ).observe(panel, { childList: true })
      panel.addEventListener('toggle', (event) =>
        record(`menu ${event.newState}`),
      )
    }
  })
  await rich.press('Shift+F10')
  await menu
    .getByRole('menuitem', { name: 'Inspect editor selection' })
    .waitFor()
    .catch(async (error) => {
      try {
        console.error(
          'editor menu startup:',
          JSON.stringify(await startupDiagnostics(app, page)),
        )
      } catch {}
      throw error
    })
  // Focus returning to the editor, as when its window regains focus, keeps the menu.
  await rich.evaluate((element, engine) => {
    element.dispatchEvent(new FocusEvent('focus'))
    // ProseMirror's unchanged-selection transaction is a Tiptap-only oracle.
    if (engine === 'tiptap') {
      const { view } = element.editor
      view.dispatch(view.state.tr.setSelection(view.state.selection))
    }
  }, t.formattedEngine)
  await menu
    .getByRole('menuitem', { name: 'Inspect editor selection' })
    .click()
    .catch(async (error) => {
      try {
        console.error(
          'editor menu click:',
          JSON.stringify(
            await page.evaluate(() => ({
              log: window.editorMenuLog,
              open: [
                ...document.querySelectorAll(
                  '[role="menu"][aria-label="Editor actions"]',
                ),
              ].map((panel) => panel.matches(':popover-open')),
              active: document.activeElement?.className,
              focused: document.hasFocus(),
            })),
          ),
        )
      } catch {}
      throw error
    })
  await page.waitForFunction(() => window.editorMenuProbeStarts === 1)
  await replaceRichText(page, rich, 'changed')
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).markdown === 'changed',
  )
  if (t.formattedEngine === 'tiptap')
    await rich.evaluate((element) =>
      element.editor.commands.setTextSelection({ from: 1, to: 8 }),
    )
  else await rich.press('ControlOrMeta+a')
  await rich.press('Shift+F10')
  await menu
    .getByRole('menuitem', { name: 'Inspect editor selection' })
    .waitFor()
  // An addon that finishes starting while the menu is open leaves it open.
  await page.evaluate(() => window.releaseEditorMenuProbe())
  await page.getByText('The command target is no longer available.').waitFor()
  assert.equal(
    await page.evaluate(() => window.editorMenuProbeRuns?.length ?? 0),
    0,
  )
  assert.equal(await menu.isVisible(), true)

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

  // Reaching an item below a long menu's fold scrolls the menu, not its anchor.
  await page.evaluate(() => {
    window.editorMenuExtraActions = true
  })
  await rich.press('Shift+F10')
  const lastAction = menu.getByRole('menuitem', { name: 'Extra action 19' })
  await lastAction.waitFor({ state: 'attached' })
  assert.ok(
    await menu.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
  )
  // The menu's own listener runs after the document's capture-phase handler.
  await menu.evaluate((element) => {
    window.editorMenuScrolled = new Promise((resolve) =>
      element.addEventListener('scroll', resolve, { once: true }),
    )
  })
  await rich.press('ArrowUp')
  await page.evaluate(() => window.editorMenuScrolled)
  assert.equal(await menu.isVisible(), true)
  assert.equal(await lastAction.getAttribute('aria-current'), 'true')
  // Scrolling the document still moves the menu's anchor and closes it.
  await page.evaluate(() => document.dispatchEvent(new Event('scroll')))
  await menu.waitFor({ state: 'hidden' })
  await page.evaluate(() => {
    window.editorMenuExtraActions = false
  })

  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  const source = page.getByRole('textbox', {
    name: 'Markdown editor',
    exact: true,
  })
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  await source.focus()
  await source.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
  await source.press('Shift+F10')
  await menu
    .getByRole('menuitem', { name: 'Inspect editor selection' })
    .waitFor()
  await menu.getByRole('menuitem', { name: 'Replace selection' }).waitFor()
  await page.keyboard.press('Enter')
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
