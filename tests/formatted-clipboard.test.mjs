import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test, { after, before } from 'node:test'
import { marked } from 'marked'
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

/**
 * Select `from`–`to` (null: the end) in the formatted view and send it a
 * clipboard event; returns what it put on the clipboard.
 */
const clipboardEvent = (type, from, to, put = {}) =>
  page.evaluate(
    ({ type, from, to, put }) => {
      const view = document.querySelector('.rich-pane .cm-content').cmTile.root
        .view
      view.focus()
      view.dispatch({
        selection: { anchor: from, head: to ?? view.state.doc.length },
      })
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
const markdown = async () =>
  (await page.evaluate(() => window.hibi.getDocument())).markdown
const undo = () => page.keyboard.press(`${mod}+z`)
/** Wait until the note's Markdown is `text`. */
const settled = (text) =>
  waitForAsync(
    page,
    async (text) => (await window.hibi.getDocument()).markdown === text,
    text,
  )

async function setFixture(text) {
  await page.locator('.rich-pane .cm-content').evaluate((element, text) => {
    const view = element.cmTile.root.view
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: 0 },
      userEvent: 'input',
    })
  }, text)
  await settled(text)
}

async function nativeClipboard(command, from, to = from) {
  const before = await page.evaluate(
    ({ command, from, to }) => {
      const view = document.querySelector('.rich-pane .cm-content').cmTile.root
        .view
      view.dispatch({ selection: { anchor: from, head: to } })
      view.focus()
      window.nativeClipboardCount ??= 0
      document.addEventListener(
        command,
        () => {
          queueMicrotask(() => {
            window.nativeClipboardCount++
          })
        },
        { once: true, capture: true },
      )
      return window.nativeClipboardCount
    },
    { command, from, to },
  )
  await app.evaluate(({ BrowserWindow }, command) => {
    BrowserWindow.getAllWindows()[0].webContents[command]()
  }, command)
  await page.waitForFunction(
    (before) => window.nativeClipboardCount > before,
    before,
  )
}

const readClipboard = () =>
  app.evaluate(async ({ clipboard }) => {
    const items = await clipboard.read()
    const item = items.find((item) => item.types.includes('text/html'))
    return {
      text: await clipboard.readText(),
      html: item ? await (await item.getType('text/html')).text() : '',
    }
  })

test('native copy, cut and paste retain both clipboard formats and sanitize exported html', {
  timeout: 60000,
}, async () => {
  const from = note.indexOf('A [link]'),
    to = note.indexOf('\n\n- one')
  const text = note.slice(from, to)
  await nativeClipboard('copy', from, to)
  const copied = await readClipboard()
  assert.equal(copied.text, text)
  assert.match(copied.html, /<strong>bold<\/strong>/)
  assert.match(copied.html, /data-hibi-markdown/)

  await nativeClipboard('paste', note.length)
  await settled(note + text)
  await undo()
  await settled(note)

  await nativeClipboard('cut', from, to)
  await settled(note.slice(0, from) + note.slice(to))
  assert.equal((await readClipboard()).text, text)
  await undo()
  await settled(note)

  await app.evaluate(async ({ clipboard, ClipboardItem }) => {
    await clipboard.write([
      new ClipboardItem({
        'text/plain': 'external unsafe',
        'text/html':
          '<p><strong>external</strong> <a href="javascript:alert(1)">unsafe</a></p><script>alert(2)</script>',
      }),
    ])
  })
  await nativeClipboard('paste', note.length)
  await settled(`${note}**external** unsafe`)
  await undo()
  await settled(note)

  const plain = 'plain *literal* 🌿\nsecond line'
  await app.evaluate(
    ({ clipboard }, plain) => clipboard.writeText(plain),
    plain,
  )
  await nativeClipboard('paste', note.length)
  await settled(note + plain)
  await undo()
  await settled(note)

  const unsafe =
    '<script>alert(1)</script>\n\n<img src="x.png" onerror="alert(2)">'
  await clipboardEvent('paste', note.length, note.length, {
    'text/plain': unsafe,
  })
  await settled(note + unsafe)
  await nativeClipboard('copy', note.length, note.length + unsafe.length)
  assert.equal((await readClipboard()).text, unsafe)
  assert.doesNotMatch(
    (await readClipboard()).html,
    /<script|onerror|javascript:/i,
  )
  await undo()
  await settled(note)
})

