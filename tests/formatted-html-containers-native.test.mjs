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

/**
 * A note opens with the caret on its last line, which then shows its prefix
 * markers; on the blank line after the first block, no line shows them.
 */
async function caretBetweenBlocks(doc) {
  await page.evaluate((at) => {
    document
      .querySelector('.rich-pane .cm-content')
      .cmTile.root.view.dispatch({ selection: { anchor: at } })
  }, doc.indexOf('\n\n') + 1)
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
test('skipped inline nodes and disabled html keep quote prefixes hidden', {
  timeout: 90000,
}, async () => {
  const doc =
    [
      '> <div>',
      '> literal html',
      '> </div>',
      '>',
      '> a \x60code',
      '> span\x60 b',
      '>',
      '> ![*alt',
      '> text*](u.png)',
      '>',
      '> before <span',
      '> class="x">t</span>',
      '>',
      '> [a]:',
      '> /url',
    ].join('\n') + '\n'
  await open('skipped.md', doc, 'literal html')
  await page.evaluate(() =>
    localStorage.setItem(
      'hibi:markdown-syntax-disabled',
      JSON.stringify(['core.html-blocks', 'core.images']),
    ),
  )
  try {
    await page.reload()
    await waitForDocumentEditor(app, page)
    await waitForAsync(
      page,
      () =>
        document.querySelector('.rich-pane .cm-line')?.textContent === '<div>',
    )
    assert.equal(await page.locator('.rich-pane .hibi-lp-codeblock').count(), 0)
    const lines = await page.locator('.rich-pane .cm-line').allTextContents()
    assert.equal(
      lines.some((line) => /^\s*>/.test(line)),
      false,
      JSON.stringify(lines),
    )
    assert.ok(lines.includes('literal html'))
    assert.ok(lines.includes('a code span b'))
    assert.ok(lines.includes('![*alt text*](u.png)'))
    assert.ok(lines.includes('before <span class="x">t</span>'))
    // A reference definition takes no lines in the formatted view, quoted too.
    assert.ok(
      !lines.some((line) => /\[a\]:|\/url/.test(line)),
      JSON.stringify(lines),
    )
    await page.evaluate(() =>
      localStorage.setItem(
        'hibi:markdown-syntax-disabled',
        JSON.stringify(['core.html-blocks', 'core.images', 'core.quotes']),
      ),
    )
    await page.reload()
    await waitForDocumentEditor(app, page)
    await waitForAsync(
      page,
      () =>
        document.querySelector('.rich-pane .cm-line')?.textContent ===
        '> <div>',
    )
    assert.equal(
      (await page.evaluate(() => window.hibi.getDocument())).markdown,
      doc,
    )
  } finally {
    await page.evaluate(() =>
      localStorage.removeItem('hibi:markdown-syntax-disabled'),
    )
    await page.reload()
    await waitForDocumentEditor(app, page)
  }
})

test('literal lists keep nested quote markers while active quote prefixes hide', {
  timeout: 90000,
}, async () => {
  const doc =
    '> - literal a\n>   > literal b\n>   > literal c\n\n> 1. literal d\n>    > literal e\n\n> > - nested a\n> >   > nested b\n> >   > nested c\n'
  await open('literal-lists.md', doc, 'literal a')
  await page.evaluate(() =>
    localStorage.setItem(
      'hibi:markdown-syntax-disabled',
      JSON.stringify(['core.bullet-lists', 'core.numbered-lists']),
    ),
  )
  try {
    await page.reload()
    await waitForDocumentEditor(app, page)
    await waitForAsync(
      page,
      () =>
        document.querySelector('.rich-pane .cm-line')?.textContent ===
        '- literal a',
    )
    await caretBetweenBlocks(doc)
    assert.deepEqual(
      await page.locator('.rich-pane .cm-line').allTextContents(),
      [
        '- literal a',
        '  > literal b',
        '  > literal c',
        '',
        '1. literal d',
        '   > literal e',
        '',
        '- nested a',
        '  > nested b',
        '  > nested c',
        '',
      ],
    )
    assert.equal(
      (await page.evaluate(() => window.hibi.getDocument())).markdown,
      doc,
    )
  } finally {
    await page.evaluate(() =>
      localStorage.removeItem('hibi:markdown-syntax-disabled'),
    )
    await page.reload()
    await waitForDocumentEditor(app, page)
  }
})

test('quoted fences still hide their container markers after html parsing changes', {
  timeout: 60000,
}, async () => {
  const doc =
    '> ~~~txt\n> quoted code\n> ~~~\n\n- parent\n\n  > ~~~txt\n  > nested code\n  > ~~~\n\n> ~~~markdown\n> > literal greater-than\n> ~~~\n'
  await open('fences.md', doc, 'nested code')
  await caretBetweenBlocks(doc)
  assert.deepEqual(
    await page.locator('.rich-pane .hibi-lp-codeblock').allTextContents(),
    ['quoted code', 'nested code', '> literal greater-than'],
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    doc,
  )
})
