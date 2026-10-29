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
      JSON.stringify({ 'block-drag': true, math: true }),
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

test('quoted list moves preserve their following paragraph and do not grow blank lines', {
  timeout: 60000,
}, async () => {
  const doc = '> - alpha item\n> - beta item\n>\n> after paragraph\n'
  await open('quote.md', doc, 'alpha item')
  for (let i = 0; i < 3; i++) {
    await (await menu('alpha item')).click()
    const expected = '> - beta item\n> - alpha item\n>\n> after paragraph\n'
    await waitForAsync(
      page,
      async () =>
        (await window.hibi.getDocument()).markdown !==
        '> - alpha item\n> - beta item\n>\n> after paragraph\n',
    )
    assert.equal(
      (await page.evaluate(() => window.hibi.getDocument())).markdown,
      expected,
    )
    assert.equal(
      await page
        .locator('.rich-pane .cm-line', { hasText: 'after paragraph' })
        .evaluate((line) => line.classList.contains('hibi-lp-list-item')),
      false,
    )
    await pressShortcut(app, `${mod}+z`)
    await saved(doc)
  }
})

test('a move cannot absorb the paragraph following a quote', {
  timeout: 60000,
}, async () => {
  const doc = '> quoted paragraph\n>\n> # heading\noutside paragraph\n'
  await open('lazy.md', doc, 'quoted paragraph')
  assert.equal(await (await menu('quoted paragraph')).isEnabled(), false)
  await page.keyboard.press('Escape')
  await saved(doc)
  assert.equal(
    await page
      .locator('.rich-pane .cm-line', { hasText: 'outside paragraph' })
      .evaluate((line) => line.classList.contains('hibi-lp-quote')),
    false,
  )
})

test('list marker spacing cannot absorb the paragraph following the list', {
  timeout: 60000,
}, async () => {
  const doc = '- narrow item\n-   wide item\n\n  note text\n'
  await open('list-tail.md', doc, 'narrow item')
  assert.equal(await (await menu('narrow item')).isEnabled(), false)
  await page.keyboard.press('Escape')
  await saved(doc)
})

test('moving a later paragraph cannot turn earlier paragraphs into math', {
  timeout: 60000,
}, async () => {
  const doc = '$$ a\n\nfirst paragraph\n\nmiddle paragraph\n\nm $$ x\n\nz $$\n'
  await open('math-lookahead.md', doc, 'm $$ x')
  assert.equal(await (await menu('m $$ x')).isEnabled(), false)
  await page.keyboard.press('Escape')
  await saved(doc)
})

test('moving a table delimiter cannot change the lazy list and quote above it', {
  timeout: 60000,
}, async () => {
  const doc = '> a\n2. | b | c |\n>    | --- | - |\n>    # h\n'
  await open('table-lookahead.md', doc, '| --- | - |')
  assert.equal(await (await menu('| --- | - |')).isEnabled(), false)
  await page.keyboard.press('Escape')
  await saved(doc)
})

test('moving indented code below a list is disabled before source changes', {
  timeout: 60000,
}, async () => {
  const doc = '    indented code\n\n- list item\n\nafter paragraph\n'
  await open('code.md', doc, 'indented code')
  const down = await menu('indented code')
  assert.equal(await down.isEnabled(), false)
  await page.keyboard.press('Escape')
  await saved(doc)
  assert.equal(
    await page
      .locator('.rich-pane .cm-line', { hasText: 'indented code' })
      .evaluate((line) => line.classList.contains('hibi-lp-codeblock')),
    true,
  )
})
