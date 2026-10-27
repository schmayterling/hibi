import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test, { after, before } from 'node:test'
import { electron, waitForAsync, waitForDocumentEditor } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
let app, page, folder
before(
  async () => {
    folder = await mkdtemp(join(tmpdir(), 'hibi-drag-structure-'))
    await mkdir(join(folder, 'profile'))
    await writeFile(
      join(folder, 'profile', 'addons.json'),
      JSON.stringify({ 'block-drag': true }),
    )
    app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
    })
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    page = await app.firstWindow()
    page.setDefaultTimeout(20000)
    await waitForDocumentEditor(app, page)
    await page.evaluate(() =>
      localStorage.setItem('hibi:formatted-engine', 'codemirror'),
    )
    await page.reload()
    await waitForDocumentEditor(app, page)
    const session = await page.context().newCDPSession(page)
    await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  },
  { timeout: 90000 },
)
after(
  async () => {
    await app?.close()
    if (folder) await rm(folder, { recursive: true, force: true })
  },
  { timeout: 30000 },
)

async function open(name, doc, token) {
  const file = join(folder, name)
  await writeFile(file, doc)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await pressShortcut(app, `${mod}+o`)
  await page
    .locator('.rich-pane:not([inert]) .cm-line', { hasText: token })
    .waitFor()
}

async function hover(token) {
  await page
    .locator('.rich-pane:not([inert]) .block-drag-handle')
    .waitFor({ state: 'attached' })
  const line = page.locator('.rich-pane:not([inert]) .cm-line', {
    hasText: token,
  })
  const top = await line.evaluate(
    (line) => Number.parseFloat(line.style.paddingTop) || 0,
  )
  await page.mouse.move(0, 0)
  await line.hover({ position: { x: 90, y: top + 14 } })
  await page.waitForFunction(() => {
    const handle = document.querySelector(
      '.rich-pane:not([inert]) .block-drag-handle',
    )
    return handle && getComputedStyle(handle).visibility === 'visible'
  })
  return line
}
test('hovered task handles leave checkboxes clickable in plain and nested containers', {
  timeout: 90000,
}, async () => {
  for (const [name, doc] of [
    ['plain', '- [ ] first task\n- [ ] second task\n'],
    ['quote', '> - [ ] first task\n> - [ ] second task\n'],
    ['nested', '- parent\n  - [ ] first task\n  - [ ] second task\n'],
  ]) {
    await open(`${name}.md`, doc, 'second task')
    const line = await hover('second task')
    const checkbox = line.locator('input.hibi-lp-task')
    const box = await checkbox.boundingBox()
    const handle = await page
      .locator('.rich-pane:not([inert]) .block-drag-handle')
      .boundingBox()
    assert.ok(
      handle.x + handle.width <= box.x,
      JSON.stringify({ name, handle, box }),
    )
    const x = box.x + box.width / 2,
      y = box.y + box.height / 2
    assert.equal(
      await page.evaluate(
        ({ x, y }) =>
          document.elementFromPoint(x, y)?.matches('input.hibi-lp-task'),
        { x, y },
      ),
      true,
    )
    await page.mouse.click(x, y)
    await waitForAsync(
      page,
      async (doc) =>
        (await window.hibi.getDocument()).markdown ===
        doc.replace('- [ ] second', '- [x] second'),
      doc,
    )
    assert.equal(
      await page
        .getByRole('menuitem', { name: 'Move block down', exact: true })
        .count(),
      0,
    )
  }
})
test('alert and footnote handles follow the actual content offset', {
  timeout: 60000,
}, async () => {
  for (const [name, doc, token] of [
    ['alert', '> [!NOTE]\n> alert body\n', 'alert body'],
    ['footnote', 'ref[^f]\n\n[^f]: footnote body\n', 'footnote body'],
    [
      'quoted-footnote',
      '> ref[^f]\n>\n> [^f]: footnote body\n',
      'footnote body',
    ],
  ]) {
    await open(`${name}.md`, doc, token)
    const line = await hover(token)
    const box = await line.boundingBox()
    const handle = await page
      .locator('.rich-pane:not([inert]) .block-drag-handle')
      .boundingBox()
    assert.ok(
      Math.abs(handle.x + handle.width - box.x) <= 1,
      JSON.stringify({ name, handle, box }),
    )
  }
})

