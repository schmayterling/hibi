import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForAsync } from './electron.mjs'
import { selectFormattedEngine } from './formatted-engine.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'

const note =
  'See [docs](https://old.example "Keep title") here. Bare https://bare.example/path.\n\n| name |\n| --- |\n| [&amp;](https://cell.example) |\n'
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
async function open(t, addons) {
  const root = await mkdtemp(join(tmpdir(), 'hibi-link-controls-'))
  const file = join(root, 'note.md')
  await writeFile(file, note)
  if (addons) {
    await mkdir(join(root, 'profile'))
    await writeFile(
      join(root, 'profile', 'addons.json'),
      JSON.stringify(addons),
    )
  }
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  // The app registers its clipboard handler before its first window; an
  // earlier replacement makes its own registration fail, and with it startup.
  const page = await app.firstWindow()
  await app.evaluate(({ dialog, shell, ipcMain }, file) => {
    ipcMain.removeHandler('clipboard:write-text')
    ipcMain.handle('clipboard:write-text', (_event, value) => {
      globalThis.copiedLink = value
    })
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    globalThis.openedLinks = []
    shell.openExternal = async (url) => {
      globalThis.openedLinks.push(url)
    }
  }, file)
  page.setDefaultTimeout(8000)
  const editor = await selectFormattedEngine(app, page, 'codemirror')
  await clickMenu(app, 'Open…')
  await page.getByRole('link', { name: 'docs', exact: true }).waitFor()
  const panel = page.getByRole('dialog', { name: 'Link actions', exact: true })
  const dialog = page.getByRole('dialog', { name: 'Edit link', exact: true })
  const read = () =>
    page.evaluate(async () => (await window.hibi.getDocument()).markdown)
  return { app, page, editor, panel, dialog, read }
}

/** Put the caret at `anchor`, after replacing the note with `text` if given. */
const place = (editor, anchor, text) =>
  editor.evaluate(
    (element, { anchor, text }) => {
      const view = element.cmTile.root.view
      view.focus()
      view.dispatch({
        ...(text === undefined
          ? {}
          : {
              changes: { from: 0, to: view.state.doc.length, insert: text },
              userEvent: 'input.fixture',
            }),
        selection: { anchor },
      })
    },
    { anchor, text },
  )

/** Let a caret move or keystroke reach the panel: frames and a pause. */
const settle = (page) =>
  page.evaluate(async () => {
    for (let frame = 0; frame < 3; frame++)
      await new Promise(requestAnimationFrame)
    await new Promise((resolve) => setTimeout(resolve, 200))
  })

test('codemirror link hover offers URL, edit, open, copy and remove', {
  timeout: 60000,
}, async (t) => {
  const { app, page, panel, dialog, read } = await open(t)
  const link = page.getByRole('link', { name: 'docs', exact: true })
  // With the caret in the link too, so a press on an action moves no focus.
  await link.click()
  await panel.waitFor()
  await page.screenshot({ path: resolve('.scratch/link-actions.png') })
  assert.match(await panel.innerText(), /https:\/\/old.example/)
  for (const label of ['Edit link', 'Open link', 'Copy link', 'Remove link'])
    await panel.getByRole('button', { name: label, exact: true }).waitFor()
  await panel.getByRole('button', { name: 'Copy link', exact: true }).click()
  assert.equal(
    await app.evaluate(() => globalThis.copiedLink),
    'https://old.example',
  )
  await link.hover()
  await panel.getByRole('button', { name: 'Open link', exact: true }).click()
  assert.deepEqual(await app.evaluate(() => globalThis.openedLinks), [
    'https://old.example/',
  ])
  await link.hover()
  await panel.getByRole('button', { name: 'Edit link', exact: true }).click()
  assert.equal(
    await dialog.getByLabel('Link destination').inputValue(),
    'https://old.example',
  )
  await dialog.getByLabel('Link destination').fill('https://new.example')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  assert.ok((await read()).includes('[docs](https://new.example "Keep title")'))
  await pressShortcut(app, `${mod}+z`)
  await waitForAsync(
    page,
    async (note) => (await window.hibi.getDocument()).markdown === note,
    note,
  )
  await link.hover()
  await panel.getByRole('button', { name: 'Remove link', exact: true }).click()
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.startsWith('See docs here.'),
  )
  await pressShortcut(app, `${mod}+z`)
  await waitForAsync(
    page,
    async (note) => (await window.hibi.getDocument()).markdown === note,
    note,
  )
})

