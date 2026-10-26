import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

/** A note of `size` KiB: a heading, then paragraphs of ordinary words. */
const makeSource = (size) => {
  const unit = `${'ordinary words '.repeat(16)}\n\n`,
    length = size * 1024
  return `# Large note\n\n${unit.repeat(Math.ceil(length / unit.length))}`.slice(
    0,
    length,
  )
}

/** Open a note of `size` KiB with the CodeMirror formatted view switched on. */
async function open(t, size) {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-hidden-source-'))
  const file = join(folder, 'note.md')
  await writeFile(file, makeSource(size))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(60000)
  await waitForDocumentEditor(app, page)
  await page.evaluate(() =>
    localStorage.setItem('hibi:formatted-engine', 'codemirror'),
  )
  await page.reload()
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await pressShortcut(app, `${mod}+o`)
  const view = (name) =>
    page
      .locator('.view-switch')
      .getByRole('button', { name, exact: true })
      .click()
  // Visit the source view, then return to the formatted view.
  await view('Source view')
  await page
    .locator('.source-pane .cm-line', { hasText: 'Large note' })
    .waitFor()
  await view('normal')
  await page
    .locator('.rich-pane .hibi-lp-h1', { hasText: 'Large note' })
    .waitFor()
  return { page, view }
}

/** Live JavaScript heap after a full collection. */
async function heap(page) {
  const session = await page.context().newCDPSession(page)
  await session.send('HeapProfiler.enable')
  await session.send('HeapProfiler.collectGarbage')
  await session.send('HeapProfiler.collectGarbage')
  const { usedSize } = await session.send('Runtime.getHeapUsage')
  await session.detach()
  return usedSize
}

const mounted = (page) => page.locator('.source-pane .cm-editor').count()

test('leaving the source view of a 50 MiB note unmounts it and releases its text', {
  timeout: 240000,
}, async (t) => {
  const { page, view } = await open(t, 50 * 1024)
  // Before, the hidden source view kept its own copy of the note's text.
  await waitForAsync(
    page,
    () => document.querySelectorAll('.source-pane .cm-editor').length === 0,
  ).catch(() => {})
  console.log(
    JSON.stringify({
      note: '50 MiB',
      sourceMounted: await mounted(page),
      heapMiB: Math.round((await heap(page)) / 1024 / 1024),
    }),
  )
  assert.equal(await mounted(page), 0)
  // The next visit loads the source view again.
  await view('Source view')
  await page
    .locator('.source-pane .cm-line', { hasText: 'Large note' })
    .waitFor()
})

test('a small note keeps its source view ready after a visit', {
  timeout: 120000,
}, async (t) => {
  const { page } = await open(t, 16)
  assert.equal(await mounted(page), 1)
})
