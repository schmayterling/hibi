import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

/** A note of `size` MiB: a heading, then paragraphs of ordinary words. */
const makeSource = (size) => {
  const unit = `${'ordinary words '.repeat(16)}\n\n`,
    length = size * 1024 * 1024
  return `# Large note\n\n${unit.repeat(Math.ceil(length / unit.length))}`.slice(
    0,
    length,
  )
}

/** Open `file` in a fresh app, with the CodeMirror formatted view switch on or off. */
async function launch(t, file, codemirror) {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-formatted-large-'))
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
  page.setDefaultTimeout(60000)
  await waitForDocumentEditor(app, page)
  if (codemirror) {
    await page.evaluate(() =>
      localStorage.setItem('hibi:formatted-engine', 'codemirror'),
    )
    await page.reload()
    await waitForDocumentEditor(app, page)
  }
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  const started = performance.now()
  await pressShortcut(app, `${mod}+o`)
  return { app, page, started }
}

for (const size of [2, 50])
  test(`behind the switch, a ${size} MiB note opens in the formatted view and takes typing`, {
    timeout: 240000,
  }, async (t) => {
    const folder = await mkdtemp(join(tmpdir(), 'hibi-formatted-large-note-'))
    t.after(() => rm(folder, { recursive: true, force: true }))
    const file = join(folder, `${size}.md`)
    await mkdir(folder, { recursive: true })
    await writeFile(file, makeSource(size))
    const { page, started } = await launch(t, file, true)
    // Before, notes over 256 KiB opened in source view.
    await page
      .locator('.rich-pane .hibi-formatted .hibi-lp-h1', {
        hasText: 'Large note',
      })
      .waitFor()
    const mount = Math.round(performance.now() - started)
    assert.equal(
      await page.getByText('Opened in source view').count(),
      0,
      'no source-first notice',
    )
    assert.equal(await page.locator('.editor-panes.mode-normal').count(), 1)
    // Typing at the end of the heading edits the note.
    const session = await page.context().newCDPSession(page)
    await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await page
      .locator('.rich-pane .hibi-lp-h1', { hasText: 'Large note' })
      .click()
    await page.keyboard.press('End')
    const keys = []
    for (let index = 0; index < 20; index++) {
      const length = await page.evaluate(
        () =>
          document.querySelector('.rich-pane .cm-content').cmTile.root.view
            .state.doc.length,
      )
      const before = performance.now()
      await page.keyboard.press('x')
      await page.waitForFunction(
        (length) =>
          document.querySelector('.rich-pane .cm-content').cmTile.root.view
            .state.doc.length > length,
        length,
        { polling: 'raf' },
      )
      keys.push(performance.now() - before)
    }
    await waitForAsync(page, async () =>
      (await window.hibi.getDocument()).markdown.startsWith(
        `# Large note${'x'.repeat(20)}\n`,
      ),
    )
    keys.sort((a, b) => a - b)
    console.log(
      JSON.stringify({
        size,
        mountMs: mount,
        keyMedianMs: Math.round(keys[10] * 10) / 10,
        keyMaxMs: Math.round(keys.at(-1) * 10) / 10,
      }),
    )
  })

test('without the switch, a large note still opens in source view', {
  timeout: 120000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-formatted-large-note-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const file = join(folder, '2.md')
  await writeFile(file, makeSource(2))
  const { page } = await launch(t, file, false)
  await page.getByText('Opened in source view').waitFor()
  assert.equal(await page.locator('.rich-pane .hibi-formatted').count(), 0)
})
