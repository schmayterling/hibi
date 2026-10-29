import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import {
  after,
  before,
  electron,
  waitForAsync,
  waitForDocumentEditor,
} from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'

let app, page, profile
const errors = []
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const menu = () => page.locator('.slash-menu:popover-open [role="listbox"]')
const editor = () => page.locator('.rich-pane .cm-content')
const read = () =>
  page.evaluate(async () => (await window.hibi.getDocument()).markdown)
const matches = async (source) => {
  try {
    await waitForAsync(
      page,
      async (source) => (await window.hibi.getDocument()).markdown === source,
      source,
    )
  } catch (error) {
    console.log(
      JSON.stringify({ expected: source, actual: await read(), errors }),
    )
    throw error
  }
}
async function set(source, head = source.length) {
  await page.waitForFunction(
    () =>
      document
        .querySelector('.rich-pane .cm-content')
        ?.getAttribute('contenteditable') === 'true',
  )
  await editor().click()
  await page.evaluate(
    ({ source, head }) => {
      const view = document.querySelector('.rich-pane .cm-content').cmTile.root
        .view
      view.focus()
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: source },
        selection: { anchor: head },
        userEvent: 'input.addon',
      })
    },
    { source, head },
  )
  await matches(source)
  await editor().focus()
  await page.evaluate((head) => {
    const view = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    view.dispatch({ selection: { anchor: Math.max(0, head - 1) } })
    view.dispatch({ selection: { anchor: head } })
  }, head)
}