test('nested heading handles follow the rendered text line', {
  timeout: 60000,
}, async () => {
  for (const [name, doc] of [
    ['quoted-heading', '> # nested heading\n'],
    ['item-heading', '- first\n\n  # nested heading\n'],
    ['alert-heading', '> [!NOTE]\n> # nested heading\n'],
    ['footnote-heading', 'ref[^f]\n\n[^f]: first\n\n    # nested heading\n'],
  ]) {
    await open(`${name}.md`, doc, 'nested heading')
    const line = await hover('nested heading')
    const box = await line.boundingBox()
    const handle = await page
      .locator('.rich-pane:not([inert]) .block-drag-handle')
      .boundingBox()
    assert.ok(
      Math.abs(handle.x + handle.width - box.x) <= 1,
      JSON.stringify({ name, handle, box }),
    )
  }
})

test('enabling block drag in an open note keeps task checkboxes clickable', {
  timeout: 90000,
}, async () => {
  const doc = '- [ ] first task\n- [ ] second task\n'
  await open('activation.md', doc, 'second task')
  const toggle = async () => {
    await clickMenu(app, 'Settings')
    await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
    await page.locator('#addon-block-drag').click()
    await page.keyboard.press('Escape')
    await page
      .getByRole('button', { name: 'Back to app', exact: true })
      .waitFor({ state: 'hidden' })
    await page.locator('.rich-pane:not([inert]) .cm-content').waitFor()
  }
  await toggle()
  await waitForAsync(
    page,
    () => !document.querySelector('.rich-pane:not([inert]) .block-drag-handle'),
  )
  await toggle()
  const line = await hover('second task')
  const checkbox = await line.locator('input.hibi-lp-task').boundingBox()
  const handle = await page
    .locator('.rich-pane:not([inert]) .block-drag-handle')
    .boundingBox()
  assert.ok(
    handle.x + handle.width <= checkbox.x,
    JSON.stringify({ handle, checkbox }),
  )
  await page.mouse.click(
    checkbox.x + checkbox.width / 2,
    checkbox.y + checkbox.height / 2,
  )
  await waitForAsync(
    page,
    async (doc) =>
      (await window.hibi.getDocument()).markdown ===
      doc.replace('- [ ] second', '- [x] second'),
    doc,
  )
})

test('source-prefix edits keep task controls clear of their mapped handle', {
  timeout: 90000,
}, async () => {
  const doc = '- [ ] first task\n- [ ] second task\n'
  await open('prefix.md', doc, 'second task')
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  const source = page.getByRole('textbox', {
    name: 'Markdown editor',
    exact: true,
  })
  await source.waitFor()
  await source.click()
  await page.keyboard.press(
    process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home',
  )
  await page.keyboard.insertText('prefix\n\n')
  await waitForAsync(
    page,
    async (doc) =>
      (await window.hibi.getDocument()).markdown === 'prefix\n\n' + doc,
    doc,
  )
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  const line = await hover('second task')
  const checkbox = await line.locator('input.hibi-lp-task').boundingBox()
  const handle = await page
    .locator('.rich-pane:not([inert]) .block-drag-handle')
    .boundingBox()
  assert.ok(
    handle.x + handle.width <= checkbox.x,
    JSON.stringify({ handle, checkbox }),
  )
  await page.mouse.click(
    checkbox.x + checkbox.width / 2,
    checkbox.y + checkbox.height / 2,
  )
  await waitForAsync(
    page,
    async (doc) =>
      (await window.hibi.getDocument()).markdown ===
      'prefix\n\n' + doc.replace('- [ ] second', '- [x] second'),
    doc,
  )
})
