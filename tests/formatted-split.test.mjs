import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

async function open(t, text) {
  const root = await mkdtemp(join(tmpdir(), 'hibi-formatted-split-'))
  const file = join(root, 'note.md')
  await writeFile(file, text)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  const page = await app.firstWindow()
  await waitForDocumentEditor(app, page)
  await page.evaluate(() => {
    localStorage.setItem(
      'cursor-settings',
      JSON.stringify({ style: 'underline', speed: 'slow', animation: 'blink' }),
    )
  })
  await page.reload()
  await waitForDocumentEditor(app, page)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await pressShortcut(app, `${mod}+o`)
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    text,
  )
  await page
    .getByRole('button', { name: /^side-by-side$/i, exact: true })
    .click()
  await page.locator('.mode-side-by-side[data-source-ready="true"]').waitFor()
  await frames(page)
  return { app, page, file }
}

async function frames(page, count = 5) {
  await page.evaluate(async (count) => {
    for (let i = 0; i < count; i++) await new Promise(requestAnimationFrame)
  }, count)
}

async function select(page, pane, anchor, head = anchor) {
  await page.evaluate(
    ({ pane, anchor, head }) => {
      const view = document.querySelector(`.${pane}-pane .cm-content`).cmTile
        .root.view
      view.focus()
      view.dispatch({ selection: { anchor, head }, scrollIntoView: true })
    },
    { pane, anchor, head },
  )
}

async function mirrored(page, pane) {
  await waitForAsync(
    page,
    ({ pane, other }) => {
      const active = document.querySelector(`.${pane}-pane .cm-content`)
      const view = active.cmTile.root.view
      const target = document.querySelector(`.${other}-pane .cm-content`).cmTile
        .root.view
      const caret = target.coordsAtPos(view.state.selection.main.head)
      const mirror = document
        .querySelector(`.${other}-pane .mirror-cursor`)
        ?.getBoundingClientRect()
      return (
        document.activeElement === active &&
        caret &&
        mirror?.height > 0 &&
        Math.abs(caret.left - mirror.left) < 2 &&
        Math.abs(caret.top - mirror.top) < 2 &&
        Math.abs(caret.bottom - caret.top - mirror.height) < 2
      )
    },
    { pane, other: pane === 'rich' ? 'source' : 'rich' },
  )
}

async function source(page, text) {
  await waitForAsync(
    page,
    async (text) => (await window.hibi.getDocument()).markdown === text,
    text,
  )
}

test('both formatted split panes edit and undo one source while preserving bom and crlf', {
  timeout: 90000,
}, async (t) => {
  const text =
    '\uFEFF---\r\ntitle: shared\r\n---\r\n\r\n# Shared\r\n\r\nalpha **bold** beta\r\n'
  const normalized = text.replaceAll('\r\n', '\n')
  const { app, page, file } = await open(t, text)
  for (const pane of ['rich', 'source'])
    assert.equal(
      await page
        .locator(`.${pane}-pane .cm-content`)
        .getAttribute('contenteditable'),
      'true',
    )
  await select(page, 'rich', normalized.indexOf('alpha') + 5)
  await page.keyboard.insertText('🌿')
  const first = text.replace('alpha', 'alpha🌿')
  await source(page, first)
  await select(page, 'source', normalized.indexOf('beta') + 2 + 4)
  await page.keyboard.insertText('!')
  const second = first.replace('beta', 'beta!')
  await source(page, second)
  await pressShortcut(app, `${mod}+s`)
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  assert.equal(await readFile(file, 'utf8'), second)
  await pressShortcut(app, `${mod}+z`)
  await source(page, first)
  await select(page, 'rich', normalized.indexOf('alpha') + 5)
  await pressShortcut(app, `${mod}+z`)
  await source(page, text)
  await pressShortcut(app, `${mod}+s`)
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  assert.equal(await readFile(file, 'utf8'), text)
})

