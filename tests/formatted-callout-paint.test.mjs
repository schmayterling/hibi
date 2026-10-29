import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { selectFormattedEngine } from './formatted-engine.mjs'
import { pressShortcut } from './keyboard.mjs'

// Callouts and quotes holding tables and code between empty `>` lines, as in a course note.
const note = `# Callouts

> [!example] Practice translations
>
> | # | English | Formula |
> |---|---|---|
> | 1 | He is clever and diligent. | $c \\land d$ |
>
> **Extra truth tables.** Exclusive or has exactly one true input:
>
> | $p$ | $q$ | $p \\oplus q$ |
> |---|---|---|
> | 0 | 1 | 1 |
>
> Both idempotence truth tables have the same column as $p$:
>
> | $p$ | $p \\land p$ | $p \\lor p$ |
> |---|---|---|
> | 1 | 1 | 1 |

> [!tip] Code
> Before:
>
> \`\`\`js
> let a = 1
> \`\`\`
>
> after

> [!note] Spotting an invalid form
> \`\`\`
> All bunnies are mammals.
> \`\`\`
> To make the counterexample precise, let there be one non-fierce bunny.

> [!important] Other blocks
>
> - first item
>   - nested item
>
> $$
> x^2 + y^2 = z^2
> $$
>
> > Nested quote
> >
> > - nested bullet
>
> after other blocks

> plain quote
>
> | a | b |
> |---|---|
> | 1 | 2 |
>
> after the table
`

/** Opens the note in one engine in a tall window, so every line is drawn, and measures it. */
async function measure(engine, measureView) {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-callout-paint-'))
  const file = join(folder, 'notes', 'callouts.md')
  await mkdir(join(folder, 'notes'))
  await mkdir(join(folder, 'profile'))
  await writeFile(
    join(folder, 'profile', 'addons.json'),
    JSON.stringify({ math: true }),
  )
  await writeFile(file, note)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  try {
    const page = await app.firstWindow()
    page.setDefaultTimeout(20000)
    await selectFormattedEngine(app, page, engine)
    await app.evaluate(({ BrowserWindow, dialog }, path) => {
      BrowserWindow.getAllWindows()[0].setContentSize(1000, 2400)
      // Quitting answers an unsaved-changes prompt, should the editor normalize the note.
      dialog.showMessageBox = async () => ({ response: 1 })
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      })
    }, file)
    await pressShortcut(
      app,
      process.platform === 'darwin' ? 'Meta+o' : 'Control+o',
    )
    await page
      .locator('.rich-pane', { hasText: 'after the table' })
      .locator(engine === 'tiptap' ? 'table' : '.hibi-lp-table')
      .nth(3)
      .waitFor()
    await page.locator('.rich-pane [data-type="block-math"] .katex').waitFor()
    assert.equal(
      await page
        .locator(
          engine === 'tiptap' ? '.github-alert pre' : '.hibi-lp-codenest',
        )
        .count(),
      2,
      'both fenced code blocks are rendered',
    )
    assert.equal(
      await page
        .locator(
          engine === 'tiptap'
            ? '.github-alert li'
            : '.hibi-lp-alert.hibi-lp-list-item',
        )
        .count(),
      3,
      'lists and nested lists are rendered inside the callout',
    )
    return await page.evaluate(measureView)
  } finally {
    await app.close()
    await rm(folder, { recursive: true, force: true })
  }
}

test('callout and quote bars and tints run unbroken past empty lines, tables and code, as in the rich editor', {
  timeout: 120000,
}, async () => {
  const rich = await measure('tiptap', () =>
    [...document.querySelectorAll('.rich-pane .github-alert')].map((alert) => {
      const box = alert.getBoundingClientRect()
      const tables = alert.querySelectorAll('table')
      const last = tables[tables.length - 1]?.getBoundingClientRect()
      return { below: last ? box.bottom - last.bottom : null }
    }),
  )
  const formatted = await measure('codemirror', () => {
    const content = document.querySelector('.rich-pane .cm-content')
    // Each run of painted blocks: lines and boxes around code, top level in the content.
    const runs = []
    let run = null
    for (const element of content.children) {
      const rect = element.getBoundingClientRect()
      if (!rect.height) continue
      const painted =
        element.matches('.cm-line.hibi-lp-painted, .hibi-lp-codenest') &&
        element
      if (!painted) {
        run = null
        continue
      }
      const before = getComputedStyle(element, '::before')
      // The paint lies in the indentation left of the line, unless the line clips it.
      let left = rect.left + Number.parseFloat(before.left)
      if (getComputedStyle(element).overflowX !== 'visible')
        left = Math.max(left, rect.left)
      const block = {
        kind: element.matches('.hibi-lp-alert') ? 'alert' : 'quote',
        text: element.textContent.slice(0, 24),
        top: rect.top,
        bottom: rect.bottom,
        left,
        right: rect.right,
        image: before.backgroundImage,
      }
      if (!run || run.kind !== block.kind) {
        run = { kind: block.kind, blocks: [], tables: [] }
        runs.push(run)
      }
      run.blocks.push(block)
      for (const table of element.querySelectorAll('.hibi-lp-table')) {
        const box = table.getBoundingClientRect()
        run.tables.push({
          top: box.top,
          bottom: box.bottom,
          left: box.left,
          right: box.right,
        })
      }
    }
    return runs
  })

  assert.deepEqual(
    formatted.map((run) => [run.kind, run.tables.length]),
    [
      ['alert', 3],
      ['alert', 0],
      ['alert', 0],
      ['alert', 0],
      ['quote', 1],
    ],
    'each callout and the quote is one run of painted blocks',
  )
  for (const [index, run] of formatted.entries()) {
    const [first] = run.blocks
    for (const [at, block] of run.blocks.entries()) {
      const where = `${run.kind} ${index}, block ${at} (${JSON.stringify(block.text)})`
      assert.notEqual(block.image, 'none', `${where} is painted`)
      // The bar is one column: every block's paint starts at the container's left edge.
      assert.ok(
        Math.abs(block.left - first.left) < 0.5,
        `${where} paints from ${block.left}, not the bar at ${first.left}`,
      )
      if (at)
        assert.ok(
          Math.abs(block.top - run.blocks[at - 1].bottom) < 0.5,
          `${where} starts at ${block.top}, below the block above at ${run.blocks[at - 1].bottom}`,
        )
    }
    const bottom = run.blocks[run.blocks.length - 1].bottom
    for (const table of run.tables)
      assert.ok(
        table.left > first.left &&
          table.right <= first.right + 0.5 &&
          table.top >= first.top &&
          table.bottom <= bottom,
        `${run.kind} ${index}: table ${JSON.stringify(table)} lies inside the painted area`,
      )
  }
  // A callout that ends in a table keeps the rich editor's space below it.
  const [practice] = formatted
  const last = practice.tables[practice.tables.length - 1]
  assert.equal(rich[0].below, 32)
  assert.ok(
    Math.abs(
      practice.blocks[practice.blocks.length - 1].bottom -
        last.bottom -
        rich[0].below,
    ) < 0.5,
    `space below the callout's last table: ${practice.blocks[practice.blocks.length - 1].bottom - last.bottom}`,
  )
})
