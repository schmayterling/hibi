import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

for (const [label, tail, before] of [
  ['prose', 'last paragraph prose', 'last paragraph prose'],
  ['long line', 'x'.repeat(16385), null],
]) {
  test(`${label}: native doc-end and completion share a callback under cpu throttling`, {
    timeout: 90000,
  }, async (t) => {
    const folder = await mkdtemp(join(tmpdir(), 'hibi-formatted-view-'))
    const file = join(folder, 'long.md')
    const addon = join(
      folder,
      'profile',
      'installed-addons',
      'completion-probe',
    )
    await mkdir(addon, { recursive: true })
    const source = `${'Small prose paragraph with a few words.\n\n'.repeat(5000)}${tail}`
    await writeFile(file, source)
    // An addon records the context each completion request carries.
    await writeFile(
      join(addon, 'hibi-addon.json'),
      JSON.stringify({
        id: 'completion-probe',
        name: 'Completion probe',
        description: 'Records completion requests',
        kind: 'extension',
        apiVersion: 2,
        version: '1.0.0',
        startup: 'background',
        capabilities: ['source'],
        authors: [{ displayName: 'Test' }],
        entry: 'index.js',
      }),
    )
    await writeFile(
      join(addon, 'index.js'),
      'export default () => ({ async start(context) { window.completionProbe = { calls: [], ready: false }; await context.editor.registerCompletionProvider((request) => { window.completionProbe.calls.push({ prose: request.prose, head: request.selection.head }); return [] }); window.completionProbe.ready = true } })',
    )
    await writeFile(
      join(addon, '.hibi-install.json'),
      JSON.stringify({
        hash: 'a'.repeat(64),
        files: ['index.js', 'hibi-addon.json'],
        source: 'local',
      }),
    )
    await writeFile(
      join(folder, 'profile', 'addons.json'),
      JSON.stringify({ 'completion-probe': true }),
    )
    const app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
    })
    t.after(async () => {
      await app.close()
      await rm(folder, { recursive: true, force: true })
    })
    const page = await app.firstWindow()
    await waitForDocumentEditor(app, page)
    await page.evaluate(() =>
      localStorage.setItem('hibi:formatted-engine', 'codemirror'),
    )
    await page.reload()
    await waitForDocumentEditor(app, page)
    const session = await page.context().newCDPSession(page)
    await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      })
    }, file)
    await pressShortcut(app, `${mod}+o`)
    await page.waitForFunction(() => window.completionProbe?.ready)
    const formatted = page.locator('.rich-pane .cm-content')
    await formatted.waitFor()
    await formatted.focus()
    await session.send('Emulation.setCPUThrottlingRate', { rate: 8 })
    await page.evaluate(() => {
      window.completionProbe.calls = []
    })
    // Send both native shortcuts before the renderer can parse the new viewport.
    await app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents
      const jump =
        process.platform === 'darwin'
          ? { keyCode: 'DOWN', modifiers: ['meta'] }
          : { keyCode: 'END', modifiers: ['control'] }
      for (const input of [jump, { keyCode: 'SPACE', modifiers: ['control'] }])
        for (const type of ['keyDown', 'keyUp'])
          contents.sendInputEvent({ type, ...input })
    })
    await page.waitForFunction(() => window.completionProbe.calls.length > 0)
    const first = await page.evaluate(() => window.completionProbe.calls[0])
    assert.equal(first.head, source.length, JSON.stringify(first))
    if (before === null) assert.equal(first.prose, null)
    else {
      assert.equal(first.prose?.before, before, JSON.stringify(first))
      assert.equal(first.prose?.after, '', JSON.stringify(first))
    }
    const calls = await page.evaluate(() => window.completionProbe.calls.length)
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    )
    await page.keyboard.press('Control+Space')
    await page.waitForFunction(
      (count) => window.completionProbe.calls.length > count,
      calls,
    )
    const later = await page.evaluate(() => window.completionProbe.calls.at(-1))
    assert.deepEqual(later, first)
    assert.equal(
      (await page.evaluate(() => window.hibi.getDocument())).markdown,
      source,
    )
  })
}