test('formatted split mirrors either caret, hides metadata and selections, and keeps cursor settings', {
  timeout: 90000,
}, async (t) => {
  const text =
    '---\ntitle: shared\n---\n\n# Shared\n\nalpha **bold** beta\n\n' +
    'last paragraph with some words\n\n'.repeat(50)
  const { page } = await open(t, text)
  for (const pane of ['rich', 'source']) {
    const other = pane === 'rich' ? 'source' : 'rich'
    const before = await page.evaluate((other) => {
      const range = document.querySelector(`.${other}-pane .cm-content`).cmTile
        .root.view.state.selection.main
      return [range.anchor, range.head]
    }, other)
    await select(page, pane, text.indexOf('alpha') + 3)
    await mirrored(page, pane)
    const after = await page.evaluate((other) => {
      const range = document.querySelector(`.${other}-pane .cm-content`).cmTile
        .root.view.state.selection.main
      return [range.anchor, range.head]
    }, other)
    assert.deepEqual(
      after,
      before,
      'mirroring never changes the other selection',
    )
    assert.equal(
      await page
        .locator(`.${pane}-pane .editor-cursor`)
        .getAttribute('data-style'),
      'underline',
    )
    assert.equal(
      await page
        .locator(`.${pane}-pane .editor-cursor`)
        .getAttribute('data-animation'),
      'blink',
    )
  }
  await select(page, 'source', text.indexOf('alpha'), text.indexOf('beta'))
  await waitForAsync(page, () => !document.querySelector('.mirror-cursor'))
  await select(page, 'source', text.indexOf('title:') + 3)
  await frames(page)
  assert.equal(
    await page.locator('.mirror-cursor').count(),
    0,
    'metadata has no formatted caret',
  )
  await select(page, 'source', text.indexOf('alpha') + 1)
  await page.locator('.rich-pane .mirror-cursor').waitFor()
  await page
    .locator('.source-pane .cm-content')
    .dispatchEvent('compositionstart', { data: '' })
  await frames(page)
  assert.equal(
    await page.locator('.mirror-cursor').count(),
    0,
    'composition hides the mirror',
  )
  await page
    .locator('.source-pane .cm-content')
    .dispatchEvent('compositionend', { data: '' })
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await frames(page)
  assert.equal(await page.locator('.mirror-cursor').count(), 0)
  await source(page, text)
})

test('formatted split mirrors a caret in a table cell either way', {
  timeout: 90000,
}, async (t) => {
  const rows = Array.from(
    { length: 20 },
    (_, row) => `| r${row} | v${row} |`,
  ).join('\n')
  const text = `# Table\n\n| aa | bb |\n| -- | -- |\n${rows}\n\nafter\n`
  const { page } = await open(t, text)
  // The source caret in a cell's text has a formatted caret there.
  await select(page, 'source', text.indexOf('v10 |') + 1)
  await mirrored(page, 'source')
  // The caret of a cell's editor has a source caret in the cell's line.
  await page.locator('.rich-pane tr[data-line="12"] td').nth(1).click()
  await waitForAsync(page, () => {
    const cell = document.activeElement?.closest('.rich-pane td')
    const rich = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    const source = document.querySelector('.source-pane .cm-content').cmTile
      .root.view
    const caret = source.coordsAtPos(rich.state.selection.main.head)
    const mirror = document
      .querySelector('.source-pane .mirror-cursor')
      ?.getBoundingClientRect()
    return (
      !!cell &&
      !!caret &&
      mirror?.height > 0 &&
      Math.abs(caret.left - mirror.left) < 2 &&
      Math.abs(caret.top - mirror.top) < 2
    )
  })
  await source(page, text)
})

