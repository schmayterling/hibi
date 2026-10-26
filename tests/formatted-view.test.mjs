import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

test('behind the switch, notes open in the codemirror formatted view and edit their markdown', {
  timeout: 90000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-formatted-view-'))
  const file = join(folder, 'notes', 'note.md')
  await mkdir(join(folder, 'notes'))
  await writeFile(file, '# Title\n\n- one\n\nA **bold** word.\n')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  // Quitting with the edited note answers the unsaved-changes prompt.
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  const page = await app.firstWindow()
  await waitForDocumentEditor(app, page)
  // The switch is a local-storage flag for tests and development profiles.
  assert.equal(await page.locator('.rich-pane .hibi-formatted').count(), 0)
  await page.evaluate(() =>
    localStorage.setItem('hibi:formatted-engine', 'codemirror'),
  )
  await page.reload()
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await pressShortcut(app, `${mod}+o`)
  await page.locator('.rich-pane .hibi-lp-h1', { hasText: 'Title' }).waitFor()
  assert.equal(await page.locator('.rich-pane .tiptap').count(), 0)
  // Hidden windows have no focus; markers under the caret need a focused editor.
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const saved = (check, text) =>
    waitForAsync(
      page,
      async ({ check, text }) => {
        const { markdown } = await window.hibi.getDocument()
        return check === 'includes'
          ? markdown.includes(text)
          : markdown.endsWith(text)
      },
      { check, text },
    )

  // Enter at the end of an item continues the list.
  await page.locator('.rich-pane .cm-line', { hasText: 'one' }).click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('two')
  await saved('includes', '- one\n- two')
  assert.ok(
    await page
      .locator('.rich-pane .hibi-lp-list-item', { hasText: 'two' })
      .count(),
  )

  // The caret inside bold text reveals its markers; elsewhere they are hidden.
  await page.locator('.rich-pane .hibi-lp-strong').click()
  await page.locator('.rich-pane .hibi-lp-marker').first().waitFor()
  assert.equal(
    await page.locator('.rich-pane .hibi-lp-marker').count(),
    2,
    'both ** markers',
  )
  await page.locator('.rich-pane .hibi-lp-h1').click()
  await waitForAsync(
    page,
    () => document.querySelectorAll('.rich-pane .hibi-lp-marker').length === 1,
  )

  // Typing inside formatting edits the source text; undo restores it.
  await page.locator('.rich-pane .hibi-lp-strong').click()
  await page.keyboard.press('End')
  await page.keyboard.type(' more')
  await saved('includes', 'A **bold** word. more')
  await pressShortcut(app, `${mod}+z`)
  await saved('endsWith', 'A **bold** word.\n')
})
