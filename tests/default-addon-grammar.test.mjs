import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  electron,
  stopElectronTree,
  waitForDocumentEditor,
  waitForFormattedEditor,
} from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

// A default-on flavor missing from src/shared/built-in-grammar.ts turns off the
// source outline, plain visual typing and the math paragraph proof for everyone.
const original =
  '# Title\n\n```mermaid\ngraph TD\n# not a heading\n```\n\nneedle word $x$\n\n## Next\n\nelsewhere\n'

async function open(t, addons, source = original) {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-default-grammar-'))
  const profile = join(folder, 'profile')
  const file = join(folder, 'note.md')
  await mkdir(profile)
  if (addons)
    await writeFile(join(profile, 'addons.json'), JSON.stringify(addons))
  await writeFile(file, source)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`, file],
  })
  const watchdog = setTimeout(() => stopElectronTree(app.process()), 55000)
  t.after(async () => {
    await app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1 })
      })
      .catch(() => {})
    await app.close().catch(() => {})
    clearTimeout(watchdog)
    await rm(folder, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  await waitForAsync(
    page,
    async () => (await window.hibi?.getDocument())?.name === 'note.md',
  )
  await waitForDocumentEditor(app, page)
  await waitForFormattedEditor(app, page)
  await page.locator('.rich-pane .mermaid-block').waitFor()
  return { app, page }
}

async function sourceOutline(page, count) {
  await page.getByRole('button', { name: /^source view$/i }).click()
  await page
    .getByRole('textbox', { name: 'Markdown editor', exact: true })
    .waitFor()
  await page.getByRole('button', { name: /^toggle right sidebar$/i }).click()
  await page.getByRole('button', { name: /^right sidebar views$/i }).click()
  await page
    .getByRole('menuitem', { name: 'On this page', exact: true })
    .click()
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll(
        '.outline-sidebar[data-side="right"] [role="treeitem"][id^="right-outline-source:"]',
      ).length === count,
    count,
  )
  return page
    .locator('.outline-sidebar[data-side="right"][data-open="true"]')
    .locator('.sidebar-label')
    .allTextContents()
}

test('default addons keep plain visual typing, caret history and the source outline', {
  timeout: 60000,
}, async (t) => {
  const { app, page } = await open(t)
  const rich = page.getByRole('textbox', {
    name: 'Document editor',
    exact: true,
  })
  await rich.evaluate((element) => {
    const view = element.cmTile.root.view
    view.dispatch({
      selection: { anchor: view.state.doc.length - 1 },
      scrollIntoView: true,
    })
  })
  await rich.focus()
  await page.keyboard.insertText('s')
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    original.replace('elsewhere', 'elsewheres'),
  )
  const word = await rich.evaluate((element) => {
    const view = element.cmTile.root.view
    const from = view.state.doc.toString().indexOf('needle')
    view.dispatch({
      selection: { anchor: from, head: from + 6 },
      scrollIntoView: true,
    })
    return { from, to: from + 6 }
  })
  await page.keyboard.insertText('pin')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('pin word'),
  )
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+z' : 'Control+z',
  )
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('needle word'),
  )
  assert.equal(
    await rich.evaluate(
      (element) => element.cmTile.root.view.state.selection.main.to,
    ),
    word.to,
    'undo keeps the caret at the restored word',
  )
  assert.deepEqual(await sourceOutline(page, 2), ['Title', 'Next'])
})

test('a quoted diagram keeps the source outline in step with the rich view', {
  timeout: 60000,
}, async (t) => {
  // The quote ends at its diagram, so the next two lines are a setext heading.
  const { page } = await open(
    t,
    undefined,
    '> ```mermaid\n> graph TD\n> A-->B\n> ```\noutside\n===\n\n# real\n',
  )

  // The note opens with the caret in `# real`, whose revealed `# ` is
  // editable text; the heading's name stays its rendered text (marker-007).
  assert.deepEqual(
    await page
      .locator('.rich-pane [role="heading"]')
      .evaluateAll((headings) =>
        headings.map(
          (heading) =>
            heading.getAttribute('aria-label') ?? heading.textContent,
        ),
      ),
    ['outside', 'real'],
  )
  assert.deepEqual(await sourceOutline(page, 2), ['outside', 'real'])
})

test('default addons keep the math paragraph proof', {
  timeout: 60000,
}, async (t) => {
  const { app, page } = await open(t, { math: true })
  // Bounded parsing: live-preview.test.mjs, 50 MiB tests.
  await page.locator('.rich-pane .katex').waitFor()
  const rich = page.getByRole('textbox', {
    name: 'Document editor',
    exact: true,
  })
  await rich.evaluate((element) => {
    const view = element.cmTile.root.view
    view.dispatch({
      selection: { anchor: view.state.doc.length - 1 },
      scrollIntoView: true,
    })
  })
  await rich.focus()
  await page.keyboard.insertText('!')
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    original.replace('elsewhere', 'elsewhere!'),
  )
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+z' : 'Control+z',
  )
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    original,
  )
  assert.deepEqual(await sourceOutline(page, 2), ['Title', 'Next'])
})
