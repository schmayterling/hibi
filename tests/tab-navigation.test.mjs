import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  launchBenchmarkApp,
  waitForEditor,
} from '../scripts/benchmark-flows.mjs'
import { openInDocumentEditor, waitForDocumentEditor } from './electron.mjs'
import { clickMenu, pressShortcut, replaceSourceText } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('tab shortcuts wrap and preserve source drafts without saving', {
  timeout: 30000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-tab-navigation-'))
  const app = await launchBenchmarkApp(join(root, 'profile'))
  t.after(async () => {
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(6500)
  await waitForEditor(page)
  const ids = []
  for (const name of ['a', 'b', 'c']) {
    const file = join(root, `${name}.md`)
    await writeFile(file, `# ${name}`)
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      })
    }, file)
    await clickMenu(app, 'Open…')
    await page
      .getByRole('tab', { name: `${name}.md`, selected: true })
      .waitFor()
    ids.push((await page.evaluate(() => window.hibi.getDocument())).tabId)
  }
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  // `editor` is the one the window's current view shows the note in.
  const cycle = async (key, id, editor = 'Document editor') => {
    await openInDocumentEditor(
      app,
      page,
      async () => {
        await pressShortcut(app, `${mod}+Alt+${key}`)
        await waitForAsync(
          page,
          async (id) => (await window.hibi.getDocument()).tabId === id,
          id,
        )
      },
      { name: editor },
    )
    await page.locator(`#document-tab-${id}[aria-selected="true"]`).waitFor()
  }
  await cycle('Right', ids[0])
  await cycle('Left', ids[2])
  await cycle('Left', ids[1])
  await cycle('Left', ids[0])
  await pressShortcut(app, `${mod}+Shift+]`)
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  await replaceSourceText(page, source, 'draft a')
  await cycle('Right', ids[1], 'Markdown editor')
  await cycle('Left', ids[0], 'Markdown editor')
  await waitForAsync(page, async () => {
    const state = await window.hibi.getDocument()
    return state.markdown === 'draft a' && state.dirty
  })
  assert.equal(await source.innerText(), 'draft a')
  assert.equal(await readFile(join(root, 'a.md'), 'utf8'), '# a')
})
