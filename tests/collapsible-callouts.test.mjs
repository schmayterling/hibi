import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForAsync } from './electron.mjs'
import {
  selectFormattedEngine,
  testFormattedEngines,
} from './formatted-engine.mjs'
import { pressShortcut } from './keyboard.mjs'

// Preserve casing, spacing, CRLF, and trailing whitespace across view-only folds.
const note = [
  '# Folding',
  '',
  '> [!NoTe]-  Closed title  ',
  '> Hidden paragraph.',
  '>',
  '> - Hidden list item',
  '>',
  '> ```js',
  '> const hidden = 1',
  '> ```',
  '>',
  '> | hidden | table |',
  '> | --- | --- |',
  '> | one | two |',
  '',
  '> [!tip]+ Open title',
  '> Visible paragraph.',
  '>',
  '> > [!warning]- Nested title',
  '> > Nested paragraph.',
  '',
  '> [!note] Fixed title',
  '> Always visible.',
  '',
  'After callouts.',
  '',
].join('\r\n')

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

testFormattedEngines(
  'callouts fold with pointer and keyboard without changing markdown',
  {
    timeout: 150000,
  },
  async (t) => {
    const engine = t.formattedEngine
    const folder = await mkdtemp(join(tmpdir(), 'hibi-callout-fold-'))
    await mkdir(join(folder, 'notes'))
    const file = join(folder, 'notes', 'folds.md')
    await writeFile(file, note)
    const app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
    })
    t.after(async () => {
      await app.close()
      await rm(folder, { recursive: true, force: true })
    })
    const page = await app.firstWindow()
    page.setDefaultTimeout(20000)
    await selectFormattedEngine(app, page, engine)
    const session = await page.context().newCDPSession(page)
    await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      })
      dialog.showMessageBox = async () => ({ response: 1 })
    }, file)
    await pressShortcut(app, `${mod}+o`)
    const pane = page.locator('.rich-pane')
    await pane.getByText('After callouts.', { exact: true }).waitFor()
    const control = (title) =>
      pane.getByRole('button', { name: new RegExp(`callout: ${title}$`) })
    const closed = control('Closed title')
    const open = control('Open title')
    const nested = control('Nested title')
    const read = () =>
      page.evaluate(async () => (await window.hibi.getDocument()).markdown)
    const unchanged = async () => {
      assert.equal(await read(), note)
      assert.equal(
        await page.evaluate(
          async () => (await window.hibi.getDocument()).dirty,
        ),
        false,
      )
    }

    await closed.waitFor()
    assert.equal(await closed.getAttribute('aria-expanded'), 'false')
    assert.equal(await open.getAttribute('aria-expanded'), 'true')
    assert.equal(await nested.getAttribute('aria-expanded'), 'false')
    assert.equal(
      await pane.getByRole('button', { name: /callout:/ }).count(),
      3,
    )
    assert.equal(
      await pane.getByText('Hidden paragraph.', { exact: true }).isVisible(),
      false,
    )
    assert.equal(
      await pane.getByText('Visible paragraph.', { exact: true }).isVisible(),
      true,
    )
    assert.equal(
      await pane.getByText('Nested paragraph.', { exact: true }).isVisible(),
      false,
    )
    assert.equal(
      await pane.getByText('Always visible.', { exact: true }).isVisible(),
      true,
    )
    await unchanged()

    await closed.focus()
    await page.keyboard.press('Tab')
    assert.equal(
      await open.evaluate((element) => element === document.activeElement),
      true,
    )
    await page.keyboard.press('Shift+Tab')
    assert.equal(
      await closed.evaluate((element) => element === document.activeElement),
      true,
    )
    await page.keyboard.press('Enter')
    await pane.getByText('Hidden paragraph.', { exact: true }).waitFor()
    assert.equal(await closed.getAttribute('aria-expanded'), 'true')
    assert.equal(
      await pane.getByText('Hidden list item', { exact: true }).isVisible(),
      true,
    )
    assert.equal(await pane.locator('table').count(), 1)
    await unchanged()
    await closed.focus()
    await page.keyboard.press('Space')
    assert.equal(await closed.getAttribute('aria-expanded'), 'false')
    assert.equal(
      await pane.getByText('Hidden paragraph.', { exact: true }).isVisible(),
      false,
    )
    await unchanged()

    await nested.scrollIntoViewIfNeeded()
    assert.equal(
      await nested.evaluate((element) => {
        const box = element.getBoundingClientRect()
        return element.contains(
          document.elementFromPoint(
            box.x + box.width / 2,
            box.y + box.height / 2,
          ),
        )
      }),
      true,
    )
    await nested.click()
    await pane.getByText('Nested paragraph.', { exact: true }).waitFor()
    assert.equal(await nested.getAttribute('aria-expanded'), 'true')
    await open.focus()
    await page.keyboard.press('Enter')
    assert.equal(await open.getAttribute('aria-expanded'), 'false')
    assert.equal(
      await pane.getByText('Visible paragraph.', { exact: true }).isVisible(),
      false,
    )
    assert.equal(
      await pane.getByText('Nested paragraph.', { exact: true }).isVisible(),
      false,
    )
    await open.focus()
    await page.keyboard.press('Space')
    await pane.getByText('Nested paragraph.', { exact: true }).waitFor()
    assert.equal(await nested.getAttribute('aria-expanded'), 'true')
    await unchanged()

    await pressShortcut(app, `${mod}+Shift+]`)
    await page.locator('.source-pane .cm-content').waitFor()
    await unchanged()
    await pressShortcut(app, `${mod}+Shift+[`)
    await pane.getByText('After callouts.', { exact: true }).waitFor()
    await unchanged()
    await pressShortcut(app, `${mod}+s`)
    assert.equal(await readFile(file, 'utf8'), note)
  },
)