test('codemirror link actions stay up while the pointer crosses to them', {
  timeout: 60000,
}, async (t) => {
  const { page, editor, panel } = await open(t)
  const link = page.getByRole('link', { name: 'docs', exact: true })
  for (const focused of [false, true]) {
    // Unfocused, or with the caret outside links, the panel shows for the
    // hovered link only. Opening the note leaves the caret at its table
    // link's end, which has its own panel.
    await editor.evaluate(
      (element, { focused, anchor }) => {
        const view = element.cmTile.root.view
        if (!focused) return element.ownerDocument.activeElement?.blur()
        view.focus()
        view.dispatch({ selection: { anchor } })
      },
      { focused, anchor: note.indexOf('here') },
    )
    const from = await link.boundingBox()
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await panel.waitFor()
    const to = await panel
      .getByRole('button', { name: 'Copy link', exact: true })
      .boundingBox()
    // Real pointers pass over the text between the link and the panel.
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
      steps: 12,
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(await panel.isVisible(), true, `focused: ${focused}`)
    assert.equal(
      await panel.locator('.hibi-link-destination').textContent(),
      'https://old.example',
    )
    await page.mouse.move(4, 4)
    await panel.waitFor({ state: 'hidden' })
  }
})

test('codemirror removes a detected URL without changing its visible text', {
  timeout: 60000,
}, async (t) => {
  const { app, page, panel, read } = await open(t)
  const link = page.getByRole('link', {
    name: 'https://bare.example/path',
    exact: true,
  })
  await link.hover()
  await panel.getByRole('button', { name: 'Remove link', exact: true }).click()
  await link.waitFor({ state: 'detached' })
  assert.ok((await read()).includes('https\\://bare.example/path'))
  await pressShortcut(app, `${mod}+z`)
  await link.waitFor()
})

test('codemirror caret actions and context edit are keyboard reachable', {
  timeout: 60000,
}, async (t) => {
  const { app, page, panel, dialog } = await open(t)
  // Tab reaches the actions where it does not indent.
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Editor', exact: true }).click()
  await page
    .getByRole('checkbox', { name: 'Tab key indents', exact: true })
    .setChecked(false)
  await page.getByRole('button', { name: /back to app/i }).click()
  const link = page.getByRole('link', { name: 'docs', exact: true })
  await link.click()
  await panel.waitFor()
  await page.keyboard.press('Tab')
  assert.equal(
    await panel
      .getByRole('button', { name: 'Edit link', exact: true })
      .evaluate((button) => button === document.activeElement),
    true,
  )
  await page.keyboard.press('Enter')
  await dialog.waitFor()
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  await link.click({ button: 'right' })
  const menu = page.getByRole('menu', { name: 'Link actions', exact: true })
  await menu
    .getByRole('menuitem', { name: 'Edit link…', exact: true })
    .waitFor()
  await page.keyboard.press('Enter')
  await dialog.waitFor()
  assert.equal(
    await dialog.getByLabel('Link destination').inputValue(),
    'https://old.example',
  )
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  await link.click()
  await page.keyboard.press('Shift+F10')
  await menu.waitFor()
  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'hidden' })
  await page.waitForFunction(() =>
    document.activeElement?.closest('.rich-pane .cm-editor'),
  )
  // Tab past the last action returns to the link, not to the app's controls.
  await link.click()
  await panel.waitFor()
  for (const name of ['Edit link', 'Open link', 'Copy link', 'Remove link']) {
    await page.keyboard.press('Tab')
    assert.equal(
      await page.evaluate(() =>
        document.activeElement?.getAttribute('aria-label'),
      ),
      name,
    )
  }
  await page.keyboard.press('Tab')
  await page.waitForFunction(() =>
    document.activeElement?.closest('.rich-pane .cm-editor'),
  )
  await panel.waitFor({ state: 'hidden' })
  // The menu offers every action, so they stay reachable where Tab indents.
  const choose = async (name) => {
    await page.keyboard.press('Shift+F10')
    const item = menu.getByRole('menuitem', { name, exact: true })
    await item.waitFor()
    while (!(await item.evaluate((item) => item === document.activeElement)))
      await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await menu.waitFor({ state: 'hidden' })
  }
  await choose('Copy link')
  await page.waitForFunction(() =>
    document.activeElement?.closest('.rich-pane .cm-editor'),
  )
  assert.equal(
    await app.evaluate(() => globalThis.copiedLink),
    'https://old.example',
  )
  await choose('Open link')
  await page.waitForFunction(() =>
    document.activeElement?.closest('.rich-pane .cm-editor'),
  )
  assert.deepEqual(await app.evaluate(() => globalThis.openedLinks), [
    'https://old.example/',
  ])
  await choose('Remove link')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.startsWith('See docs here.'),
  )
})