test('formatted split links native wheel scrolling in both directions without feedback or source changes', {
  timeout: 90000,
}, async (t) => {
  const text = Array.from(
    { length: 90 },
    (_, i) =>
      `## section ${i}\n\n${'words that wrap differently in each pane. '.repeat(12)}`,
  ).join('\n\n')
  const { page } = await open(t, text)
  await select(page, 'source', 0)
  for (const pane of ['source', 'rich']) {
    const other = pane === 'source' ? 'rich' : 'source'
    const selector =
      pane === 'rich' ? '.rich-pane' : '.source-pane .cm-scroller'
    const leader = page.locator(selector)
    const box = await leader.boundingBox()
    const start = await leader.evaluate((element) => element.scrollTop)
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, 800)
    // The panes are still aligned until the wheel scrolls its pane.
    await page.waitForFunction(
      ([selector, start]) =>
        document.querySelector(selector).scrollTop !== start,
      [selector, start],
    )
    await waitForAsync(
      page,
      ({ pane, other }) => {
        const section = document.querySelector(`.${pane}-pane`)
        const container =
          pane === 'rich' ? section : section.querySelector('.cm-scroller')
        const content = section.querySelector('.cm-content')
        const view = content.cmTile.root.view
        const bounds = container.getBoundingClientRect()
        const at = view.posAtCoords({
          x: content.getBoundingClientRect().left + 8,
          y: bounds.top + bounds.height / 2,
        })
        if (at === null) return false
        const point = view.coordsAtPos(at)
        const target = document
          .querySelector(`.${other}-pane .cm-content`)
          .cmTile.root.view.coordsAtPos(at)
        return (
          target &&
          point &&
          Math.abs(
            (point.top + point.bottom - target.top - target.bottom) / 2,
          ) < 3
        )
      },
      { pane, other },
    )
  }
  const samples = await page.evaluate(async () => {
    const samples = []
    for (let i = 0; i < 10; i++) {
      await new Promise(requestAnimationFrame)
      samples.push([
        document.querySelector('.rich-pane').scrollTop,
        document.querySelector('.source-pane .cm-scroller').scrollTop,
      ])
    }
    return samples
  })
  for (const index of [0, 1]) {
    const positions = samples.map((sample) => sample[index])
    assert.ok(
      Math.max(...positions) - Math.min(...positions) < 2,
      'scroll feedback settles',
    )
  }
  // The source view redraws its unchanged selection when the other pane
  // scrolls it; that report must not hand the focused source pane the lead.
  const echo = await page.evaluate(async () => {
    const rich = document.querySelector('.rich-pane')
    const before = rich.scrollTop
    document.dispatchEvent(new Event('selectionchange'))
    await new Promise(requestAnimationFrame)
    document.querySelector('.source-pane .cm-scroller').scrollTop += 300
    for (let i = 0; i < 5; i++) await new Promise(requestAnimationFrame)
    return { before, after: rich.scrollTop }
  })
  assert.equal(echo.after, echo.before, 'the scrolled pane keeps the lead')
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await frames(page)
  const stopped = await page.evaluate(async () => {
    const source = document.querySelector('.source-pane .cm-scroller')
    const before = source?.scrollTop
    document.querySelector('.rich-pane').scrollTop += 800
    for (let i = 0; i < 5; i++) await new Promise(requestAnimationFrame)
    return { before, after: source?.scrollTop }
  })
  assert.equal(
    stopped.before,
    stopped.after,
    'leaving split stops linked scrolling',
  )
  await source(page, text)
})

// The panes line up positions inside tables too: CodeMirror gives a place
// in a table the table's edges unless the table says where its cells are.
// The source pane leads, with the line at `at` at its middle.
function lead(at) {
  const scroller = document.querySelector('.source-pane .cm-scroller')
  const view = scroller.querySelector('.cm-content').cmTile.root.view
  scroller.dispatchEvent(new WheelEvent('wheel'))
  // The document starts below the scroller's top by the content's padding.
  const block = view.lineBlockAt(at)
  const bounds = scroller.getBoundingClientRect()
  scroller.scrollTop +=
    view.documentTop +
    block.top +
    block.height / 2 -
    (bounds.top + bounds.height / 2)
}

// Whether the formatted pane shows the text of the table row at the source
// pane's middle at the same height as the source line.
function linedUp() {
  const scroller = document.querySelector('.source-pane .cm-scroller')
  const content = scroller.querySelector('.cm-content')
  const view = content.cmTile.root.view
  const bounds = scroller.getBoundingClientRect()
  const at = view.posAtCoords({
    x: content.getBoundingClientRect().left + 8,
    y: bounds.top + bounds.height / 2,
  })
  if (at === null) return false
  const line = view.state.doc.lineAt(at)
  // Rows with or without outer pipes, their first cell maybe typed in.
  const row = /^(?:\| )?r(\d+)Z? \|/.exec(line.text)
  const point = view.coordsAtPos(line.from)
  // The text of the row's first cell, as the source line has it.
  const cell = row
    ? document.querySelector(
        `.rich-pane tr[data-line="${Number(row[1]) + 2}"] td`,
      )
    : null
  const text = cell && document.createRange()
  text?.selectNodeContents(cell.querySelector('p') ?? cell)
  const drawn = text?.getBoundingClientRect()
  return (
    !!point &&
    !!drawn &&
    Math.abs((point.top + point.bottom) / 2 - (drawn.top + drawn.bottom) / 2) <
      6
  )
}