/** Launch with `markdown` open in the formatted view of `engine`. */
async function openNote(t, engine, markdown) {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-callout-fold-'))
  await mkdir(join(folder, 'notes'))
  const file = join(folder, 'notes', 'folds.md')
  await writeFile(file, markdown)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(20000)
  await selectFormattedEngine(app, page, engine)
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    dialog.showMessageBox = async () => ({ response: 1 })
  }, file)
  await pressShortcut(app, `${mod}+o`)
  const pane = page.locator('.rich-pane')
  await pane.getByText('After paragraph.', { exact: true }).waitFor()
  return { app, page, pane }
}

const hiding = [
  '# Reveal',
  '',
  'Before paragraph.',
  '',
  '> [!note]- Closed title',
  '> hidden alpha body.',
  '>',
  '> ## Hidden heading',
  '>',
  '> hidden omega end',
  '>',
  '> | hidden | table |',
  '> | --- | --- |',
  '> | one | two |',
  '',
  'After paragraph.',
  '',
].join('\n')

testFormattedEngines(
  'find, the outline and undo unfold a callout, and folding keeps typing in view',
  { timeout: 150000 },
  async (t) => {
    const engine = t.formattedEngine
    const { app, page, pane } = await openNote(t, engine, hiding)
    const closed = pane.getByRole('button', { name: /callout: Closed title$/ })
    const shown = (text) =>
      pane.getByText(text, { exact: true }).first().isVisible()
    const editorFocused = () =>
      page.evaluate(() =>
        document.activeElement?.matches('.rich-pane .cm-content, .tiptap'),
      )
    // The caret where the text is: in codemirror the Markdown source.
    const place = (text, offset) =>
      page.evaluate(
        ({ text, offset }) => {
          const content = document.querySelector('.rich-pane .cm-content')
          if (content) {
            const { view } = content.cmTile.root
            view.focus()
            view.dispatch({
              selection: {
                anchor: view.state.doc.toString().indexOf(text) + offset,
              },
            })
            return
          }
          const { editor } = document.querySelector('.tiptap')
          let at = -1
          editor.state.doc.descendants((node, pos) => {
            if (at < 0 && node.isText && node.text.includes(text))
              at = pos + node.text.indexOf(text) + offset
          })
          editor.view.focus()
          editor.commands.setTextSelection(at)
        },
        { text, offset },
      )
    const markdown = () =>
      page.evaluate(async () => (await window.hibi.getDocument()).markdown)

    await closed.waitFor()
    assert.equal(await closed.getAttribute('aria-expanded'), 'false')
    const name = await closed.getAttribute('aria-label')
    // A folded box is as tall below its title as above it.
    const gaps = await closed.evaluate((button) => {
      const box = (
        button.closest('blockquote') ?? button.closest('.cm-line')
      ).getBoundingClientRect()
      const text = (
        button.closest('blockquote')
          ? button.nextElementSibling
          : button
              .closest('.cm-line')
              .querySelector('.hibi-lp-alert-title-text')
      ).getBoundingClientRect()
      return Math.round(text.top - box.top - (box.bottom - text.bottom))
    })
    assert.ok(Math.abs(gaps) <= 1, `title gaps differ by ${gaps}px`)

    // Find selects a match in the folded body and shows it.
    await place('Before paragraph.', 0)
    await pressShortcut(app, `${mod}+f`)
    const input = page.getByRole('textbox', {
      name: 'Find in document',
      exact: true,
    })
    await input.fill('omega')
    await page.locator('.find-bar output', { hasText: /\/1$/ }).waitFor()
    await input.press('Enter')
    await pane.getByText('hidden omega end', { exact: true }).waitFor()
    assert.equal(await closed.getAttribute('aria-expanded'), 'true')
    // Its name stays put while aria-expanded tells the state.
    assert.equal(await closed.getAttribute('aria-label'), name)
    await input.press('Escape')

    // A pointer fold keeps the caret and focus in the text.
    await place('After paragraph.', 0)
    await closed.click()
    assert.equal(await closed.getAttribute('aria-expanded'), 'false')
    assert.equal(await editorFocused(), true)

    // The outline jumps to a heading in the folded body and shows it.
    await page.getByRole('button', { name: /^toggle right sidebar$/i }).click()
    await page.getByRole('button', { name: /^right sidebar views$/i }).click()
    await page
      .getByRole('menuitem', { name: 'On this page', exact: true })
      .click()
    await page
      .locator('.outline-sidebar[data-side="right"][data-open="true"]')
      .getByRole('treeitem', { name: 'Hidden heading', exact: true })
      .click()
    // The focused heading line shows its markers in codemirror.
    await pane.getByText('Hidden heading').first().waitFor()
    assert.equal(await closed.getAttribute('aria-expanded'), 'true')

    // Undo of typing in a body folded since shows it again.
    await place('hidden alpha body.', 'hidden'.length)
    await page.keyboard.type('Z')
    await pane.getByText('hiddenZ alpha body.', { exact: true }).waitFor()
    await closed.click()
    assert.equal(await shown('hiddenZ alpha body.'), false)
    await pressShortcut(app, `${mod}+z`)
    await pane.getByText('hidden alpha body.', { exact: true }).waitFor()
    assert.equal(await closed.getAttribute('aria-expanded'), 'true')
    assert.equal(await markdown(), hiding)

    // Typing after folding around the caret stays in view.
    await place('hidden alpha body.', 'hidden'.length)
    await closed.click()
    assert.equal(await editorFocused(), true)
    await page.keyboard.type('KK')
    await waitForAsync(page, async () =>
      (await window.hibi.getDocument()).markdown.includes('KK'),
    )
    assert.equal(await pane.getByText(/KK/).first().isVisible(), true)
  },
)