test('codemirror Tab in a link still indents, and Escape then Tab leaves', {
  timeout: 60000,
}, async (t) => {
  const { page, editor, panel } = await open(t)
  const set = (text, anchor) =>
    editor.evaluate(
      (element, { text, anchor }) => {
        const view = element.cmTile.root.view
        view.focus()
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          selection: { anchor },
          userEvent: 'input.fixture',
        })
      },
      { text, anchor },
    )
  const markdown = () =>
    page.evaluate(async () => (await window.hibi.getDocument()).markdown)
  const inEditor = () =>
    page.evaluate(
      () => !!document.activeElement?.closest('.rich-pane .cm-editor'),
    )
  // Tab key indents is on by default; the panel must not take that Tab.
  const paragraph = 'see [docs](https://a.example) end'
  await set(paragraph, paragraph.indexOf('docs') + 2)
  await panel.waitFor()
  await page.keyboard.press('Tab')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('\t'),
  )
  assert.equal(await inEditor(), true)
  const list = '- a\n- [docs](https://a.example)'
  await set(list, list.lastIndexOf('docs') + 2)
  await panel.waitFor()
  await page.keyboard.press('Tab')
  await waitForAsync(page, async () =>
    /\n\s+- \[docs\]/.test((await window.hibi.getDocument()).markdown),
  )
  assert.equal(await inEditor(), true, await markdown())
  // Escape, then Tab, leaves the editor rather than entering the panel.
  await set(paragraph, paragraph.indexOf('docs') + 2)
  await panel.waitFor()
  await page.keyboard.press('Escape')
  await panel.waitFor({ state: 'hidden' })
  await page.keyboard.press('Tab')
  await page.waitForFunction(
    () =>
      !document.activeElement?.closest(
        '.rich-pane .cm-editor, .hibi-link-actions',
      ),
  )
})

