import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test, { after, before } from 'node:test'
import { electron, waitForAsync, waitForDocumentEditor } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'

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
  await page.locator('.rich-pane .cm-line', { hasText: token }).waitFor()
}

async function hover(token) {
  const line = page.locator('.rich-pane .cm-line', { hasText: token })
  const box = await line.boundingBox()
  const top = await line.evaluate(
    (line) => Number.parseFloat(line.style.paddingTop) || 0,
  )
  await page.mouse.move(0, 0)
  await page.mouse.move(box.x + 90, box.y + top + 14)
  await page.waitForFunction(() => {
    const handle = document.querySelector('.rich-pane .block-drag-handle')
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
      .locator('.rich-pane .block-drag-handle')
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
      .locator('.rich-pane .block-drag-handle')
      .boundingBox()
    assert.ok(
      Math.abs(handle.x + handle.width - box.x) <= 1,
      JSON.stringify({ name, handle, box }),
    )
  }
})
