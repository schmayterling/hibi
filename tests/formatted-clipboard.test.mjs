import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test, { after, before } from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const note = `# Clipboard

A [link](https://example.com/) and ![image](img.png) in **bold** and \`code\`.

- one
  - nested *two*
- three

1. first
2. second

\`\`\`js
const x = 1
\`\`\`

| a | b |
| --- | --- |
| 1 | 2 |

> quoted ~~gone~~
`

let app, page, folder, file

/** Open the note in the app, in the codemirror formatted view or the rich view. */
async function open(formatted) {
  await page.evaluate((formatted) => {
    if (formatted) localStorage.setItem('hibi:formatted-engine', 'codemirror')
    else localStorage.removeItem('hibi:formatted-engine')
  }, formatted)
  await page.reload()
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await pressShortcut(app, `${mod}+o`)
  await page
    .locator(formatted ? '.rich-pane .cm-content' : '.rich-pane .tiptap')
    .getByText('quoted')
    .waitFor()
  // Hidden windows have no focus; editors need a focused page.
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
}

before(
  async () => {
    folder = await mkdtemp(join(tmpdir(), 'hibi-formatted-clipboard-'))
    await mkdir(join(folder, 'notes'))
    file = join(folder, 'notes', 'note.md')
    await writeFile(file, note)
    app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
    })
    // Quitting with the edited note answers the unsaved-changes prompt.
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    // The system clipboard stays as it is: main's clipboard is a stand-in
    // holding the text a copy put there and what main adds to it.
    await app.evaluate(({ clipboard }) => {
      const stub = { text: '', html: '', reads: 0, writes: 0 }
      globalThis.clipboardStub = stub
      clipboard.readText = async () => {
        stub.reads++
        return stub.text
      }
      clipboard.write = async ([item]) => {
        stub.writes++
        stub.text = await (await item.getType('text/plain')).text()
        stub.html = await (await item.getType('text/html')).text()
      }
    })
    page = await app.firstWindow()
    page.setDefaultTimeout(10000)
    await waitForDocumentEditor(app, page)
    await open(true)
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

/** Select `from`–`to` in the formatted view and send it a clipboard event; returns what it put on the clipboard. */
const clipboardEvent = (type, from, to, put = {}) =>
  page.evaluate(
    ({ type, from, to, put }) => {
      const view = document.querySelector('.rich-pane .cm-content').cmTile.root
        .view
      view.focus()
      view.dispatch({ selection: { anchor: from, head: to } })
      const data = new DataTransfer()
      for (const [format, value] of Object.entries(put))
        data.setData(format, value)
      const event = new ClipboardEvent(type, {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      })
      view.contentDOM.dispatchEvent(event)
      return {
        text: data.getData('text/plain'),
        html: data.getData('text/html'),
        handled: event.defaultPrevented,
      }
    },
    { type, from, to, put },
  )
/**
 * Copy `from`–`to` in the formatted view, the clipboard holding `held` after
 * the copy event; returns the text and the html main adds to it.
 */
async function copyRendered(from, to, held, type = 'copy') {
  const before = await app.evaluate((_, held) => {
    const stub = globalThis.clipboardStub
    Object.assign(stub, { text: held, html: '' })
    return { reads: stub.reads, writes: stub.writes }
  }, held)
  const { text } = await clipboardEvent(type, from, to)
  // Main compares the clipboard's text, then writes it with the html, or not.
  await waitForAsync(
    app,
    (_, { reads, writes, write }) =>
      write
        ? globalThis.clipboardStub.writes > writes
        : globalThis.clipboardStub.reads > reads,
    { ...before, write: held === text },
  )
  return {
    text,
    html: await app.evaluate(() => globalThis.clipboardStub.html),
    writes:
      (await app.evaluate(() => globalThis.clipboardStub.writes)) -
      before.writes,
  }
}
const markdown = async () =>
  (await page.evaluate(() => window.hibi.getDocument())).markdown
const undo = () => page.keyboard.press(`${mod}+z`)

test('copy puts the exact markdown of the selection and its export html on the clipboard', {
  timeout: 30000,
}, async () => {
  const from = note.indexOf('A [link]'),
    to = note.indexOf('> quoted')
  const { text, html } = await copyRendered(from, to, note.slice(from, to))
  assert.equal(text, note.slice(from, to))
  for (const part of [
    /<a href="https:\/\/example\.com\/">link<\/a>/,
    /<img [^>]*src="[^"]*img\.png"/,
    /<strong>bold<\/strong>/,
    /<code>code<\/code>/,
    /<li>[\s\S]*?nested[\s\S]*?<\/ul>\s*<\/li>/,
    /<ol>[\s\S]*<li>first<\/li>/,
    /<pre><code class="language-js">/,
    /<table>[\s\S]*<th>a<\/th>[\s\S]*<td>2<\/td>/,
  ])
    assert.match(html, part)
  // A later copy keeps the clipboard: the html is only added to its own text.
  const later = await copyRendered(from, to, 'copied later')
  assert.deepEqual([later.html, later.writes], ['', 0])
  // Collapsed selections keep the view's line copy.
  const line = await clipboardEvent('copy', from + 2, from + 2)
  assert.deepEqual([line.html, line.handled], ['', true])
})

