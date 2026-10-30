import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import nodeTest from 'node:test'
import { electron, waitForAsync, waitForDocumentEditor } from './electron.mjs'
import {
  selectFormattedEngine,
  testFormattedEngines as test,
} from './formatted-engine.mjs'
import { clickMenu, pressShortcut, replaceRichText } from './keyboard.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const activePage = '.editor-page[data-active="true"]'
const paneSelector = (source) =>
  `${activePage} ${source ? '.source-pane .cm-scroller' : '.rich-pane'}`

const longText = () =>
  Array.from(
    { length: 200 },
    (_, index) =>
      `## Section ${index + 1}\n\nParagraph ${index + 1} with enough text to scroll.\n`,
  ).join('\n')

async function launchApp(root, { file, save } = {}) {
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  await page.setViewportSize({ width: 1100, height: 800 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await app.evaluate(
    ({ dialog, BrowserWindow }, { file, save }) => {
      if (file)
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [file],
        })
      if (save)
        dialog.showSaveDialog = async () => ({
          canceled: false,
          filePath: save,
        })
      dialog.showMessageBox = async () => ({ response: 1 })
      for (const window of BrowserWindow.getAllWindows())
        window.webContents.setBackgroundThrottling(false)
    },
    { file, save },
  )
  return { app, page }
}

async function chooseOpenFile(app, file) {
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    })
  }, file)
}

async function settle(page, frames = 6) {
  await page.evaluate(
    (frames) =>
      new Promise((resolve) => {
        const next = () => (--frames ? requestAnimationFrame(next) : resolve())
        requestAnimationFrame(next)
      }),
    frames,
  )
}

async function ready(app, page, source = false) {
  await waitForDocumentEditor(app, page, {
    name: source ? 'Markdown editor' : 'Document editor',
  })
  await settle(page)
}

async function openFile(app, page, name, { source = false } = {}) {
  await clickMenu(app, 'Open…')
  await page.getByRole('tab', { name, exact: true }).waitFor()
  await ready(app, page, source)
}

async function closeFile(page, name) {
  await page.getByRole('button', { name: `Close ${name}`, exact: true }).click()
  await page.getByRole('tab', { name, exact: true }).waitFor({
    state: 'detached',
  })
}

async function place(app, page, source, top) {
  await ready(app, page, source)
  const pane = page.locator(paneSelector(source))
  await pane.evaluate((element, top) => {
    element.scrollTop = top
  }, top)
  await settle(page)
  return pane.evaluate((element) => element.scrollTop)
}

async function assertPlace(
  page,
  source,
  expected,
  tolerance = expected === 0 ? 2 : 60,
) {
  const selector = paneSelector(source)
  await waitForAsync(
    page,
    ({ selector, expected, tolerance }) => {
      const element = document.querySelector(selector)
      return !!element && Math.abs(element.scrollTop - expected) < tolerance
    },
    { selector, expected, tolerance },
  )
}

async function editorSettings(app, page) {
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^editor$/i, exact: true }).click()
  return page.getByRole('checkbox', {
    name: 'Remember scroll position',
    exact: true,
  })
}

async function backToApp(page) {
  await page.getByRole('button', { name: /^back to app$/i }).click()
}

async function setDefaultView(app, page, view) {
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^editor$/i, exact: true }).click()
  await page.getByLabel('Default view', { exact: true }).selectOption(view)
  await backToApp(page)
}

async function assertCaretPastStart(page) {
  await waitForAsync(
    page,
    (activePage) => {
      const pane = document.querySelector(`${activePage} .rich-pane`)
      const content = pane?.querySelector(
        '.tiptap[contenteditable="true"], .cm-content[contenteditable="true"]',
      )
      const selection = window.getSelection()
      if (!pane || !content || !selection?.rangeCount) return false
      const range = selection.getRangeAt(0)
      if (!content.contains(range.startContainer)) return false
      const before = document.createRange()
      before.selectNodeContents(content)
      before.setEnd(range.startContainer, range.startOffset)
      return (
        pane.contains(document.activeElement) && before.toString().length > 0
      )
    },
    activePage,
  )
}

