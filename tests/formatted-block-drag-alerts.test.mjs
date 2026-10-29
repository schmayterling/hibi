import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  after,
  before,
  electron,
  waitForAsync,
  waitForDocumentEditor,
} from './electron.mjs'
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
  await page.locator('.rich-pane .cm-line', { hasText: token }).waitFor()
}
async function menu(token) {
  const line = page.locator('.rich-pane .cm-line', { hasText: token })
  const box = await line.boundingBox()
  const top = await line.evaluate(
    (line) => Number.parseFloat(line.style.paddingTop) || 0,
  )
  await page.mouse.move(0, 0)
  await page.mouse.move(box.x + 80, box.y + top + 14)
  await page.waitForFunction(() => {
    const handle = document.querySelector('.rich-pane .block-drag-handle')
    return handle && getComputedStyle(handle).visibility === 'visible'
  })
  await page.locator('.rich-pane .block-drag-handle').click()
  return page.getByRole('menuitem', { name: 'Move block down', exact: true })
}
const saved = (doc) =>
  waitForAsync(
    page,
    async (doc) => (await window.hibi.getDocument()).markdown === doc,
    doc,
  )

test('an alert title handle moves the whole alert and keeps its title attached', {
  timeout: 60000,
}, async () => {
  const doc = '> [!NOTE]\n> first body\n>\n> second body\n\nafter paragraph\n'
  await open('alert.md', doc, 'first body')
  const title = page.locator('.rich-pane .hibi-lp-alert-title')
  const box = await title.boundingBox()
  await page.mouse.move(0, 0)
  await page.mouse.move(box.x + 80, box.y + box.height - 5)
  await page.waitForFunction(() => {
    const handle = document.querySelector('.rich-pane .block-drag-handle')
    return handle && getComputedStyle(handle).visibility === 'visible'
  })
  await page.locator('.rich-pane .block-drag-handle').click()
  await page
    .getByRole('menuitem', { name: 'Move block down', exact: true })
    .click()
  await waitForAsync(
    page,
    async (doc) => (await window.hibi.getDocument()).markdown !== doc,
    doc,
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'after paragraph\n\n> [!NOTE]\n> first body\n>\n> second body\n',
  )
  assert.equal(
    await page.locator('.rich-pane .hibi-lp-alert-title-text').count(),
    1,
  )
  await pressShortcut(app, `${mod}+z`)
  await saved(doc)
})
test('dropping onto the upper half of a title lands below the title', {
  timeout: 60000,
}, async () => {
  const doc = '> [!NOTE]\n> first body\n>\n> second body\n\nafter paragraph\n'
  await open('alert-drop.md', doc, 'second body')
  const body = page.locator('.rich-pane .cm-line', { hasText: 'second body' })
  const box = await body.boundingBox()
  await page.mouse.move(0, 0)
  await page.mouse.move(box.x + 90, box.y + box.height - 5)
  const handle = page.locator('.rich-pane .block-drag-handle')
  await page.waitForFunction(() => {
    const handle = document.querySelector('.rich-pane .block-drag-handle')
    return handle && getComputedStyle(handle).visibility === 'visible'
  })
  const transfer = await page.evaluateHandle(() => new DataTransfer())
  await handle.dispatchEvent('dragstart', { dataTransfer: transfer })
  const title = page.locator('.rich-pane .hibi-lp-alert-title')
  const heading = await title.boundingBox()
  const coords = { clientX: heading.x + 80, clientY: heading.y + 2 }
  await title.dispatchEvent('dragover', { ...coords, dataTransfer: transfer })
  await title.dispatchEvent('drop', { ...coords, dataTransfer: transfer })
  await handle.dispatchEvent('dragend', { dataTransfer: transfer })
  await saved(
    '> [!NOTE]\n>\n> second body\n>\n> first body\n\nafter paragraph\n',
  )
})

test('the first alert body cannot land above its title', {
  timeout: 60000,
}, async () => {
  const doc = '> [!WARNING]\n> body text\n\nafter paragraph\n'
  await open('alert-body.md', doc, 'body text')
  await menu('body text')
  assert.equal(
    await page
      .getByRole('menuitem', { name: 'Move block up', exact: true })
      .isEnabled(),
    false,
  )
  await page.keyboard.press('Escape')
  await saved(doc)
})