test('codemirror link actions stay placed through resize and reference typing', {
  timeout: 60000,
}, async (t) => {
  const { app, page, editor, panel } = await open(t)
  const text = `${'word '.repeat(60)}[docs](https://a.example) and [ref link][r] end\n\n[r]: https://ref.example\n`
  const place = (anchor, insert) =>
    editor.evaluate(
      (element, { anchor, insert }) => {
        const view = element.cmTile.root.view
        view.focus()
        view.dispatch({
          ...(insert === undefined
            ? {}
            : {
                changes: { from: 0, to: view.state.doc.length, insert },
                userEvent: 'input.fixture',
              }),
          selection: { anchor },
        })
      },
      { anchor, insert },
    )
  // The panel sits under the caret's link, inside the window.
  const underLink = () => {
    const link = getSelection()
      ?.anchorNode?.parentElement?.closest('.hibi-lp-link')
      ?.getBoundingClientRect()
    const box = document
      .querySelector('.hibi-link-actions:popover-open')
      ?.getBoundingClientRect()
    if (!link || !box) return false
    const left = Math.max(8, Math.min(link.left, innerWidth - box.width - 8))
    const top = Math.max(
      8,
      Math.min(link.bottom + 6, innerHeight - box.height - 8),
    )
    return Math.abs(box.left - left) < 2 && Math.abs(box.top - top) < 2
  }
  await place(text.indexOf('docs') + 2, text)
  await panel.waitFor()
  await page.waitForFunction(underLink)
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    const [width, height] = window.getSize()
    window.setSize(Math.max(640, width - 320), height)
  })
  await page.waitForFunction(underLink)
  // A reference link resolves its destination later; typing in it must not
  // paint frames without the panel.
  await place(text.indexOf('ref link') + 3)
  const destination = '.hibi-link-actions:popover-open .hibi-link-destination'
  await page.waitForFunction(
    (selector) =>
      document.querySelector(selector)?.textContent === 'https://ref.example',
    destination,
  )
  await page.evaluate(() => {
    window.closedFrames = 0
    const frame = () => {
      if (!document.querySelector('.hibi-link-actions:popover-open'))
        window.closedFrames++
      window.linkFrame = requestAnimationFrame(frame)
    }
    window.linkFrame = requestAnimationFrame(frame)
  })
  await page.keyboard.type('xyz', { delay: 100 })
  await page.waitForFunction(
    (selector) =>
      document.querySelector(selector)?.textContent === 'https://ref.example',
    destination,
  )
  assert.equal(
    await page.evaluate(() => {
      cancelAnimationFrame(window.linkFrame)
      return window.closedFrames
    }),
    0,
  )
})

test('toolbar settings keep the stable link action name', {
  timeout: 30000,
}, async (t) => {
  const { app, page } = await open(t)
  await page.getByRole('link', { name: 'docs', exact: true }).click()
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-toolbar-id="format.link"]')
        ?.getAttribute('aria-label') === 'Edit link',
  )
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^appearance$/i }).click()
  await page.locator('.toolbar-order summary').click()
  const action = page.locator(
    '.toolbar-order [data-toolbar-id="format.link"] button',
  )
  assert.equal(await action.innerText(), 'Link')
  await action.click()
  await page
    .getByRole('combobox', { name: 'Toolbar placement for Link', exact: true })
    .waitFor()
})

test('codemirror entity-only cell link has the same caret actions', {
  timeout: 60000,
}, async (t) => {
  const { page, panel, dialog } = await open(t)
  const link = page.getByRole('link', { name: '&', exact: true })
  await link.click()
  await page
    .locator('.hibi-lp-cell-editor')
    .getByRole('link', { name: '&', exact: true })
    .waitFor()
  await panel.waitFor()
  await panel.getByRole('button', { name: 'Edit link', exact: true }).click()
  assert.equal(
    await dialog.getByLabel('Link destination').inputValue(),
    'https://cell.example',
  )
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
})

