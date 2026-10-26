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

  // Formatting shortcuts edit the Markdown source of the selection.
  await page.locator('.rich-pane .cm-line', { hasText: 'two' }).dblclick()
  await page.keyboard.press(`${mod}+b`)
  await saved('includes', '- **two**')
  await page.locator('.rich-pane .hibi-lp-strong', { hasText: 'two' }).waitFor()
})

test('behind the switch, hidden fence lines and multi-line link destinations stay intact while editing', {
  timeout: 90000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-formatted-view-'))
  const file = join(folder, 'notes', 'note.md')
  await mkdir(join(folder, 'notes'))
  await writeFile(
    file,
    '# Edits\n\nintro\n```js\ncode\n```\n\nsee [label](\nhttps://example.com/\n)\n',
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  const page = await app.firstWindow()
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
  await page.locator('.rich-pane .hibi-lp-h1', { hasText: 'Edits' }).waitFor()
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const markdown = async () =>
    (await page.evaluate(() => window.hibi.getDocument())).markdown

  const caretLine = () =>
    page.evaluate(() => {
      const view = document.querySelector('.rich-pane .cm-content').cmTile.root
        .view
      return view.state.doc.lineAt(view.state.selection.main.head).text
    })

  // Typing beside a multi-line link destination edits the label. Before,
  // the input did not reach the text and the view threw.
  await page.evaluate(() => {
    const view = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    view.focus()
    view.dispatch({
      selection: { anchor: view.state.doc.toString().lastIndexOf(')') + 1 },
    })
  })
  await page.keyboard.type('x')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes(
      '[label](\nhttps://example.com/\n)x',
    ),
  )

  // Arrows step over hidden fence lines, so typing lands on visible lines.
  // Before, the caret could rest on one and the text went into the fence.
  await page.locator('.rich-pane .cm-line', { hasText: 'code' }).click()
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowLeft')
  assert.equal(await caretLine(), 'intro')
  await page.keyboard.type('Y')
  await page.locator('.rich-pane .cm-line', { hasText: 'code' }).click()
  await page.keyboard.press('End')
  await page.keyboard.press('ArrowRight')
  assert.equal(await caretLine(), '')
  await page.keyboard.type('Z')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('Z'),
  )
  assert.ok(
    (await markdown()).includes('introY\n```js\ncode\n```\n'),
    await markdown(),
  )
})

test('behind the switch, completions get prose context past the first 16 KiB', {
  timeout: 90000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-formatted-view-'))
  const file = join(folder, 'long.md')
  const addon = join(folder, 'profile', 'installed-addons', 'completion-probe')
  await mkdir(addon, { recursive: true })
  await writeFile(
    file,
    `${'Small prose paragraph with a few words.\n\n'.repeat(500)}last paragraph prose`,
  )
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
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await pressShortcut(app, `${mod}+o`)
  await page.waitForFunction(() => window.completionProbe?.ready)
  const formatted = page.locator('.rich-pane .cm-content')
  await formatted.waitFor()
  await formatted.focus()
  await formatted.press(
    process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End',
  )
  await page.keyboard.press('Control+Space')
  await page.waitForFunction(() => window.completionProbe.calls.length > 0)
  const call = await page.evaluate(() => window.completionProbe.calls.at(-1))
  // Before, the context was null past character 16,384.
  assert.ok(call.head > 16384, JSON.stringify(call))
  assert.equal(call.prose?.before, 'last paragraph prose', JSON.stringify(call))
})
