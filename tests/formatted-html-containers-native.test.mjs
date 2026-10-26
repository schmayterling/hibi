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

test('quoted html ends before following prose and lists, with container markers hidden', {
  timeout: 90000,
}, async () => {
  for (const [name, doc] of [
    [
      'quote',
      '> <div>\n> html line\n> </div>\n>\n> after paragraph\n>\n> - quoted item\n',
    ],
    [
      'nested',
      '- parent\n\n  > <custom-tag>\n  > html line\n  > </custom-tag>\n  >\n  > after paragraph\n  >\n  > - quoted item\n',
    ],
  ]) {
    await open(`${name}.md`, doc, 'after paragraph')
    const lines = page.locator('.rich-pane .cm-line')
    assert.equal(
      await lines
        .filter({ hasText: 'after paragraph' })
        .evaluate((line) => line.classList.contains('hibi-lp-codeblock')),
      false,
    )
    assert.equal(
      await lines
        .filter({ hasText: 'quoted item' })
        .evaluate((line) => line.classList.contains('hibi-lp-codeblock')),
      false,
    )
    assert.equal(
      await lines
        .filter({ hasText: 'quoted item' })
        .evaluate((line) => line.classList.contains('hibi-lp-list-item')),
      true,
    )
    assert.equal(
      await lines.filter({ hasText: 'html line' }).textContent(),
      'html line',
    )
    const code = await page
      .locator('.rich-pane .hibi-lp-codeblock')
      .allTextContents()
    assert.equal(code.length, 3)
    assert.equal(
      code.some((line) => /^\s*>/.test(line)),
      false,
    )
    assert.equal(
      (await page.evaluate(() => window.hibi.getDocument())).markdown,
      doc,
    )
  }
})
test('quoted fences still hide their container markers after html parsing changes', {
  timeout: 60000,
}, async () => {
  const doc =
    '> ~~~txt\n> quoted code\n> ~~~\n\n- parent\n\n  > ~~~txt\n  > nested code\n  > ~~~\n'
  await open('fences.md', doc, 'nested code')
  assert.deepEqual(
    await page.locator('.rich-pane .hibi-lp-codeblock').allTextContents(),
    ['quoted code', 'nested code'],
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    doc,
  )
})