test('remembers a file viewport by default across reopen and restart, and opens at the top when turned off', {
  timeout: 120000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-file-position-'))
  const file = join(root, 'long.md')
  await writeFile(file, longText())
  let app, page
  const launch = async () => ({ app, page } = await launchApp(root, { file }))
  const open = (source = false) => openFile(app, page, 'long.md', { source })
  const close = () => closeFile(page, 'long.md')
  t.after(async () => {
    await app?.close()
    await rm(root, { recursive: true, force: true })
  })

  await launch()
  await selectFormattedEngine(app, page, t.formattedEngine)
  await open()
  const rich = await place(app, page, false, 1800)
  assert.ok(rich > 1500)

  await close()
  await open()
  await assertPlace(page, false, rich)
  await assertCaretPastStart(page)
  await assertPlace(page, false, rich)

  const search = page.getByRole('search', { name: /find in document/i })
  await pressShortcut(app, `${mod}+f`)
  await search.waitFor()
  await close()
  await open()
  await assertPlace(page, false, rich)
  await pressShortcut(app, `${mod}+f`)
  await search.waitFor()
  await assertPlace(page, false, rich)
  await pressShortcut(app, 'Escape')
  await search.waitFor({ state: 'detached' })
  await assertPlace(page, false, rich)

  assert.equal(await (await editorSettings(app, page)).isChecked(), true)
  await backToApp(page)
  await page
    .getByRole('button', { name: /^source view$/i, exact: true })
    .click()
  await ready(app, page, true)
  const source = await place(app, page, true, 2700)
  assert.ok(source > 2200)
  await close()
  await open(true)
  await assertPlace(page, true, source)

  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  const resumed = await place(app, page, false, 1900)
  assert.ok(resumed > 1500)

  await app.close()
  await launch()
  await open()
  await assertPlace(page, false, resumed)

  await (await editorSettings(app, page)).uncheck()
  await backToApp(page)
  await close()
  await open()
  await assertPlace(page, false, 0)

  await app.close()
  await launch()
  await open()
  await assertPlace(page, false, 0)
  assert.equal(await (await editorSettings(app, page)).isChecked(), false)
})

test('restores both side-by-side panes after reopening', {
  timeout: 60000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-position-side-by-side-'))
  const file = join(root, 'long.md')
  await writeFile(file, longText())
  const { app, page } = await launchApp(root, { file })
  t.after(async () => {
    await app.close()
    await rm(root, { recursive: true, force: true })
  })

  await selectFormattedEngine(app, page, t.formattedEngine)
  await setDefaultView(app, page, 'side-by-side')
  await openFile(app, page, 'long.md', { source: true })
  await page
    .locator(`${activePage} .source-pane`)
    .click({ position: { x: 24, y: 24 } })
  const source = await place(app, page, true, 2700)
  assert.ok(source > 2200)
  await waitForAsync(
    page,
    (activePage) =>
      document.querySelector(`${activePage} .rich-pane`)?.scrollTop > 0,
    activePage,
  )
  await settle(page)
  const rich = await page
    .locator(paneSelector(false))
    .evaluate((element) => element.scrollTop)
  assert.ok(rich > 0)

  await closeFile(page, 'long.md')
  await openFile(app, page, 'long.md', { source: true })
  await assertPlace(page, false, rich)
  await assertPlace(page, true, source)
})

nodeTest(
  'keeps a separate viewport for each file',
  {
    timeout: 60000,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'hibi-position-files-'))
    const a = join(root, 'a', 'note.md')
    const b = join(root, 'b', 'note.md')
    await mkdir(dirname(a), { recursive: true })
    await mkdir(dirname(b), { recursive: true })
    await Promise.all([writeFile(a, longText()), writeFile(b, longText())])
    const { app, page } = await launchApp(root, { file: a })
    t.after(async () => {
      await app.close()
      await rm(root, { recursive: true, force: true })
    })

    await selectFormattedEngine(app, page, 'codemirror')
    await openFile(app, page, 'note.md')
    const first = await place(app, page, false, 1800)
    assert.ok(first > 1500)
    await closeFile(page, 'note.md')

    await chooseOpenFile(app, b)
    await openFile(app, page, 'note.md')
    await assertPlace(page, false, 0)
    const second = await place(app, page, false, 600)
    assert.ok(second > 400)
    await closeFile(page, 'note.md')

    await chooseOpenFile(app, a)
    await openFile(app, page, 'note.md')
    await assertPlace(page, false, first)
    await closeFile(page, 'note.md')

    await chooseOpenFile(app, b)
    await openFile(app, page, 'note.md')
    await assertPlace(page, false, second)
  },
)

for (const firstSave of [false, true])
  nodeTest(
    `remembers the viewport after ${firstSave ? 'first save' : 'Save As'}`,
    {
      timeout: 45000,
    },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'hibi-position-save-'))
      const original = join(root, 'original.md')
      const saved = join(root, 'saved.md')
      const text = longText()
      await writeFile(original, text)
      const { app, page } = await launchApp(root, {
        file: original,
        save: saved,
      })
      t.after(async () => {
        await app.close()
        await rm(root, { recursive: true, force: true })
      })

      const editor = await selectFormattedEngine(app, page, 'codemirror')
      if (firstSave) await replaceRichText(page, editor, text)
      else await openFile(app, page, 'original.md')

      const before = await place(app, page, false, 1800)
      assert.ok(before > 1500)
      await clickMenu(app, firstSave ? 'Save' : 'Save as…')
      await waitForAsync(page, async () => {
        const state = await window.hibi.getDocument()
        return state.name === 'saved.md' && !state.dirty
      })
      await assertPlace(page, false, before, 5)
      await closeFile(page, 'saved.md')
      await chooseOpenFile(app, saved)
      await openFile(app, page, 'saved.md')
      await assertPlace(page, false, before)
    },
  )