test('codemirror Escape keeps link actions hidden until the caret leaves the link', {
  timeout: 60000,
}, async (t) => {
  const { page, editor, panel, read } = await open(t)
  const destination = panel.locator('.hibi-link-destination')
  await page.getByRole('link', { name: 'docs', exact: true }).click()
  await panel.waitFor()
  await page.keyboard.press('Escape')
  await panel.waitFor({ state: 'hidden' })
  // Typing and moving inside the link leave them hidden.
  await page.keyboard.type('x')
  await waitForAsync(
    page,
    async (note) => (await window.hibi.getDocument()).markdown !== note,
    note,
  )
  await settle(page)
  assert.equal(await panel.isVisible(), false, 'after typing')
  await page.keyboard.press('ArrowLeft')
  await settle(page)
  assert.equal(await panel.isVisible(), false, 'after moving')
  assert.match(await read(), /^See \[d\w*x\w*\]\(/)
  const text = await read()
  // Nor does the caret walking on through the destination to the link's end.
  await place(editor, text.indexOf('https://old') + 3)
  await settle(page)
  assert.equal(await panel.isVisible(), false, 'in the destination')
  await place(editor, text.indexOf(')') + 1)
  await settle(page)
  assert.equal(await panel.isVisible(), false, 'at the link end')
  // Back in the link after leaving it, they show again.
  await place(editor, text.indexOf('here'))
  await place(editor, text.indexOf('[d') + 2)
  await panel.waitFor()
  assert.equal(await destination.textContent(), 'https://old.example')
  // Another link shows its own after Escape in this one.
  await page.keyboard.press('Escape')
  await panel.waitFor({ state: 'hidden' })
  await place(editor, text.indexOf('bare.example'))
  await panel.waitFor()
  assert.equal(await destination.textContent(), 'https://bare.example/path')
})

test('codemirror link actions show with the caret at a link end', {
  timeout: 60000,
}, async (t) => {
  const { page, editor, panel } = await open(t)
  const text =
    'See [docs](https://a.example) mid\n\nEnd [tail](https://b.example)\n\nBare https://c.example/path\n\nMid https://d.example/path here\n\nWords only'
  await place(editor, text.length, text)
  const destination = panel.locator('.hibi-link-destination')
  const ends = {
    'mid-line link': text.indexOf(') mid') + 1,
    'line-end link': text.indexOf('\n\nBare'),
    'line-end address': text.indexOf('\n\nMid'),
    'mid-line address': text.indexOf(' here'),
  }
  const shown = {}
  for (const [name, at] of Object.entries(ends)) {
    // From outside any link, so that no shown link carries over.
    await place(editor, text.length)
    await panel.waitFor({ state: 'hidden' })
    await place(editor, at)
    shown[name] = await panel.waitFor({ timeout: 3000 }).then(
      () => destination.textContent(),
      () => null,
    )
  }
  assert.deepEqual(shown, {
    'mid-line link': 'https://a.example',
    'line-end link': 'https://b.example',
    'line-end address': 'https://c.example/path',
    'mid-line address': 'https://d.example/path',
  })
  // A click past the end of the line shows them too, and Shift+F10 opens the link's menu.
  await place(editor, text.length)
  await panel.waitFor({ state: 'hidden' })
  const end = await editor.evaluate(
    (element, at) => element.cmTile.root.view.coordsAtPos(at),
    text.indexOf('\n\nBare'),
  )
  await page.mouse.click(end.right + 40, (end.top + end.bottom) / 2)
  await panel.waitFor()
  assert.equal(await destination.textContent(), 'https://b.example')
  await page.keyboard.press('Shift+F10')
  const menu = page.getByRole('menu', { name: 'Link actions', exact: true })
  await menu
    .getByRole('menuitem', { name: 'Edit link…', exact: true })
    .waitFor()
  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'hidden' })
})

