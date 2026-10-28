import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { electron } from './electron.mjs'
import {
  selectFormattedEngine,
  testFormattedEngines as test,
} from './formatted-engine.mjs'
import { clickMenu } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

for (const apiVersion of [2, 3]) {
  test(`api ${apiVersion} installed addon hover and context actions work in rich and source views`, {
    timeout: 45000,
  }, async (t) => {
    const profile = await mkdtemp(join(tmpdir(), 'hibi-editor-interactions-'))
    const folder = join(profile, 'installed-addons', 'interaction-probe')
    const file = join(profile, 'note.md')
    await mkdir(folder, { recursive: true })
    const originalText = 'hello '.repeat(100).trimEnd()
    await writeFile(file, originalText)
    await writeFile(
      join(folder, 'hibi-addon.json'),
      JSON.stringify({
        id: 'interaction-probe',
        name: 'Interaction probe',
        description: 'Editor provider fixture.',
        kind: 'extension',
        apiVersion,
        version: '1.0.0',
        startup: 'background',
        capabilities: [],
        authors: [{ displayName: 'Test' }],
        entry: 'index.js',
      }),
    )
    await writeFile(
      join(folder, 'index.js'),
      `export default () => ({ async start(context) {
      const stops = []
      window.interactionProbe = {
        ready: true,
        requests: [],
        activate: async () => {
          stops.push(await context.editor.registerHoverProvider((request) => ({
            label: 'Hovered note', detail: request.editor,
          })))
          stops.push(await context.editor.registerContextActionProvider((request) => {
            window.interactionProbe.requests.push(request)
            const from = Math.min(request.selection.anchor, request.selection.head)
            const to = Math.max(request.selection.anchor, request.selection.head)
            return from === to ? [] : [{
              label: 'Replace selection',
              edit: { from, to, insertText: 'bye' },
            }]
          }))
        },
        stop: () => stops.forEach(stop => stop()),
      }
    } })`,
    )
    await writeFile(
      join(folder, '.hibi-install.json'),
      JSON.stringify({
        hash: 'a'.repeat(64),
        files: ['hibi-addon.json', 'index.js'],
        source: 'local',
      }),
    )
    await writeFile(
      join(profile, 'addons.json'),
      JSON.stringify({ 'interaction-probe': true }),
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
    await page.waitForFunction(() => window.interactionProbe?.ready)
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      })
    }, file)
    await clickMenu(app, 'Open…')

    const rich = page.locator(
      t.formattedEngine === 'tiptap'
        ? '.rich-pane .tiptap[contenteditable="true"]'
        : '.rich-pane .hibi-formatted .cm-content[contenteditable="true"]',
    )
    await rich.waitFor()
    await rich.click()
    await page.evaluate(() => window.interactionProbe.activate())
    await rich
      .locator(t.formattedEngine === 'tiptap' ? 'p' : '.cm-line')
      .hover()
    await page.getByRole('tooltip', { name: 'Editor hover' }).waitFor()
    if (t.formattedEngine === 'tiptap')
      await rich.evaluate((element) =>
        element.editor.commands.setTextSelection({
          from: 1,
          to: element.editor.state.doc.content.size - 1,
        }),
      )
    else await rich.press('ControlOrMeta+a')
    await rich.press('Shift+F10')
    const menu = page.getByRole('menu', { name: 'Editor actions' })
    await menu.getByRole('menuitem', { name: 'Replace selection' }).waitFor()
    const richRequest = await page.evaluate(() =>
      window.interactionProbe.requests.at(-1),
    )
    assert.equal(richRequest.selectedText, originalText.slice(0, 256))
    assert.equal(
      richRequest.selection.head - richRequest.selection.anchor,
      originalText.length,
    )
    assert.equal(richRequest.position, richRequest.selection.head)
    await rich.press('Enter')
    await waitForAsync(
      page,
      async () => (await window.hibi.getDocument()).markdown === 'bye',
    )
    await rich.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
    await waitForAsync(
      page,
      async (original) =>
        (await window.hibi.getDocument()).markdown === original,
      originalText,
    )

    await page.getByRole('button', { name: 'Source view', exact: true }).click()
    const source = page.getByRole('textbox', {
      name: 'Markdown editor',
      exact: true,
    })
    await source.waitFor()
    await source.focus()
    await source.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
    await source.hover()
    await page.getByRole('tooltip', { name: 'Editor hover' }).waitFor()
    await source.press('Shift+F10')
    await menu.getByRole('menuitem', { name: 'Replace selection' }).waitFor()
    assert.equal(
      await page.evaluate(
        () => window.interactionProbe.requests.at(-1).selectedText,
      ),
      originalText.slice(0, 256),
    )
    await source.press('Enter')
    await waitForAsync(
      page,
      async () => (await window.hibi.getDocument()).markdown === 'bye',
    )
    await source.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
    await waitForAsync(
      page,
      async (original) =>
        (await window.hibi.getDocument()).markdown === original,
      originalText,
    )
    await source.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
    await source.press('Shift+F10')
    await menu.getByRole('menuitem', { name: 'Replace selection' }).waitFor()
    await page.evaluate(() => window.interactionProbe.stop())
    await menu.waitFor({ state: 'hidden' })
    assert.equal(
      (await page.evaluate(() => window.hibi.getDocument())).markdown,
      originalText,
    )
  })
}
