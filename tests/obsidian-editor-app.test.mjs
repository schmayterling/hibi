import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu, pressShortcut, splitTab } from './keyboard.mjs'
import { fixtureVault } from './obsidian/harness.mjs'
import { waitForAsync } from './poll.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const note =
  'TODO first\r\n\r\n```fixture-count\r\na\r\nb\r\n```\r\n\r\nend\r\n'

/** Every pane's CodeMirror editors and what the fixture's extensions drew in them. */
const editors = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.cm-editor')]
      .filter((editor) => editor.querySelector('.cm-content[contenteditable]'))
      .map((editor) => ({
        side:
          editor
            .closest('.editor-page[data-side]')
            ?.getAttribute('data-side') ?? null,
        pane: editor.closest('.rich-pane') ? 'rich' : 'source',
        live: editor.getAttribute('data-fixture-live'),
        info: editor.getAttribute('data-fixture-info'),
        other: editor.getAttribute('data-fixture-other'),
        todo: editor.querySelectorAll('.fixture-todo').length,
      })),
  )

async function command(app, page, name) {
  await clickMenu(app, 'Command palette')
  const palette = page.getByRole('dialog', { name: /^command palette$/i })
  await palette.getByRole('combobox', { name: /search commands/i }).fill(name)
  await palette.getByRole('option', { name: new RegExp(name, 'i') }).click()
  await palette.waitFor({ state: 'hidden' })
}