// A line-up check that holds, and keeps holding for the next 10 frames: a
// row can line up by chance while the following pane still moves.
async function staysLinedUp(page, check, arg, label = check.name) {
  await waitForAsync(page, check, arg, { label })
  for (let frame = 0; frame < 10; frame++) {
    await frames(page, 1)
    assert.ok(await page.evaluate(check, arg), label)
  }
}

const table = (count) =>
  `| aa | bb |\n| -- | -- |\n${Array.from(
    { length: count },
    (_, row) => `| r${row} | v${row} |`,
  ).join('\n')}\n\n`

test('formatted split lines up a source line inside a table with its cell', {
  timeout: 90000,
}, async (t) => {
  const lines = 'line\n\n'.repeat(30)
  const text = `${lines}${table(80)}${lines}`
  const { page } = await open(t, text)
  // A row away from the table's middle.
  await page.evaluate(lead, text.indexOf('| r20 |'))
  await staysLinedUp(page, linedUp)
  // A position in each column of the row is in that column's cell.
  const columns = await page.evaluate(
    (positions) => {
      const view = document.querySelector('.rich-pane .cm-content').cmTile.root
        .view
      const cells = document.querySelectorAll(
        '.rich-pane tr[data-line="22"] td',
      )
      return positions.map((at, column) => {
        const point = view.coordsAtPos(at)
        const box = cells[column].getBoundingClientRect()
        return !!point && point.left >= box.left && point.left <= box.right
      })
    },
    [text.indexOf('r20 |') + 1, text.indexOf('v20 |') + 1],
  )
  assert.deepEqual(columns, [true, true])
  await source(page, text)
})

test('formatted split lines up a source line in a row a long table has not drawn', {
  timeout: 90000,
}, async (t) => {
  const lines = 'line\n\n'.repeat(30)
  const text = `${lines}${table(1000)}${lines}`
  const { page } = await open(t, text)
  // The formatted pane draws only the rows near the ones it shows.
  assert.equal(await page.locator('.rich-pane tr[data-line="602"]').count(), 0)
  await page.evaluate(lead, text.indexOf('| r600 |'))
  await staysLinedUp(page, linedUp)
  await source(page, text)
})

// CodeMirror reports a view's focus a moment after it moves, as when the
// split opens with the formatted pane focused. A pane scrolled in that moment
// keeps the lead: the report is of a focus from before the scroll.
test('formatted split keeps the lead of a pane scrolled just after the other pane takes focus', {
  timeout: 90000,
}, async (t) => {
  const lines = 'line\n\n'.repeat(30)
  const text = `${lines}${table(80)}${lines}`
  const { page } = await open(t, text)
  // The formatted pane loses its focus, and CodeMirror reports that.
  const blurred = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const content = document.querySelector('.rich-pane .cm-content')
        if (document.activeElement !== content) return resolve(false)
        content.addEventListener('hibi:source-caret', () => resolve(true), {
          once: true,
        })
        content.blur()
      }),
  )
  assert.ok(blurred, 'the split opens with the formatted pane focused')
  // It takes focus back just before the source pane is scrolled.
  await page.evaluate(
    `document.querySelector('.rich-pane .cm-content').focus();
    (${lead})(${text.indexOf('| r20 |')})`,
  )
  await staysLinedUp(page, linedUp)
  // Moving its caret still gives the formatted pane the lead.
  await page.keyboard.press(`${mod}+Home`)
  await waitForAsync(
    page,
    () => document.querySelector('.source-pane .cm-scroller').scrollTop < 50,
  )
  // So does focus moving to the source pane, for the scroll right after it.
  await page.evaluate((at) => {
    const view = document.querySelector('.source-pane .cm-content').cmTile.root
      .view
    view.focus()
    view.dispatch({
      effects: view.constructor.scrollIntoView(at, { y: 'center' }),
    })
  }, text.indexOf('| r20 |'))
  await staysLinedUp(page, linedUp)
  // Focus leaving the formatted pane, also reported a moment late, leaves
  // the lead with the formatted pane scrolled after it.
  const refocused = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const content = document.querySelector('.rich-pane .cm-content')
        content.addEventListener(
          'hibi:source-caret',
          () => resolve(document.activeElement === content),
          { once: true },
        )
        content.focus()
      }),
  )
  assert.ok(refocused, 'the formatted pane takes focus')
  // Focus moves to the source pane just before the formatted pane's wheel,
  // whose scrolling goes on after the report of that focus leaving.
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const pane = document.querySelector('.rich-pane')
        pane
          .querySelector('.cm-content')
          .addEventListener('hibi:source-caret', resolve, { once: true })
        document.querySelector('.source-pane .cm-content').focus()
        pane.dispatchEvent(new WheelEvent('wheel'))
      }),
  )
  await page.evaluate((at) => {
    const view = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    view.dispatch({
      effects: view.constructor.scrollIntoView(at, { y: 'center' }),
    })
  }, text.indexOf('| r60 |') + 3)
  await staysLinedUp(page, sourceLinedUp, false)
  const middle = await page.evaluate(() => {
    const pane = document.querySelector('.rich-pane')
    const bounds = pane.getBoundingClientRect()
    const y = bounds.top + bounds.height / 2
    return [...pane.querySelectorAll('tr[data-line]')].find((row) => {
      const box = row.getBoundingClientRect()
      return box.top <= y && box.bottom > y
    })?.dataset.line
  })
  assert.equal(middle, '62', 'the scrolled formatted pane keeps the lead')
  await source(page, text)
})