test('native formatted copy has no one-mebibyte content cutoff', {
  timeout: 60000,
}, async () => {
  const text = `${'clipboard text '.repeat(16)}\n\n`.repeat(5000)
  assert.ok(text.length > 1024 * 1024)
  await clipboardEvent('paste', note.length, note.length, {
    'text/plain': text,
  })
  await settled(note + text)
  await nativeClipboard('copy', note.length, note.length + text.length)
  const copied = await readClipboard()
  assert.equal(copied.text.length, text.length)
  assert.equal(copied.text, text)
  assert.ok(copied.html.length > text.length)
  await undo()
  await settled(note)
})

test('copy puts the exact markdown of the selection and its export html on the clipboard', {
  timeout: 30000,
}, async () => {
  const from = note.indexOf('A [link]'),
    to = note.indexOf('> quoted')
  const { text, html, handled } = await clipboardEvent('copy', from, to)
  assert.equal(handled, true)
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
  // Collapsed selections keep the view's line copy.
  const line = await clipboardEvent('copy', from + 2, from + 2)
  assert.deepEqual([line.html, line.handled], ['', true])
})

test('copied html leaves out scripts, event handlers and script links', {
  timeout: 30000,
}, async () => {
  const unsafe = [
    '<script>document.body.dataset.copied = "script"</script>',
    '<img src="x.png" onerror="document.body.dataset.copied = \'image\'">',
    '[bad](javascript:alert(1)) <a href="javascript:alert(2)" onclick="alert(3)">raw</a>',
  ].join('\n\n')
  await clipboardEvent('paste', note.length, note.length, {
    'text/plain': unsafe,
  })
  await settled(note + unsafe)
  const { text, html } = await clipboardEvent('copy', note.length, null)
  assert.equal(text, unsafe)
  assert.match(html, /<img [^>]*src="x\.png"/)
  assert.match(html, />bad<\/a>[\s\S]*>raw<\/a>/)
  assert.doesNotMatch(html, /<script|onerror|onclick|javascript:/i)
  await undo()
  await settled(note)
})

test('cut removes the selection in one undoable edit', {
  timeout: 30000,
}, async () => {
  const from = note.indexOf('1. first'),
    to = note.indexOf('2. second') + '2. second'.length
  const { text, html } = await clipboardEvent('cut', from, to)
  assert.equal(text, note.slice(from, to))
  assert.match(html, /<ol>\s*<li>first<\/li>/)
  await settled(note.slice(0, from) + note.slice(to))
  await undo()
  await settled(note)
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
  await settled(note + expected)
  // One source edit: one undo removes all of it.
  await undo()
  await settled(note)
  // Plain text pastes as it is.
  await clipboardEvent('paste', end, end, { 'text/plain': 'plain *text*' })
  await settled(`${note}plain *text*`)
  await undo()
  // A copy from this view pastes its exact markdown, not its html.
  const from = note.indexOf('| a |'),
    to = note.indexOf('> quoted')
  const copy = await clipboardEvent('copy', from, to)
  assert.match(copy.html, /<table>/)
  await clipboardEvent('paste', end, end, {
    'text/html': copy.html,
    'text/plain': copy.text,
  })
  await settled(note + note.slice(from, to))
  await undo()
  await settled(note)
})

test('pasted text stays literal, task items keep their state, code keeps its fence and tables stay linear', {
  timeout: 30000,
}, async () => {
  assert.equal(await markdown(), note)
  const end = note.length
  const columns = 600
  const html =
    '<p>&amp;copy; ~~literal~~ $5 and $6 a==b== &amp;#35;</p>' +
    // The rich view's task items wrap their checkboxes in labels.
    '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked="checked"><span></span></label><div><p>done</p></div></li>' +
    '<li data-type="taskItem" data-checked="false"><label><input type="checkbox"><span></span></label><div><p>todo</p></div></li></ul>' +
    '<pre><code>a\n  ```\n# injected\n</code></pre>' +
    `<table><tr><th>h</th></tr><tr>${'<td>c</td>'.repeat(columns)}</tr>${'<tr><td>r</td></tr>'.repeat(columns)}</table>`
  const expected = [
    '\\&copy; \\~\\~literal\\~\\~ \\$5 and \\$6 a\\==b\\== \\&#35;',
    '- [x] done\n- [ ] todo',
    '````\na\n  ```\n# injected\n````',
    [
      `| ${['h', ...Array(columns - 1).fill('')].join(' | ')} |`,
      `| ${Array(columns).fill('---').join(' | ')} |`,
      `| ${Array(columns).fill('c').join(' | ')} |`,
      ...Array(columns).fill('| r |'),
    ].join('\n'),
  ].join('\n\n')
  await clipboardEvent('paste', end, end, { 'text/html': html })
  await settled(note + expected)
  await undo()
  await settled(note)
})