test('obsidian editor extensions, commands and code blocks run in every pane and leave on unload', {
  timeout: 120000,
}, async (t) => {
  const fixture = await fixtureVault(t, 'editor-surface', { cleanup: false })
  await writeFile(join(fixture.vault, 'note.md'), note)
  await writeFile(join(fixture.vault, 'other.md'), 'TODO other\r\n')
  const kept = async () =>
    Promise.all(
      [
        'untouched.md',
        '.obsidian/plugins/editor-surface/main.js',
        '.obsidian/plugins/editor-surface/data.json',
      ].map((path) => readFile(join(fixture.vault, path), 'hex')),
    )
  const before = await kept()
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${fixture.overlay}`],
  })
  t.after(async () => {
    try {
      await app.close()
      assert.deepEqual(await kept(), before)
    } finally {
      await fixture.dispose()
    }
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ dialog }, vault) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [vault],
    })
    dialog.showMessageBox = async () => ({ response: 1 })
  }, fixture.vault)
  await pressShortcut(app, `${mod}+Shift+o`)
  const warning = page.getByRole('dialog', {
    name: 'Back up this Obsidian vault',
  })
  await warning
    .locator('.dialog-footer')
    .getByRole('button', { name: 'Continue', exact: true })
    .click()
  await warning.waitFor({ state: 'hidden' })
  await page.locator('.app[aria-busy="false"]').waitFor()

  const tree = page.getByRole('tree', { name: /workspace files/i })
  await tree.getByRole('treeitem', { name: 'other.md', exact: true }).click()
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).name === 'other.md',
  )
  const otherTab = (await page.evaluate(() => window.hibi.getDocument())).tabId
  await tree.getByRole('treeitem', { name: 'note.md', exact: true }).click()
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).name === 'note.md',
  )
  await waitForDocumentEditor(app, page)

  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  await page
    .getByRole('checkbox', { name: 'Obsidian plugins', exact: true })
    .click()
  await page.getByRole('tab', { name: 'Obsidian plugins', exact: true }).click()
  await page.getByRole('button', { name: 'Install copy', exact: true }).click()
  const enabled = page.getByRole('checkbox', {
    name: 'Enable Editor surface',
    exact: true,
  })
  await enabled.click()
  await page.waitForFunction(() => window.__hibiEditorFixture)
  await page.getByRole('button', { name: 'Back to app', exact: true }).click()

  // Source and formatted views side by side: both get the healthy extensions.
  await page
    .getByRole('button', { name: /^side-by-side$/i, exact: true })
    .click()
  await page.locator('.mode-side-by-side[data-source-ready="true"]').waitFor()
  await waitForAsync(page, () =>
    ['.source-pane', '.rich-pane'].every((pane) =>
      document.querySelector(
        `${pane} .cm-editor[data-fixture-other="yes"] .fixture-todo`,
      ),
    ),
  )
  const shown = await editors(page)
  assert.deepEqual(
    shown
      .map(({ pane, live, info, other, todo }) => ({
        pane,
        live,
        info,
        other,
        todo,
      }))
      .sort((a, b) => a.pane.localeCompare(b.pane)),
    [
      { pane: 'rich', live: 'true', info: 'true', other: 'yes', todo: 1 },
      { pane: 'source', live: 'false', info: 'true', other: 'yes', todo: 1 },
    ],
  )

  // The throwing extension is reported and left out; the editors keep working.
  await page
    .locator('.toast', {
      hasText: 'obsidian.editor-surface-2: fixture extension failed',
    })
    .first()
    .waitFor()

  // Code block processor renders the fence with its source lines.
  await waitForAsync(
    page,
    () =>
      document.querySelector('.rich-pane .obsidian-code-block')?.textContent ===
      'lines: 2',
  )
  assert.deepEqual(
    await page.evaluate(() => {
      const { lineStart, lineEnd } = window.__hibiEditorFixture.sections.at(-1)
      return { lineStart, lineEnd }
    }),
    { lineStart: 2, lineEnd: 5 },
  )

  // The keymap runs in the source pane.
  const source = '.source-pane .cm-content'
  await page.evaluate((selector) => {
    const editor = document.querySelector(selector).cmTile.root.view
    editor.focus()
    editor.dispatch({ selection: { anchor: editor.state.doc.length } })
  }, source)
  await page.keyboard.press(`${mod === 'Meta' ? 'Meta' : 'Control'}+Alt+j`)
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.endsWith('end\r\n[stamp]'),
  )

  // editorCallback wraps the selection in one undoable edit of the captured pane.
  await page.evaluate((selector) => {
    const editor = document.querySelector(selector).cmTile.root.view
    editor.focus()
    editor.dispatch({ selection: { anchor: 5, head: 10 } })
  }, source)
  await command(app, page, 'Wrap fixture selection')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.startsWith('TODO ==first==\r\n'),
  )
  assert.equal(
    await page.evaluate(() => window.__hibiEditorFixture.view.getViewType()),
    'markdown',
  )
  await page.evaluate(() => window.__hibiEditorFixture.editor.undo())
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.startsWith('TODO first\r\n'),
  )
  assert.ok(
    (await page.evaluate(() => window.hibi.getDocument())).markdown.endsWith(
      'end\r\n[stamp]',
    ),
  )

  // Split panes: the other note's pane gets the extensions too.
  await splitTab(app, page, otherTab)
  await waitForAsync(page, () =>
    ['left', 'right'].every((side) =>
      document.querySelector(
        `.editor-page[data-side="${side}"] .cm-editor[data-fixture-other="yes"] .fixture-todo`,
      ),
    ),
  )
  const split = await editors(page)
  assert.deepEqual([...new Set(split.map(({ side }) => side))].sort(), [
    'left',
    'right',
  ])
  assert.ok(split.every(({ other, todo }) => other === 'yes' && todo === 1))

  // Unload removes every decoration, attribute and key.
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Obsidian plugins', exact: true }).click()
  await page
    .getByRole('checkbox', { name: 'Enable Editor surface', exact: true })
    .click()
  await page.waitForFunction(() => window.__hibiEditorFixture.unloaded === 1)
  await page.getByRole('button', { name: 'Back to app', exact: true }).click()
  await waitForAsync(
    page,
    () =>
      !document.querySelector(
        '.fixture-todo, [data-fixture-other], [data-fixture-live], .obsidian-code-block',
      ),
  )
  // The removed key does nothing in a pane it ran in before.
  const pane = '.editor-page[data-side="left"] .source-pane .cm-content'
  const text = () =>
    page.evaluate(
      (pane) =>
        document.querySelector(pane).cmTile.root.view.state.doc.toString(),
      pane,
    )
  await page.evaluate((pane) => {
    const editor = document.querySelector(pane).cmTile.root.view
    editor.focus()
    editor.dispatch({ selection: { anchor: editor.state.doc.length } })
  }, pane)
  await waitForAsync(
    page,
    (pane) => document.activeElement === document.querySelector(pane),
    pane,
  )
  const unchanged = await text()
  assert.ok(unchanged.endsWith('[stamp]'))
  await page.keyboard.press(`${mod === 'Meta' ? 'Meta' : 'Control'}+Alt+j`)
  await page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  )
  assert.equal(await text(), unchanged)
  assert.deepEqual(errors, [])
})
