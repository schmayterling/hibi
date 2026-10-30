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
import { clickMenu, pressShortcut } from './keyboard.mjs'

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
  return { app, page, pane, file }
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

test('codemirror: a tab keeps its callout folds across tab switches and a reload from disk', {
  timeout: 150000,
}, async (t) => {
  const markdown = [
    '> [!note]- Closed first',
    '> first body',
    '',
    '> [!tip]+ Open second',
    '> second body',
    '>',
    '> > [!warning]- Nested third',
    '> > third body',
    '',
    'After paragraph.',
    '',
  ].join('\n')
  const { app, page, pane, file } = await openNote(t, 'codemirror', markdown)
  const other = join(file, '..', 'other.md')
  await writeFile(other, '# Other\n\nOther note.\n')
  const control = (title) =>
    pane.getByRole('button', { name: new RegExp(`callout: ${title}$`) })
  const [first, second, third] = [
    control('Closed first'),
    control('Open second'),
    control('Nested third'),
  ]
  const open = async (path) => {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      })
    }, path)
    await pressShortcut(app, `${mod}+o`)
  }
  const back = async (text) => {
    await page.getByRole('tab', { name: /folds/ }).first().click()
    await pane.getByText(text, { exact: true }).waitFor()
    await first.waitFor()
  }
  /** The reader's folds: first and second open, the nested third closed. */
  const kept = async () => {
    assert.equal(await first.getAttribute('aria-expanded'), 'true')
    assert.equal(await second.getAttribute('aria-expanded'), 'false')
    assert.equal(await pane.getByText('third body', { exact: true }).count(), 0)
    await second.click()
    assert.equal(await third.getAttribute('aria-expanded'), 'true')
    await second.click()
    assert.equal(await second.getAttribute('aria-expanded'), 'false')
  }
  await third.click()
  await first.click()
  await second.click()
  await pane.getByText('first body', { exact: true }).waitFor()
  assert.equal(await second.getAttribute('aria-expanded'), 'false')

  await open(other)
  await pane.getByText('Other note.', { exact: true }).waitFor()
  await back('After paragraph.')
  await kept()

  // A clean tab reads its file again on return; the folds follow their callouts.
  await open(other)
  await pane.getByText('Other note.', { exact: true }).waitFor()
  const changed = `Disk line.\n\n${markdown}`
  await writeFile(file, changed)
  await back('Disk line.')
  await kept()
  const current = await page.evaluate(() => window.hibi.getDocument())
  assert.equal(current.markdown, changed)
  assert.equal(current.dirty, false)
})

test('codemirror: arrows step over a folded body, and Backspace or Delete beside it unfold it first', {
  timeout: 120000,
}, async (t) => {
  const markdown = [
    'Before paragraph.',
    '',
    '> [!note]- Closed title',
    '> hidden alpha body.',
    '',
    'After paragraph.',
    '',
  ].join('\n')
  const { page, pane } = await openNote(t, 'codemirror', markdown)
  const closed = pane.getByRole('button', { name: /callout: Closed title$/ })
  const titleEnd = markdown.indexOf('Closed title') + 'Closed title'.length
  const after = markdown.indexOf('After paragraph.')
  const place = (at) =>
    page.evaluate((at) => {
      const { view } = document.querySelector('.rich-pane .cm-content').cmTile
        .root
      view.focus()
      view.dispatch({ selection: { anchor: at } })
    }, at)
  const head = () =>
    page.evaluate(
      () =>
        document.querySelector('.rich-pane .cm-content').cmTile.root.view.state
          .selection.main.head,
    )
  const read = () =>
    page.evaluate(async () => (await window.hibi.getDocument()).markdown)

  await closed.waitFor()
  await place(titleEnd)
  // One press each way crosses the fold, as Up and Down do.
  await page.keyboard.press('ArrowRight')
  assert.equal(await head(), after)
  await page.keyboard.press('ArrowLeft')
  assert.equal(await head(), titleEnd)
  assert.equal(await closed.getAttribute('aria-expanded'), 'false')

  // Delete at the title's end shows the body rather than removing it unseen.
  await page.keyboard.press('Delete')
  assert.equal(await closed.getAttribute('aria-expanded'), 'true')
  await pane.getByText('hidden alpha body.', { exact: true }).waitFor()
  assert.equal(await read(), markdown)
  assert.equal(await head(), titleEnd)

  // So does Backspace after the fold, which would pull the next line into it.
  await closed.click()
  assert.equal(await closed.getAttribute('aria-expanded'), 'false')
  await place(after)
  await page.keyboard.press('Backspace')
  assert.equal(await closed.getAttribute('aria-expanded'), 'true')
  assert.equal(await read(), markdown)
  assert.equal(await head(), after)

  // Backspace on the blank line after the fold, which moves the caret to the
  // end of the line above, shows the body rather than typing into it unseen.
  await closed.click()
  assert.equal(await closed.getAttribute('aria-expanded'), 'false')
  await place(after - 1)
  await page.keyboard.press('Backspace')
  assert.equal(await closed.getAttribute('aria-expanded'), 'true')
  assert.equal(await head(), after - 2)
  assert.equal(await read(), markdown)

  // A shown body edits as any text does.
  await place(titleEnd)
  await page.keyboard.press('Delete')
  await waitForAsync(
    page,
    async (markdown) => (await window.hibi.getDocument()).markdown !== markdown,
    markdown,
  )
})