// Rows without outer pipes start with their first cell's text: with that cell
// edited, the source line's start is in the cell editor's text, and the row's
// place still answers for it while the row is out of its place.
for (const pipes of [true, false])
  test(`formatted split lines up a long table's edited row out of its place with its source line${pipes ? '' : ', its first cell edited in rows without outer pipes'}`, {
    timeout: 90000,
  }, async (t) => {
    const lines = 'line\n\n'.repeat(30)
    const rows = pipes ? table(1000) : table(1000).replace(/^\| | \|$/gm, '')
    const text = `${lines}${rows}${lines}`
    // Where row `index`'s line starts.
    const start = (index) =>
      text.search(new RegExp(`^(\\| )?r${index} \\|`, 'm'))
    const { page } = await open(t, text)
    // The formatted pane leads to a row, which it then draws.
    const near = (at) => {
      const pane = document.querySelector('.rich-pane')
      const view = pane.querySelector('.cm-content').cmTile.root.view
      pane.dispatchEvent(new WheelEvent('wheel'))
      view.dispatch({
        effects: view.constructor.scrollIntoView(at, { y: 'center' }),
      })
    }
    await page.evaluate(near, start(600) + 3)
    await page
      .locator('.rich-pane tr[data-line="602"] td')
      .nth(pipes ? 1 : 0)
      .click()
    await page.keyboard.press('End')
    // Hold the new snapshot until scrolling has used the pending row bounds.
    await page.evaluate(() => {
      const table = document.querySelector('.rich-pane .hibi-lp-table')
      const prototype = Object.getPrototypeOf(table.cmTile.widget)
      const update = prototype.updateDOM
      let pending
      window.tableLayoutEvents = 0
      table.addEventListener(
        'hibi:source-layout',
        () => window.tableLayoutEvents++,
      )
      prototype.updateDOM = function (dom, view) {
        if (dom !== table) return update.call(this, dom, view)
        pending = () => update.call(this, dom, view)
        return true
      }
      window.tableLayoutPending = () => !!pending
      window.releaseTableLayout = () => {
        prototype.updateDOM = update
        const height = table.getBoundingClientRect().height
        const observer = new MutationObserver(() => {})
        observer.observe(table, { childList: true, subtree: true })
        pending()
        // Reusing the same ready snapshot needs no second notification.
        pending()
        const mutations = observer.takeRecords().length
        observer.disconnect()
        return {
          mutations,
          height: table.getBoundingClientRect().height - height,
        }
      }
    })
    await page.keyboard.type('Z')
    await waitForAsync(page, () => window.tableLayoutPending())
    // Led to the table's top rows, the window draws them and keeps the edited
    // row mounted after them, out of its place.
    await page.evaluate(near, start(20) + 3)
    await waitForAsync(
      page,
      () =>
        document.querySelector('.rich-pane tr[data-line="602"]')
          ?.previousElementSibling?.dataset.line !== '601',
      undefined,
      { label: 'the edited row out of its place' },
    )
    // The source pane leads straight back to the row's line, as a drag of its
    // scrollbar does, while the cell editor keeps the focus.
    await page.evaluate(lead, start(600))
    await waitForAsync(page, () => {
      const row = document.querySelector('.rich-pane tr[data-line="602"]')
      return row?.previousElementSibling?.dataset.line === '601'
    })
    await frames(page)
    const sourceTop = await page
      .locator('.source-pane .cm-scroller')
      .evaluate((node) => node.scrollTop)
    assert.deepEqual(
      await page.evaluate(() => window.releaseTableLayout()),
      { mutations: 0, height: 0 },
      'the current snapshot arrives without changing the table DOM or height',
    )
    await staysLinedUp(page, linedUp)
    assert.ok(
      Math.abs(
        (await page
          .locator('.source-pane .cm-scroller')
          .evaluate((node) => node.scrollTop)) - sourceTop,
      ) < 1,
      'the source pane keeps control while the table snapshot becomes current',
    )
    assert.equal(await page.evaluate(() => window.tableLayoutEvents), 1)
    assert.ok(
      await page.evaluate(() => {
        const row = document.querySelector('.rich-pane tr[data-line="602"]')
        return (
          row.previousElementSibling?.dataset.line === '601' &&
          row.nextElementSibling?.dataset.line === '603' &&
          row.contains(document.activeElement)
        )
      }),
      'the edited row in its place, its cell editor focused',
    )
    await source(
      page,
      pipes
        ? text.replace('| v600 |', '| v600Z |')
        : text.replace(/^r600 \|/m, 'r600Z |'),
    )
  })