test('codemirror: a callout keeps its own fold state as text around it changes', {
  timeout: 120000,
}, async (t) => {
  const { page, pane } = await openNote(
    t,
    'codemirror',
    [
      'Before paragraph.',
      '',
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '> [!caution]- First',
      '> first body',
      '',
      '> [!note]- Second',
      '> second body',
      '',
      'After paragraph.',
      '',
    ].join('\n'),
  )
  const first = pane.getByRole('button', { name: /callout: First$/ })
  const second = pane.getByRole('button', { name: /callout: Second$/ })
  await first.click()
  await pane.getByText('first body', { exact: true }).waitFor()
  const cell = await pane.locator('table td').first().elementHandle()
  const edit = (find, insert, length = 0) =>
    page.evaluate(
      ({ find, insert, length }) => {
        const { view } = document.querySelector('.rich-pane .cm-content').cmTile
          .root
        const at = view.state.doc.toString().indexOf(find)
        view.dispatch({ changes: { from: at, to: at + length, insert } })
      },
      { find, insert, length },
    )
  // Moving a folded callout keeps the table cells above it.
  await edit('Before', 'Text. ')
  await pane.getByText('Text. Before paragraph.', { exact: true }).waitFor()
  assert.equal(await cell.evaluate((element) => element.isConnected), true)
  // Deleting a callout drops its state rather than handing it to the next.
  await edit(
    '> [!caution]-',
    '',
    '> [!caution]- First\n> first body\n\n'.length,
  )
  await first.waitFor({ state: 'detached' })
  assert.equal(await second.getAttribute('aria-expanded'), 'false')
  assert.equal(
    await pane.getByText('second body', { exact: true }).isVisible(),
    false,
  )
})