test('codemirror: a disk edit that drops the open callout leaves the next one folded', {
  timeout: 120000,
}, async (t) => {
  const markdown = [
    '> [!note]- First',
    '> first body',
    '',
    '> [!note]- Second',
    '> second body',
    '',
    'After paragraph.',
    '',
  ].join('\n')
  const { app, page, pane, file } = await openNote(t, 'codemirror', markdown)
  const first = pane.getByRole('button', { name: /callout: First$/ })
  const second = pane.getByRole('button', { name: /callout: Second$/ })
  await first.click()
  await pane.getByText('first body', { exact: true }).waitFor()
  const other = join(file, '..', 'other.md')
  await writeFile(other, '# Other\n\nOther note.\n')
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, other)
  await pressShortcut(app, `${mod}+o`)
  await pane.getByText('Other note.', { exact: true }).waitFor()
  // The first callout goes on disk, so the second starts where it started;
  // the first's state does not become the second's.
  await writeFile(
    file,
    markdown.replace('> [!note]- First\n> first body\n\n', ''),
  )
  await page.getByRole('tab', { name: /folds/ }).first().click()
  await pane.getByText('After paragraph.', { exact: true }).waitFor()
  await second.waitFor()
  assert.equal(await first.count(), 0)
  assert.equal(await second.getAttribute('aria-expanded'), 'false')
  assert.equal(await pane.getByText('second body', { exact: true }).count(), 0)
})

/** Opens `markdown`, which ends in a callout folded under "Closed title". */
async function opensFolded(t, markdown) {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-callout-fold-'))
  await mkdir(join(folder, 'notes'))
  const file = join(folder, 'notes', 'folds.md')
  await writeFile(file, markdown)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(20000)
  await selectFormattedEngine(app, page, 'codemirror')
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await pressShortcut(app, `${mod}+o`)
  const pane = page.locator('.rich-pane')
  const closed = pane.getByRole('button', { name: /callout: Closed title$/ })
  await closed.waitFor()
  // The open caret lands at the end of the outermost folded title, not at
  // the hidden body's end nor at an inner title that fold hides.
  const titleEnd = markdown.indexOf('Closed title') + 'Closed title'.length
  await waitForAsync(
    page,
    (at) =>
      document.querySelector('.rich-pane .cm-content').cmTile.root.view.state
        .selection.main.head === at,
    titleEnd,
  )
  assert.equal(await closed.getAttribute('aria-expanded'), 'false')
  assert.equal(
    await pane.getByText('hidden alpha body.', { exact: true }).count(),
    0,
  )
  assert.equal(
    await pane.getByRole('button', { name: /callout: Inner title$/ }).count(),
    0,
  )
}

test(
  'codemirror: a note that ends in a folded callout opens with it folded',
  {
    timeout: 120000,
  },
  (t) =>
    opensFolded(
      t,
      [
        'Before paragraph.',
        '',
        '> [!note]- Closed title',
        '> hidden alpha body.',
        '',
      ].join('\n'),
    ),
)

test(
  'codemirror: a note that ends in nested folded callouts opens with them folded',
  {
    timeout: 120000,
  },
  (t) =>
    opensFolded(
      t,
      [
        'Before paragraph.',
        '',
        '> [!note]- Closed title',
        '> outer body.',
        '>',
        '> > [!tip]- Inner title',
        '> > hidden alpha body.',
        '',
      ].join('\n'),
    ),
)

test('codemirror: a closed tab releases its remembered folds and text', {
  timeout: 240000,
}, async (t) => {
  const size = 8 * 1024 * 1024
  const line = 'a line of a large note with folds, closed again 0123456789\n\n'
  const { app, page, pane, file } = await openNote(
    t,
    'codemirror',
    'Small note.\n\nAfter paragraph.\n',
  )
  const large = join(file, '..', 'large.md')
  await writeFile(
    large,
    `> [!note]- Folded title\n> hidden body.\n\n${line.repeat(Math.ceil(size / line.length))}`,
  )
  const cdp = await page.context().newCDPSession(page)
  const heap = async () => {
    for (let pass = 0; pass < 3; pass++)
      await cdp.send('HeapProfiler.collectGarbage')
    return (await cdp.send('Runtime.getHeapUsage')).usedSize
  }
  const toggle = pane.getByRole('button', { name: /callout: Folded title$/ })
  const small = async () => {
    await page.getByRole('tab', { name: /folds/ }).first().click()
    await pane.getByText('After paragraph.', { exact: true }).waitFor()
  }
  /** Opens the large note, unfolds its callout and goes back to the small one. */
  const remember = async () => {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      })
    }, large)
    await pressShortcut(app, `${mod}+o`)
    await toggle.waitFor({ timeout: 120000 })
    await toggle.click()
    await pane.getByText('hidden body.', { exact: true }).waitFor()
    await small()
    return heap()
  }
  const closed = async (count) => {
    await waitForAsync(
      page,
      (expected) =>
        document.querySelectorAll('[role="tab"]').length === expected,
      count - 1,
    )
    await pane.getByText('After paragraph.', { exact: true }).waitFor()
    return heap()
  }
  const released = (kept, after, how) =>
    assert.ok(
      kept - after > size / 2,
      `closing the ${size / 1048576} MiB note ${how} released ${((kept - after) / 1048576).toFixed(1)} MiB`,
    )
  const before = await heap()
  // With the large note's view gone, its text stays with its folds.
  const kept = await remember()
  assert.ok(kept - before > size, 'the remembered text is in memory')
  let count = await page.getByRole('tab').count()
  await page.getByRole('button', { name: /^Close large/ }).click()
  released(kept, await closed(count), 'from the background')
  // Closing the tab while its view shows, after its folds came back.
  const again = await remember()
  await page.getByRole('tab', { name: /large/ }).first().click()
  await toggle.waitFor({ timeout: 120000 })
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true')
  count = await page.getByRole('tab').count()
  await clickMenu(app, 'Close tab')
  released(again, await closed(count), 'while shown')
})