// Whether the source pane shows the line of the formatted table row that
// leads, the row at the formatted pane's middle or the focused cell's, at the
// height of the text of its first cell.
function sourceLinedUp(caret) {
  const pane = document.querySelector('.rich-pane')
  const bounds = pane.getBoundingClientRect()
  const middle = bounds.top + bounds.height / 2
  const row = caret
    ? document.activeElement?.closest('.rich-pane tr[data-line]')
    : [...pane.querySelectorAll('tr[data-line]')].find((row) => {
        const box = row.getBoundingClientRect()
        return box.top <= middle && box.bottom > middle
      })
  if (!row) return false
  const view = document.querySelector('.source-pane .cm-content').cmTile.root
    .view
  const at = view.state.doc
    .toString()
    .indexOf(`| r${Number(row.dataset.line) - 2} |`)
  const point = at < 0 ? null : view.coordsAtPos(at)
  const cell = row.querySelector('td')
  const text = document.createRange()
  text.selectNodeContents(cell.querySelector('p') ?? cell)
  const drawn = text.getBoundingClientRect()
  return (
    !!point &&
    Math.abs((point.top + point.bottom) / 2 - (drawn.top + drawn.bottom) / 2) <
      6
  )
}

test('formatted split lines up a formatted table row with its source line', {
  timeout: 90000,
}, async (t) => {
  const lines = 'line\n\n'.repeat(30)
  const text = `${lines}${table(80)}${lines}`
  const { page } = await open(t, text)
  // The formatted pane leads. It scrolls to the table, which it draws once
  // near, then puts a row away from the table's middle at its middle.
  await page.evaluate((at) => {
    const pane = document.querySelector('.rich-pane')
    const view = pane.querySelector('.cm-content').cmTile.root.view
    pane.dispatchEvent(new WheelEvent('wheel'))
    pane.scrollTop = view.lineBlockAt(at).top
  }, text.indexOf('| aa |'))
  await page
    .locator('.rich-pane tr[data-line="22"]')
    .waitFor({ state: 'attached' })
  await page.evaluate(() => {
    const pane = document.querySelector('.rich-pane')
    pane.dispatchEvent(new WheelEvent('wheel'))
    const row = pane.querySelector('tr[data-line="22"]').getBoundingClientRect()
    const bounds = pane.getBoundingClientRect()
    pane.scrollTop += row.top + row.height / 2 - bounds.top - bounds.height / 2
  })
  await staysLinedUp(
    page,
    sourceLinedUp,
    false,
    "the source line of the row at the formatted pane's middle",
  )
  // In a cell's editor, its caret leads, also away from the pane's middle.
  await page.locator('.rich-pane tr[data-line="60"] td').first().click()
  await page.keyboard.press('End')
  await page.evaluate(() => {
    const pane = document.querySelector('.rich-pane')
    pane.dispatchEvent(new WheelEvent('wheel'))
    const row = pane.querySelector('tr[data-line="60"]').getBoundingClientRect()
    const bounds = pane.getBoundingClientRect()
    pane.scrollTop += row.top - bounds.top - bounds.height / 4
  })
  await staysLinedUp(
    page,
    sourceLinedUp,
    true,
    "the source line of the row of the cell editor's caret",
  )
  // Columns sized narrower than half the content leave its middle beside
  // the table's cells.
  for (const column of await page
    .locator(
      '.rich-pane .hibi-lp-table th .hibi-lp-table-resizer[data-axis="column"]',
    )
    .all()) {
    await column.focus()
    for (let step = 0; step < 12; step++)
      await page.keyboard.press('Shift+ArrowLeft')
  }
  await page.evaluate(() => {
    const pane = document.querySelector('.rich-pane')
    pane.dispatchEvent(new WheelEvent('wheel'))
    const row = pane.querySelector('tr[data-line="40"]').getBoundingClientRect()
    const bounds = pane.getBoundingClientRect()
    pane.scrollTop += row.top + row.height / 2 - bounds.top - bounds.height / 2
  })
  assert.ok(
    await page.evaluate(() => {
      const content = document
        .querySelector('.rich-pane .cm-content')
        .getBoundingClientRect()
      const cells = document
        .querySelector('.rich-pane .hibi-lp-table > table')
        .getBoundingClientRect()
      return cells.right < content.left + content.width / 2
    }),
  )
  await staysLinedUp(
    page,
    sourceLinedUp,
    false,
    'the source line of the row at the middle beside a narrow table',
  )
  await source(page, text)
})