test('codemirror link menu holds the editor actions of addons too', {
  timeout: 60000,
}, async (t) => {
  const { app, page, panel } = await open(t, { dictionary: true })
  // Lookups never reach the services.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('host-network:get-text')
    ipcMain.handle('host-network:get-text', () => ({
      ok: false,
      code: 'http-status',
      status: 404,
    }))
  })
  const link = page.getByRole('link', { name: 'docs', exact: true })
  const menu = page.getByRole('menu', { name: 'Editor actions', exact: true })
  // The link's actions lead; the addon's follow apart from them.
  const items = () =>
    menu
      .getByRole('menuitem')
      .evaluateAll((items) =>
        items.map(
          (item) => `${item.style.marginTop ? '| ' : ''}${item.textContent}`,
        ),
      )
  const expected = [
    'Edit link…',
    'Open link',
    'Copy link',
    'Remove link',
    '| Define word',
    'Find synonyms',
    'Add word to dictionary',
  ]
  await link.click({ button: 'right' })
  await menu
    .getByRole('menuitem', { name: 'Define word', exact: true })
    .waitFor()
  assert.deepEqual(await items(), expected)
  assert.equal(await panel.isVisible(), false)
  await menu.getByRole('menuitem', { name: 'Copy link', exact: true }).click()
  await menu.waitFor({ state: 'hidden' })
  assert.equal(
    await app.evaluate(() => globalThis.copiedLink),
    'https://old.example',
  )
  // Shift+F10 at the caret opens the same menu, whose keys reach every action.
  await link.click()
  await page.keyboard.press('Shift+F10')
  await menu
    .getByRole('menuitem', { name: 'Define word', exact: true })
    .waitFor()
  assert.deepEqual(await items(), expected)
  // The editor keeps its focus and names the selected action to assistive
  // technology, as its active descendant.
  const active = () =>
    page.evaluate(() => {
      const id = document.activeElement?.getAttribute('aria-activedescendant')
      return id ? document.getElementById(id)?.textContent : null
    })
  assert.equal(await active(), 'Edit link…')
  await page.keyboard.press('ArrowDown')
  assert.equal(await active(), 'Open link')
  await page.keyboard.press('Enter')
  await menu.waitFor({ state: 'hidden' })
  assert.equal(await active(), null)
  // Opening a link keeps the app busy for a moment; the editor then has its
  // focus back.
  await page.waitForFunction(() =>
    document.activeElement?.closest('.rich-pane .cm-editor'),
  )
  assert.deepEqual(await app.evaluate(() => globalThis.openedLinks), [
    'https://old.example/',
  ])
  await page.keyboard.press('Shift+F10')
  await menu.getByRole('menuitem', { name: 'Define word', exact: true }).click()
  await page.getByRole('dialog', { name: 'Define “docs”' }).waitFor()
})

