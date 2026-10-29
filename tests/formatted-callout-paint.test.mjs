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

> [!note] Nested last
> Outer text.
>
> > [!tip] Inner last
> > Inner text.

> [!tip] Code last
> Before code.
>
> \`\`\`js
> let last = 1
> \`\`\`

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
      3,
      'the fenced code blocks are rendered',
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
      const outer = alert.parentElement
        .closest('.github-alert')
        ?.getBoundingClientRect()
      const code = alert
        .querySelector(':scope > .github-alert-body > pre:last-child')
        ?.getBoundingClientRect()
      return {
        title: alert.querySelector('.github-alert-title').textContent,
        bar: getComputedStyle(alert).borderLeftColor,
        below: last ? box.bottom - last.bottom : null,
        // Where a nested callout's box ends inside its parent's.
        inset: outer && {
          right: outer.right - box.right,
          bottom: outer.bottom - box.bottom,
        },
        code: code && { height: code.height, below: box.bottom - code.bottom },
      }
    }),
  )
  const formatted = await measure('codemirror', () => {
    const content = document.querySelector('.rich-pane .cm-content')
    // Lengths of the paint, which can be relative to the box it paints.
    const host = document.createElement('div')
    const probe = host.appendChild(document.createElement('div'))
    host.style.cssText = 'position: absolute; visibility: hidden'
    document.body.append(host)
    const px = (length, size) => {
      host.style.width = `${size}px`
      probe.style.width = length
      return probe.getBoundingClientRect().width
    }
    /** Splits a computed list at separators outside parentheses. */
    const split = (value, separator) => {
      const parts = []
      let depth = 0,
        start = 0
      for (let at = 0; at < value.length; at++)
        if (value[at] === '(') depth++
        else if (value[at] === ')') depth--
        else if (!depth && value[at] === separator) {
          parts.push(value.slice(start, at).trim())
          start = at + 1
        }
      return [...parts, value.slice(start).trim()].filter(Boolean)
    }
    /** The box of each paint layer: a container's bar or tint. */
    const layers = (rect, before) => {
      const left = rect.left + Number.parseFloat(before.left)
      const positions = split(before.backgroundPosition, ',')
      return split(before.backgroundSize, ',').map((size, index) => {
        const [width, height] = split(size, ' ')
        const [x, y] = split(positions[index], ' ')
        const from = left + px(x, rect.right - left),
          top = rect.top + px(y, rect.height)
        return {
          left: from,
          top,
          right: from + px(width, rect.right - left),
          bottom: top + px(height, rect.height),
        }
      })
    }
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
        layers: layers(rect, before),
        // Each layer's color: the first stop of its gradient.
        colors: split(before.backgroundImage, ',').map(
          (layer) =>
            split(
              layer.slice(layer.indexOf('(') + 1, layer.lastIndexOf(')')),
              ',',
            )[0],
        ),
      }
      const code = element
        .querySelector(':scope > .hibi-lp-codescroll')
        ?.getBoundingClientRect()
      if (code)
        block.code = { height: code.height, below: rect.bottom - code.bottom }
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
    host.remove()
    return runs
  })

  assert.deepEqual(
    formatted.map((run) => [run.kind, run.tables.length]),
    [
      ['alert', 3],
      ['alert', 0],
      ['alert', 0],
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
  // A nested callout that ends its parent ends inside the parent's padding:
  // its bar and tint stop short of the parent's right and bottom edges.
  const inner = rich.find((alert) => alert.title === 'Inner last')
  assert.deepEqual(inner.inset, { right: 16, bottom: 12 })
  const nested = formatted[4].blocks.filter(
    (block) => block.layers.length === 4,
  )
  assert.deepEqual(
    nested.map((block) => block.text),
    ['Inner last', 'Inner text.'],
  )
  // Each callout keeps its own color, the outer one beside the inner too.
  const outerBar = rich.find((alert) => alert.title === 'Nested last').bar
  assert.notEqual(outerBar, inner.bar)
  for (const { text, colors } of nested)
    assert.deepEqual(
      [colors[0], colors[2]],
      [outerBar, inner.bar],
      `${text}: bar colors`,
    )
  for (const [at, { text, layers }] of nested.entries()) {
    const [, outer, bar, tint] = layers
    const bottom = at === nested.length - 1 ? inner.inset.bottom : 0
    assert.ok(
      Math.abs(outer.right - tint.right - inner.inset.right) < 0.5,
      `${text}: the inner tint ends ${outer.right - tint.right}px left of the outer one`,
    )
    for (const [name, layer] of [
      ['bar', bar],
      ['tint', tint],
    ])
      assert.ok(
        Math.abs(outer.bottom - layer.bottom - bottom) < 0.5,
        `${text}: the inner ${name} ends ${outer.bottom - layer.bottom}px above the outer tint`,
      )
  }
  // A callout that ends in code keeps its padding below the code's box.
  const code = rich.find((alert) => alert.title === 'Code last').code
  assert.deepEqual(code, { height: 60, below: 12 })
  const box = formatted[5].blocks.at(-1)
  assert.equal(box.text, 'let last = 1')
  assert.ok(
    Math.abs(box.code.height - code.height) < 0.5 &&
      Math.abs(box.code.below - code.below) < 0.5,
    `code box ${JSON.stringify(box.code)} in the callout's paint`,
  )
})