before(
  async () => {
    profile = await mkdtemp(join(tmpdir(), 'hibi-formatted-slash-'))
    app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${profile}`],
    })
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    page = await app.firstWindow()
    page.setDefaultTimeout(5000)
    page.on('pageerror', (error) => errors.push(error.message))
    await waitForDocumentEditor(app, page)
    await page.evaluate(() =>
      localStorage.setItem('hibi:formatted-engine', 'codemirror'),
    )
    await page.reload()
    await waitForDocumentEditor(app, page)
    await editor().waitFor()
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  },
  { timeout: 90000 },
)
after(
  async () => {
    await app?.close()
    if (profile) await rm(profile, { recursive: true, force: true })
  },
  { timeout: 30000 },
)

test('formatted slash recipes preserve source, caret and undo', {
  timeout: 60000,
}, async () => {
  for (const [source, head, expected, caret] of [
    ['/h2', 3, '## ', 3],
    ['/h6', 3, '###### ', 7],
    ['/quote', 6, '> ', 2],
    ['/code', 5, '```\n\n```', 4],
    ['/bold', 5, '****', 2],
    ['/text', 5, '', 0],
    ['> /h2', 5, '> ## ', 5],
    ['- /h2', 5, '- ## ', 5],
    ['### /h2', 7, '## ', 3],
    ['/h2\n---', 3, '## ', 3],
  ]) {
    await set(source, head)
    await menu().waitFor()
    await editor().press('Enter')
    await matches(expected)
    assert.equal(
      await page.evaluate(
        () =>
          document.querySelector('.rich-pane .cm-content').cmTile.root.view
            .state.selection.main.head,
      ),
      caret,
      source,
    )
    await editor().press(`${mod}+z`)
    await matches(source)
  }
})

test('formatted slash excludes code, metadata, paths and paragraph continuations and respects dismissal', {
  timeout: 30000,
}, async () => {
  for (const [source, head] of [
    ['```\n/h2\n```', 7],
    ['`/h2`', 4],
    ['<div>\n/h2\n</div>', 9],
    ['one\n/h2', 7],
    ['/tmp/file', 9],
    ['---\ntitle: note\n/h2\n---', 18],
  ]) {
    await set(source, head)
    await page.waitForFunction(
      () => !document.querySelector('.slash-menu:popover-open'),
    )
    assert.equal(await read(), source)
  }
  await set('/h2')
  await menu().waitFor()
  await editor().press('Escape')
  await menu().waitFor({ state: 'hidden' })
  await editor().pressSequentially('literal')
  assert.equal(await menu().count(), 0)
  assert.equal(await read(), '/h2literal')
})

test('dismissing a closed slash menu leaves the editor untouched', {
  timeout: 30000,
}, async () => {
  const names = [
    'aria-controls',
    'aria-activedescendant',
    'aria-autocomplete',
    'aria-haspopup',
  ]
  const attributes = () =>
    editor().evaluate(
      (element, names) => names.map((name) => element.getAttribute(name)),
      names,
    )
  await set('plain words')
  const before = await attributes()
  // Caret moves, a press elsewhere and a blur dismiss the closed menu,
  // which writes nothing: a hidden editor's DOM stays as it is.
  const writes = await editor().evaluate(async (element, names) => {
    const writes = []
    for (const method of ['setAttribute', 'removeAttribute'])
      element[method] = (name, ...rest) => {
        if (names.includes(name)) writes.push(`${method} ${name}`)
        return Element.prototype[method].call(element, name, ...rest)
      }
    const view = element.cmTile.root.view
    view.dispatch({ selection: { anchor: 0 } })
    view.dispatch({ selection: { anchor: view.state.doc.length } })
    document.body.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true }),
    )
    element.dispatchEvent(new FocusEvent('blur'))
    await new Promise(requestAnimationFrame)
    await new Promise(requestAnimationFrame)
    delete element.setAttribute
    delete element.removeAttribute
    return writes
  }, names)
  assert.deepEqual(writes, [])
  // An open menu still gives the editor its attributes back.
  await set('/h2')
  await menu().waitFor()
  await editor().press('Escape')
  await menu().waitFor({ state: 'hidden' })
  assert.deepEqual(await attributes(), before)
})

test('formatted slash offers transform commands and preserves crlf outside its edit', {
  timeout: 30000,
}, async () => {
  await set('/frontmatter')
  await menu().waitFor()
  await editor().press('Enter')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.startsWith('---\n'),
  )
  await editor().press(`${mod}+z`)
  await matches('/frontmatter')
  const source = '---\r\ntitle: exact\r\n---\r\n\r\n/h2'
  const path = join(profile, 'crlf.md')
  await writeFile(path, source)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, path)
  await pressShortcut(app, `${mod}+o`)
  await matches(source)
  await editor().waitFor()
  await page.evaluate(() => {
    const view = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    view.focus()
    view.dispatch({ selection: { anchor: view.state.doc.length } })
  })
  await editor().press('ArrowLeft')
  await editor().press('ArrowRight')
  await menu().waitFor()
  await editor().press('Enter')
  await matches(source.replace('/h2', '## '))
  await editor().press(`${mod}+z`)
  await matches(source)
})

test('formatted slash follows syntax settings and accepts Tab', {
  timeout: 30000,
}, async () => {
  const path = join(profile, 'syntax.md')
  await writeFile(path, '/h2')
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, path)
  await pressShortcut(app, `${mod}+o`)
  await matches('/h2')
  for (const enabled of [false, true]) {
    await clickMenu(app, 'Settings')
    await page.getByRole('tab', { name: /^syntax$/i, exact: true }).click()
    await page
      .getByRole('checkbox', { name: /^heading 2$/i, exact: true })
      .setChecked(enabled)
    await page.getByRole('button', { name: 'Back to app', exact: true }).click()
    await set('/h2')
    await menu().waitFor()
    assert.equal(
      await menu()
        .getByRole('option', { name: /^heading 2/i })
        .count(),
      Number(enabled),
    )
    if (!enabled) await editor().press('Escape')
  }
  await editor().press('Tab')
  await matches('## ')
  await editor().press(`${mod}+z`)
  await matches('/h2')
})

test('disabling slash removes its formatted menu and re-enabling preserves the document', {
  timeout: 30000,
}, async () => {
  const source = await read()
  for (const enabled of [false, true]) {
    await clickMenu(app, 'Settings')
    await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
    await page.locator('#addon-slash-commands').click()
    await page.waitForFunction(
      (enabled) =>
        document.querySelector('#addon-slash-commands').checked === enabled,
      enabled,
    )
    await page.getByRole('button', { name: 'Back to app', exact: true }).click()
    assert.equal(await read(), source)
    if (!enabled) assert.equal(await page.locator('.slash-menu').count(), 0)
  }
  await editor().click()
  await editor().press('ArrowLeft')
  await editor().press('ArrowRight')
  await menu().waitFor()
  assert.deepEqual(errors, [])
})

test('replacing a focused table preserves selection with slash disabled', {
  timeout: 30000,
}, async () => {
  const start = errors.length
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  await page.locator('#addon-slash-commands').click()
  await page.waitForFunction(
    () => !document.querySelector('#addon-slash-commands').checked,
  )
  await page.getByRole('button', { name: 'Back to app', exact: true }).click()
  assert.equal(await page.locator('.slash-menu').count(), 0)
  for (const [source, head] of [
    ['/h2', 3],
    ['q  r', 1],
  ]) {
    await set('| a | b |\n| - | - |\n| beta | end |\n\nafter')
    await page.locator('.hibi-lp-table td', { hasText: 'beta' }).click()
    await page.locator('.hibi-lp-cell-editor .cm-content').waitFor()
    await page.evaluate(
      ({ source, head }) => {
        const view = document.querySelector('.rich-pane .cm-content').cmTile
          .root.view
        view.focus()
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: source },
          selection: { anchor: head },
          userEvent: 'input.addon',
        })
      },
      { source, head },
    )
    await matches(source)
    await page.evaluate(() => new Promise(requestAnimationFrame))
    assert.deepEqual(
      await page.evaluate(() => {
        const view = document.querySelector('.rich-pane .cm-content').cmTile
          .root.view
        const { anchor, head } = view.state.selection.main
        return [
          anchor,
          head,
          document.querySelector('.hibi-lp-cell-editor') !== null,
        ]
      }),
      [head, head, false],
    )
  }
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  await page.locator('#addon-slash-commands').click()
  await page.waitForFunction(
    () => document.querySelector('#addon-slash-commands').checked,
  )
  await page.getByRole('button', { name: 'Back to app', exact: true }).click()
  assert.deepEqual(errors.slice(start), [])
})

test('formatted slash in a table cell offers inline commands and runs them in the cell', {
  timeout: 60000,
}, async () => {
  const table = '| a | b |\n| - | - |\n| beta | end |\n\nafter'
  const cell = () => page.locator('.hibi-lp-cell-editor .cm-content')
  const cellHead = () =>
    page.evaluate(
      () =>
        document.querySelector('.hibi-lp-cell-editor .cm-content').cmTile.root
          .view.state.selection.main.head,
    )
  /** Type `text` at the start of the cell `beta`, after its padding. */
  const query = async (text) => {
    // Escape closes the menu, then leaves the table for the formatted view.
    if (await menu().count()) await cell().press('Escape')
    if (await cell().count()) await cell().press('Escape')
    await cell().waitFor({ state: 'detached' })
    await set(table)
    await page.locator('.hibi-lp-table td', { hasText: 'beta' }).click()
    await cell().waitFor()
    await page.evaluate(() =>
      document
        .querySelector('.hibi-lp-cell-editor .cm-content')
        .cmTile.root.view.dispatch({ selection: { anchor: 1 } }),
    )
    await cell().pressSequentially(text)
    await matches(table.replace('beta', `${text}beta`))
    await menu().waitFor()
  }
  // Block commands have no place in a cell.
  await query('/')
  const options = await menu().getByRole('option').allTextContents()
  for (const inline of ['Text', 'Bold', 'Italic', 'Inline code', 'Frontmatter'])
    assert.ok(
      options.some((option) => option.startsWith(inline)),
      inline,
    )
  for (const block of [
    'Heading',
    'Code blocks',
    'Quotes',
    'Bullet lists',
    'Numbered lists',
    'Dividers',
    'Tables',
  ])
    assert.ok(!options.some((option) => option.startsWith(block)), block)
  // Escape closes the menu and keeps editing the cell.
  await cell().press('Escape')
  await menu().waitFor({ state: 'hidden' })
  await cell().pressSequentially('x')
  await matches(table.replace('beta', '/xbeta'))
  assert.equal(await menu().count(), 0)

  // An inline command replaces the query in the cell, with the caret inside
  // its markers, and undo restores the query.
  await query('/bold')
  await cell().press('Enter')
  await matches(table.replace('beta', '****beta'))
  assert.equal(await cellHead(), 3)
  await cell().press(`${mod}+z`)
  await matches(table.replace('beta', '/boldbeta'))
  await menu().waitFor()

  // Document commands remove the query from the cell.
  await query('/frontmatter')
  await cell().press('Enter')
  await waitForAsync(
    page,
    async (table) => {
      const source = (await window.hibi.getDocument()).markdown
      return source.startsWith('---\n') && source.endsWith(`\n${table}`)
    },
    table,
  )
  await pressShortcut(app, `${mod}+z`)
  await matches(table.replace('beta', '/frontmatterbeta'))
  await menu().waitFor()
  assert.deepEqual(errors, [])
})

test('formatted slash menu stays inside a small window near its bottom edge', {
  timeout: 30000,
}, async () => {
  // The table cell test can leave its cell editor and menu open.
  const cell = page.locator('.hibi-lp-cell-editor .cm-content')
  if (await menu().count()) await cell.press('Escape')
  if (await cell.count()) await cell.press('Escape')
  await cell.waitFor({ state: 'detached' })
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(720, 520),
  )
  await page.waitForFunction(() => innerWidth === 720 && innerHeight === 520)
  const source = `${'paragraph\n\n'.repeat(24)}/`
  await set(source, source.length - 1)
  // Bring the query's line to the bottom of the pane before the menu opens.
  await page.evaluate(
    (head) =>
      new Promise((resolve) => {
        const view = document.querySelector('.rich-pane .cm-content').cmTile
          .root.view
        view.dispatch({ selection: { anchor: head }, scrollIntoView: true })
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      }),
    source.length - 1,
  )
  await page.evaluate((head) => {
    const view = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    view.dispatch({ selection: { anchor: head } })
  }, source.length)
  await menu().waitFor()
  const bounds = await page
    .locator('.slash-menu:popover-open')
    .evaluate((element) => {
      const rect = element.getBoundingClientRect()
      const caret = document
        .querySelector('.rich-pane .cm-content')
        .cmTile.root.view.coordsAtPos(
          document.querySelector('.rich-pane .cm-content').cmTile.root.view
            .state.selection.main.head,
        )
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: innerWidth,
        height: innerHeight,
        caret: caret && { top: caret.top, bottom: caret.bottom },
      }
    })
  // The query sits low enough that a menu below it would leave the window.
  assert.ok(bounds.caret, JSON.stringify(bounds))
  assert.ok(
    bounds.caret.bottom + (bounds.bottom - bounds.top) > bounds.height,
    JSON.stringify(bounds),
  )
  assert.ok(
    bounds.left >= 0 && bounds.right <= bounds.width,
    JSON.stringify(bounds),
  )
  assert.ok(
    bounds.top >= 0 && bounds.bottom <= bounds.height,
    JSON.stringify(bounds),
  )
  await editor().press('Escape')
  await menu().waitFor({ state: 'hidden' })
  assert.equal(await read(), source)
})