test('incidental copy-marker text does not bypass html conversion', {
  timeout: 30000,
}, async () => {
  await clipboardEvent('paste', note.length, note.length, {
    'text/plain': 'literal data-hibi-markdown and bold',
    'text/html': '<p>literal data-hibi-markdown and <strong>bold</strong></p>',
  })
  await settled(`${note}literal data-hibi-markdown and **bold**`)
  await undo()
  await settled(note)
})

test('large html pastes convert without losing their text', {
  timeout: 60000,
}, async () => {
  assert.equal(await markdown(), note)
  const end = note.length
  // A code span with 130,000 backtick runs, then 200,000 paragraphs in one block.
  const code = '`a'.repeat(130000)
  const html = `<p><code>${code}</code></p><div>${'<p>b</p>'.repeat(200000)}</div>`
  await clipboardEvent('paste', end, end, { 'text/html': html })
  const head = `\`\` ${code.slice(0, 40)}`,
    length = note.length + `\`\` ${code} \`\``.length + 3 * 200000
  await waitForAsync(
    page,
    async ({ note, head, length }) => {
      const text = (await window.hibi.getDocument()).markdown
      return (
        text.length === length &&
        text.startsWith(note + head) &&
        text.endsWith('\n\nb\n\nb')
      )
    },
    { note, head, length },
    { timeout: 30000 },
  )
  await undo()
  await settled(note)
})

test('an html paste waiting for its converter replaces the selection it was made at', {
  timeout: 30000,
}, async () => {
  assert.equal(await markdown(), note)
  const from = note.indexOf('A [link]'),
    typed = note.indexOf('Clipboard')
  await page.evaluate(
    ({ from, typed }) => {
      const view = document.querySelector('.rich-pane .cm-content').cmTile.root
        .view
      view.focus()
      view.dispatch({ selection: { anchor: from, head: from + 1 } })
      const data = new DataTransfer()
      data.setData('text/html', '<p><strong>late</strong></p>')
      view.contentDOM.dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      )
      // Typing and selecting elsewhere before the converter answers.
      view.dispatch({
        changes: { from: typed, insert: 'typed ' },
        userEvent: 'input.type',
      })
      const bold = view.state.doc.toString().indexOf('bold')
      view.dispatch({ selection: { anchor: bold, head: bold + 4 } })
    },
    { from, typed },
  )
  await settled(
    `${note.slice(0, typed)}typed ${note.slice(typed, from)}**late**${note.slice(from + 1)}`,
  )
  // The selection made meanwhile stays on its text.
  const selected = await page.evaluate(() => {
    const { state } = document.querySelector('.rich-pane .cm-content').cmTile
      .root.view
    return state.sliceDoc(state.selection.main.from, state.selection.main.to)
  })
  assert.equal(selected, 'bold')
  await clipboardEvent('paste', 0, null, { 'text/plain': note })
  await settled(note)
})