test('codemirror read-only link actions open and copy but refuse edits', {
  timeout: 60000,
}, async (t) => {
  const { app, page, editor, panel, dialog, read } = await open(t)
  const link = page.getByRole('link', { name: 'docs', exact: true })
  // The note turns read-only as while an addon it needs reloads.
  const readOnly = (on) =>
    editor.evaluate((element, on) => {
      const view = element.cmTile.root.view
      if (!on) return window.restoreInput()
      const [compartment, access] = [...view.state.config.compartments].find(
        ([, value]) =>
          Array.isArray(value) &&
          value.length === 2 &&
          value.every((part) => part.facet && typeof part.value === 'boolean'),
      )
      window.restoreInput = () =>
        view.dispatch({ effects: compartment.reconfigure(access) })
      view.dispatch({
        effects: compartment.reconfigure(
          access.map((part) => part.facet.of(!part.value)),
        ),
      })
      return view.state.readOnly
    }, on)
  const states = (scope, role, names) =>
    Promise.all(
      names.map(async (name) =>
        (await scope.getByRole(role, { name, exact: true }).isDisabled())
          ? `${name} disabled`
          : name,
      ),
    )
  // An edit begun before the note turned read-only saves nothing.
  await link.click()
  await panel.waitFor()
  await panel.getByRole('button', { name: 'Edit link', exact: true }).click()
  await dialog.waitFor()
  assert.equal(await readOnly(true), true)
  await dialog.getByLabel('Link destination').fill('https://new.example')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await settle(page)
  assert.equal(await read(), note)
  // A shown panel offers only what changes nothing once the note is read-only.
  const buttons = ['Edit link', 'Open link', 'Copy link', 'Remove link']
  await readOnly(false)
  await page.mouse.move(4, 4)
  await panel.waitFor({ state: 'hidden' })
  await link.hover()
  await panel.waitFor()
  assert.deepEqual(await states(panel, 'button', buttons), buttons)
  await readOnly(true)
  const offered = [
    'Edit link disabled',
    'Open link',
    'Copy link',
    'Remove link disabled',
  ]
  assert.deepEqual(await states(panel, 'button', buttons), offered)
  // As does a panel shown while read-only, whose copy still works.
  await page.mouse.move(4, 4)
  await panel.waitFor({ state: 'hidden' })
  await link.hover()
  await panel.waitFor()
  assert.deepEqual(await states(panel, 'button', buttons), offered)
  await panel.getByRole('button', { name: 'Copy link', exact: true }).click()
  assert.equal(
    await app.evaluate(() => globalThis.copiedLink),
    'https://old.example',
  )
  // The menu offers the same.
  const items = ['Edit link…', 'Open link', 'Copy link', 'Remove link']
  const menu = page.getByRole('menu', { name: 'Link actions', exact: true })
  await link.click({ button: 'right' })
  await menu.waitFor()
  assert.deepEqual(await states(menu, 'menuitem', items), [
    'Edit link… disabled',
    'Open link',
    'Copy link',
    'Remove link disabled',
  ])
  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'hidden' })
  // Removal chosen from a menu opened before the note turned read-only removes nothing.
  await readOnly(false)
  await link.click({ button: 'right' })
  await menu.waitFor()
  assert.deepEqual(await states(menu, 'menuitem', items), items)
  await readOnly(true)
  await menu.getByRole('menuitem', { name: 'Remove link', exact: true }).click()
  await menu.waitFor({ state: 'hidden' })
  await settle(page)
  assert.equal(await read(), note)
  // Last, as opening a link makes the app busy, which ends this read-only spell.
  await link.hover()
  await panel.getByRole('button', { name: 'Open link', exact: true }).click()
  assert.deepEqual(await app.evaluate(() => globalThis.openedLinks), [
    'https://old.example/',
  ])
})

test('codemirror link actions wait for the caret to move after a note opens', {
  timeout: 60000,
}, async (t) => {
  // The note opens with its caret at the end of the table cell's link.
  const { page, editor, panel } = await open(t)
  await settle(page)
  assert.equal(await panel.isVisible(), false, 'on open')
  // The keyboard still reaches the link's actions there.
  await page.keyboard.press('Shift+F10')
  const menu = page.getByRole('menu', { name: 'Link actions', exact: true })
  await menu.getByRole('menuitem', { name: 'Copy link', exact: true }).waitFor()
  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'hidden' })
  await settle(page)
  assert.equal(await panel.isVisible(), false, 'after the menu')
  // A caret move into a link shows them.
  await place(editor, note.indexOf('docs') + 2)
  await panel.waitFor()
  assert.equal(
    await panel.locator('.hibi-link-destination').textContent(),
    'https://old.example',
  )
})

test('codemirror Escape in a composition leaves link actions to the input method', {
  timeout: 60000,
}, async (t) => {
  const { page, editor, panel, read } = await open(t)
  await place(editor, note.indexOf('docs') + 2)
  await panel.waitFor()
  // The input method's Escape cancels its composition, not the actions.
  const ime = await page.context().newCDPSession(page)
  await ime.send('Input.imeSetComposition', {
    text: 'か',
    selectionStart: 1,
    selectionEnd: 1,
  })
  await page.keyboard.press('Escape')
  await ime.send('Input.imeSetComposition', {
    text: '',
    selectionStart: 0,
    selectionEnd: 0,
  })
  await settle(page)
  assert.equal(await read(), note)
  assert.equal(await panel.isVisible(), true)
  // Escape after it hides them.
  await page.keyboard.press('Escape')
  await panel.waitFor({ state: 'hidden' })
})