test('cut removes the selection in one undoable edit', {
  timeout: 30000,
}, async () => {
  const from = note.indexOf('1. first'),
    to = note.indexOf('2. second') + '2. second'.length
  const { text, html } = await copyRendered(
    from,
    to,
    note.slice(from, to),
    'cut',
  )
  assert.equal(text, note.slice(from, to))
  assert.match(html, /<ol>\s*<li>first<\/li>/)
  await waitForAsync(
    page,
    async (gone) => !(await window.hibi.getDocument()).markdown.includes(gone),
    '1. first',
  )
  await undo()
  await waitForAsync(
    page,
    async (note) => (await window.hibi.getDocument()).markdown === note,
    note,
  )
})

test('pasted html becomes markdown in one edit; plain text and own copies paste as they are', {
  timeout: 30000,
}, async () => {
  assert.equal(await markdown(), note)
  const end = note.length
  const html =
    '<meta charset="utf-8"><h2>Title</h2><p>Some <strong>bold</strong>, <em>em</em>, <del>gone</del>, <code>a`b</code> and <a href="https://x.test/a b">link</a>.<br>next *star*</p>' +
    '<ul><li>one<ul><li>nested</li></ul></li><li>two</li></ul><ol start="3"><li>three</li></ol>' +
    '<blockquote><p>quoted</p></blockquote><pre><code class="language-py">print(1)\n</code></pre>' +
    '<p><img src="pic.png" alt="pic"></p><table><tr><th>a</th><th>b|c</th></tr><tr><td>1</td><td>2</td></tr></table>' +
    '<hr><p><span>kept</span> <custom-el>text</custom-el></p>'
  const expected = [
    '## Title',
    'Some **bold**, *em*, ~~gone~~, ``a`b`` and [link](<https://x.test/a b>).  \nnext \\*star\\*',
    '- one\n  - nested\n- two',
    '3. three',
    '> quoted',
    '```py\nprint(1)\n```',
    '![pic](pic.png)',
    '| a | b\\|c |\n| --- | --- |\n| 1 | 2 |',
    '---',
    'kept text',
  ].join('\n\n')
  const pasted = await clipboardEvent('paste', end, end, {
    'text/html': html,
    'text/plain': 'ignored',
  })
  assert.equal(pasted.handled, true)
  await waitForAsync(
    page,
    async (text) => (await window.hibi.getDocument()).markdown.endsWith(text),
    expected,
  )
  // One source edit: one undo removes all of it.
  await undo()
  await waitForAsync(
    page,
    async (note) => (await window.hibi.getDocument()).markdown === note,
    note,
  )
  // Plain text pastes as it is.
  await clipboardEvent('paste', end, end, { 'text/plain': 'plain *text*' })
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.endsWith('plain *text*'),
  )
  await undo()
  // A copy from this view pastes its exact markdown, not its html.
  const from = note.indexOf('| a |'),
    to = note.indexOf('> quoted')
  const copy = await copyRendered(from, to, note.slice(from, to))
  assert.match(copy.html, /<table>/)
  await clipboardEvent('paste', end, end, {
    'text/html': copy.html,
    'text/plain': copy.text,
  })
  await waitForAsync(
    page,
    async (text) => (await window.hibi.getDocument()).markdown.endsWith(text),
    note.slice(from, to),
  )
  await undo()
  assert.equal(await markdown(), note)
})

test('the rich view copies the same rendered content for the same note', {
  timeout: 60000,
}, async () => {
  /** The text and html of a copy, and what the html renders. */
  const read = (text, html) =>
    page.evaluate(
      ({ text, html }) => {
        const parsed = new DOMParser().parseFromString(html, 'text/html')
        return {
          text,
          html,
          // Whitespace between blocks differs: the rich view's html has none.
          rendered: parsed.body.textContent.replace(/\s+/g, ''),
          elements: [
            ...new Set(
              [...parsed.body.querySelectorAll('*')].map(
                (node) => node.localName,
              ),
            ),
          ].sort(),
        }
      },
      { text, html },
    )
  assert.equal(await markdown(), note)
  const all = await copyRendered(0, note.length, note)
  const formatted = await read(all.text, all.html)
  await open(false)
  await page.locator('.rich-pane .tiptap').click()
  await page.keyboard.press(`${mod}+a`)
  const copied = await page.evaluate(() => {
    const element = document.querySelector('.rich-pane .tiptap')
    const data = new DataTransfer()
    element.dispatchEvent(
      new ClipboardEvent('copy', {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    )
    return { text: data.getData('text/plain'), html: data.getData('text/html') }
  })
  const rich = await read(copied.text, copied.html)
  console.log(JSON.stringify({ formatted, rich }, null, 1))
  // The text is the note's markdown, where the rich view gave its rendered text.
  assert.equal(formatted.text, note)
  // Both render the same text and the same kinds of content.
  assert.equal(formatted.rendered, rich.rendered)
  for (const name of [
    'a',
    'blockquote',
    'code',
    'img',
    'li',
    'ol',
    'pre',
    'strong',
    'table',
    'ul',
  ]) {
    assert.ok(formatted.elements.includes(name), `formatted ${name}`)
    assert.ok(rich.elements.includes(name), `rich ${name}`)
  }
})