test('large formatted split follows distant carets without whole-text geometry reads and preserves undo', {
  timeout: 120000,
}, async (t) => {
  const unit = `${'ordinary words for a long note. '.repeat(8)}\n\n`
  const size = 2 * 1024 * 1024
  const text = unit.repeat(Math.ceil(size / unit.length)).slice(0, size)
  const { app, page, file } = await open(t, text)
  await page.evaluate(() => {
    window.splitWholeTextReads = 0
    const docs = new Set(
      ['rich', 'source'].map(
        (pane) =>
          document.querySelector(`.${pane}-pane .cm-content`).cmTile.root.view
            .state.doc,
      ),
    )
    const restore = []
    for (const doc of docs) {
      const read = doc.toString
      const slice = doc.sliceString
      doc.toString = function () {
        window.splitWholeTextReads++
        return read.call(this)
      }
      doc.sliceString = function (from, to = this.length, lineSep) {
        if (from === 0 && to === this.length) window.splitWholeTextReads++
        return slice.call(this, from, to, lineSep)
      }
      restore.push(() => {
        doc.toString = read
        doc.sliceString = slice
      })
    }
    window.restoreSplitTextReads = () =>
      restore.forEach((read) => {
        read()
      })
  })
  await select(page, 'source', 0)
  await page.keyboard.press(
    process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End',
  )
  await mirrored(page, 'source')
  await select(page, 'rich', text.length - 20)
  await mirrored(page, 'rich')
  await page.keyboard.press(
    process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End',
  )
  await mirrored(page, 'rich')
  const reads = await page.evaluate(() => {
    window.restoreSplitTextReads()
    return window.splitWholeTextReads
  })
  assert.equal(
    reads,
    0,
    'caret and scroll geometry never materialize a whole CodeMirror document',
  )
  await page.keyboard.insertText('x')
  await waitForAsync(
    page,
    (length) =>
      ['rich', 'source'].every(
        (pane) =>
          document.querySelector(`.${pane}-pane .cm-content`).cmTile.root.view
            .state.doc.length === length,
      ),
    text.length + 1,
  )
  await select(page, 'source', text.length + 1)
  await pressShortcut(app, `${mod}+z`)
  await source(page, text)
  await pressShortcut(app, `${mod}+s`)
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  assert.ok(
    (await readFile(file)).equals(Buffer.from(text)),
    'undo and save preserve the complete source',
  )
  console.log(
    JSON.stringify({ units: text.length, geometryWholeTextReads: reads }),
  )
})