test('html paste preserves code padding, Unicode spaces and literal heading markers', {
  timeout: 60000,
}, async (t) => {
  for (const [name, html, selector, expected] of [
    ['code outer spaces', '<p><code> x </code></p>', 'code', ' x '],
    ['all-space code', '<p><code>   </code></p>', 'code', '   '],
    ['code in heading', '<h2><code> x </code> #</h2>', 'h2', ' x  #'],
    [
      'code in table',
      '<table><tr><th><code> x </code></th></tr></table>',
      'th code',
      ' x ',
    ],
    ['styled Unicode spaces', '<p><em>&nbsp;x　</em></p>', 'em', '\u00a0x　'],
    [
      'nonbreaking spaces',
      '<p>&nbsp;a&nbsp;b&nbsp;</p>',
      'p',
      '\u00a0a\u00a0b\u00a0',
    ],
    ['ideographic spaces', '<p>　a　b　</p>', 'p', '　a　b　'],
    ['heading hash', '<h2>section #</h2>', 'h2', 'section #'],
    [
      'backtick language',
      '<pre><code class="language-x`y">hello</code></pre>',
      'pre code',
      'hello\n',
    ],
    [
      'tilde body',
      '<pre><code class="language-x`y">~~~\nhello\n</code></pre>',
      'pre code',
      '~~~\nhello\n',
    ],
  ]) {
    await t.test(name, async () => {
      try {
        await clipboardEvent('paste', note.length, note.length, {
          'text/html': html,
        })
        await waitForAsync(
          page,
          async (length) =>
            (await window.hibi.getDocument()).markdown.length > length,
          note.length,
        )
        const inserted = (await markdown()).slice(note.length)
        const rendered = marked.parse(inserted)
        const actual = await page.evaluate(
          ({ rendered, selector }) =>
            new DOMParser()
              .parseFromString(rendered, 'text/html')
              .querySelector(selector)?.textContent,
          { rendered, selector },
        )
        assert.equal(actual, expected, inserted)
      } finally {
        await setFixture(note)
      }
    })
  }
})

test('a leading language marker cannot extend a code fence or swallow following text', {
  timeout: 30000,
}, async () => {
  try {
    await clipboardEvent('paste', note.length, note.length, {
      'text/html':
        '<pre><code class="language-~x`y">hello</code></pre><p>after</p>',
    })
    await waitForAsync(
      page,
      async (length) =>
        (await window.hibi.getDocument()).markdown.length > length,
      note.length,
    )
    const rendered = marked.parse((await markdown()).slice(note.length))
    const actual = await page.evaluate((rendered) => {
      const body = new DOMParser().parseFromString(rendered, 'text/html').body
      return {
        code: body.querySelector('pre code')?.textContent,
        paragraphs: [...body.querySelectorAll('p')].map(
          (node) => node.textContent,
        ),
      }
    }, rendered)
    assert.deepEqual(actual, { code: 'hello\n', paragraphs: ['after'] })
  } finally {
    await setFixture(note)
  }
})

test('queued html pastes preserve event order with selection and intervening typing', {
  timeout: 30000,
}, async (t) => {
  for (const [name, selected, intervening, expected] of [
    ['same caret', false, '', 'Xfirstsecond'],
    ['same selection', true, '', 'Xfirstsecond'],
    ['intervening typing', false, 'typed', 'Xfirsttypedsecond'],
    ['intervening plain paste', false, 'plain', 'Xfirstplainsecond'],
  ]) {
    await t.test(name, async () => {
      try {
        await setFixture(selected ? 'XYZ' : 'X')
        await page.evaluate(
          ({ selected, intervening }) => {
            const view = document.querySelector('.rich-pane .cm-content').cmTile
              .root.view
            view.dispatch({ selection: { anchor: 1, head: selected ? 3 : 1 } })
            const paste = (text, html = true) => {
              const data = new DataTransfer()
              data.setData(
                html ? 'text/html' : 'text/plain',
                html ? `<p>${text}</p>` : text,
              )
              view.contentDOM.dispatchEvent(
                new ClipboardEvent('paste', {
                  clipboardData: data,
                  bubbles: true,
                  cancelable: true,
                }),
              )
            }
            paste('first')
            if (intervening === 'typed')
              view.dispatch({
                changes: { from: 1, insert: 'typed' },
                selection: { anchor: 6 },
                userEvent: 'input.type',
              })
            if (intervening === 'plain') paste('plain', false)
            paste('second')
          },
          { selected, intervening },
        )
        await waitForAsync(page, async () => {
          const text = (await window.hibi.getDocument()).markdown
          return text.includes('second')
        })
        assert.equal(await markdown(), expected)
      } finally {
        await setFixture(note)
      }
    })
  }
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
  const all = await clipboardEvent('copy', 0, null)
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
