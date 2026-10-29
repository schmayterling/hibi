import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { parser as markdownParser } from '@lezer/markdown'
import { marked } from 'marked'
import { after, before, electron, waitForDocumentEditor } from './electron.mjs'
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

/** Copied html, parsed: its elements as `name attribute=value…`, and its text. */
const copiedDom = (html) =>
  page.evaluate((html) => {
    const { body } = new DOMParser().parseFromString(html, 'text/html')
    return {
      elements: [...body.querySelectorAll('*')].map((element) =>
        [
          element.localName,
          ...[...element.attributes].map(
            ({ name, value }) => `${name}=${value}`,
          ),
        ].join(' '),
      ),
      text: body.textContent,
    }
  }, html)
/** The elements a copy of raw html may hold: its wrapper, paragraphs and literal text. */
const literalElements =
  /^(?:div data-hibi-markdown=|p|div class=hibi-literal-block|span class=hibi-literal-inline)$/

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
  const copiedUnsafe = await readClipboard()
  assert.equal(copiedUnsafe.text, unsafe)
  // Raw HTML copies as literal text, not as elements.
  const copiedRaw = await copiedDom(copiedUnsafe.html)
  for (const element of copiedRaw.elements)
    assert.match(element, literalElements)
  assert.deepEqual(copiedRaw.text.trim().split('\n'), unsafe.split('\n\n'))
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
  // A selection this large copies its Markdown as text only.
  assert.equal(copied.html.length, 0)
  await undo()
  await settled(note)
})

test('copy renders html for selections up to 256 KiB and copies larger ones as text only', {
  timeout: 60000,
}, async () => {
  const limit = 256 * 1024
  const text = `${'clipboard text '.repeat(70)}\n`.repeat(256)
  assert.ok(text.length > limit)
  try {
    await setFixture(text)
    const within = await clipboardEvent('copy', 0, limit)
    assert.equal(within.text, text.slice(0, limit))
    assert.match(within.html, /^<div data-hibi-markdown><p>clipboard text/)
    const above = await clipboardEvent('copy', 0, limit + 1)
    assert.equal(above.handled, true)
    assert.equal(above.text, text.slice(0, limit + 1))
    assert.equal(above.html.length, 0)
    // Cut takes the same text in one undoable edit.
    const cut = await clipboardEvent('cut', 0, null)
    assert.deepEqual([cut.text === text, cut.html.length], [true, 0])
    await settled('')
    await undo()
    await settled(text)
  } finally {
    await setFixture(note)
  }
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
  // Raw HTML copies as the literal text the formatted view shows; Markdown
  // links still render, without script destinations.
  const copied = await copiedDom(html)
  for (const element of copied.elements)
    assert.match(element, element === 'a' ? /^a$/ : literalElements)
  assert.ok(copied.elements.includes('a'))
  assert.deepEqual(copied.text.trim().split('\n'), [
    '<script>document.body.dataset.copied = "script"</script>',
    '<img src="x.png" onerror="document.body.dataset.copied = \'image\'">',
    'bad <a href="javascript:alert(2)" onclick="alert(3)">raw</a>',
  ])
  await undo()
  await settled(note)
})

test('copied raw html, raw-text bodies included, is its literal source', {
  timeout: 30000,
}, async () => {
  try {
    for (const source of [
      'a <code><img/src=x onerror=alert(1)></code> b',
      'a <pre><svg/onload=alert(1)></pre> b',
      'a <kbd>&lt;b&gt; <a href=javascript:alert(1)>x</a></kbd> b',
      'a <script><img/src=x onerror=alert(1)></script> b',
      'a <style>p { color: red }</style> b',
      'a <textarea><img src=x></textarea> b',
      'a <img/src=x onerror=alert(1)> b',
      'a <img src = x onerror = "alert(1)"> b',
      'a <img src=x title="a>b" onerror=alert(1)> b',
      '<div>\n<pre><img src=x onerror=alert(1)></pre>\n</div>',
    ]) {
      await setFixture(source)
      const { html } = await clipboardEvent('copy', 0, null)
      const copied = await copiedDom(html)
      for (const element of copied.elements)
        assert.match(element, literalElements, source)
      assert.equal(copied.text.trim(), source)
    }
    // Image descriptions stay plain text.
    await setFixture('![before <kbd>x</kbd> after](image.png)')
    const image = await clipboardEvent('copy', 0, null)
    assert.equal(
      await page.evaluate(
        (html) =>
          new DOMParser()
            .parseFromString(html, 'text/html')
            .querySelector('img')?.alt,
        image.html,
      ),
      'before <kbd>x</kbd> after',
    )
    // Every break the view draws copies as one.
    for (const space of ['', ' ', '\v', '\u00a0', '\u2028']) {
      const source = `a<br${space}/>b`
      await setFixture(source)
      const { html } = await clipboardEvent('copy', 0, null)
      assert.deepEqual(
        (await copiedDom(html)).elements,
        ['div data-hibi-markdown=', 'p', 'br'],
        JSON.stringify(source),
      )
    }
  } finally {
    await setFixture(note)
  }
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

test('typing over the whole selected note replaces its hidden fence too', {
  timeout: 60000,
}, async () => {
  const content = page.locator('.rich-pane .cm-content')
  const fenced = '```js\nconst answer = 42\n```\n\nend'
  const metadata = '---\ntitle: test\n---\n\n'
  try {
    // A typed letter that also starts the note's shown text.
    for (const [text, key, typed] of [
      [fenced, 'x', 'x'],
      [fenced, 'c', 'c'],
      [metadata + fenced, 'x', `${metadata}x`],
    ]) {
      await setFixture(text)
      if (!text.startsWith(metadata)) {
        // As after copying the note, cutting it and undoing the cut.
        assert.equal((await clipboardEvent('copy', 0, null)).text, text)
        await clipboardEvent('cut', 0, null)
        await settled('')
        await undo()
        await settled(text)
      }
      await content.focus()
      await page.keyboard.press(`${mod}+a`)
      // A key as a keyboard sends it, not inserted text.
      await page.keyboard.press(key)
      await settled(typed)
      await undo()
      await settled(text)
    }
  } finally {
    // Frontmatter keeps edits out of itself unless an addon makes them.
    await content.evaluate((element) => {
      const view = element.cmTile.root.view
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length },
        userEvent: 'input.addon',
      })
    })
    await setFixture(note)
  }
})

test('input handlers see typing over the whole selected note', {
  timeout: 60000,
}, async () => {
  const content = page.locator('.rich-pane .cm-content')
  // An input handler that types in capitals, as an addon's can.
  await content.evaluate((element) => {
    const view = element.cmTile.root.view
    const EditorView = view.constructor
    const StateEffect = EditorView.scrollIntoView(0).constructor
    window.upperCalls = []
    window.upperActive = true
    view.dispatch({
      effects: StateEffect.appendConfig.of(
        EditorView.inputHandler.of((view, from, to, text) => {
          if (!window.upperActive) return false
          window.upperCalls.push([from, to, text])
          view.dispatch({
            changes: { from, to, insert: text.toUpperCase() },
            selection: { anchor: from + text.length },
            userEvent: 'input.type',
          })
          return true
        }),
      ),
    })
  })
  try {
    for (const text of ['plain', '```js\nconst answer = 42\n```\n\nend']) {
      await setFixture(text)
      await page.evaluate(() => {
        window.upperCalls = []
      })
      await content.focus()
      await page.keyboard.press(`${mod}+a`)
      await page.keyboard.press('x')
      await settled('X')
      assert.deepEqual(await page.evaluate(() => window.upperCalls), [
        [0, text.length, 'x'],
      ])
      await undo()
      await settled(text)
    }
  } finally {
    await page.evaluate(() => {
      window.upperActive = false
    })
    await setFixture(note)
  }
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
    'Some **bold**, *em*, ~~gone~~, ``a`b`` and [link](https://x.test/a%20b).  \nnext \\*star\\*',
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

test('html in a native clipboard envelope pastes only its fragment, in its context', {
  timeout: 30000,
}, async () => {
  const at = note.length
  const start = '<!--StartFragment-->',
    end = '<!--EndFragment-->'
  const wrap = (body) =>
    `<html>\r\n<head><meta charset="utf-8"></head>\r\n<body>\r\n${body}\r\n</body>\r\n</html>`
  for (const [html, expected] of [
    // Multibyte text before and inside the fragment markers.
    [
      wrap(
        `<p>outside é</p><ul><li>outside 😀</li>${start}<li>in é</li><li>中 😀</li>${end}<li>after</li></ul><p>after 😀</p>`,
      ),
      '- in é\n- 中 😀',
    ],
    [
      wrap(`<p>before é ${start}<strong>bold</strong> 中 😀${end} after</p>`),
      '**bold** 中 😀',
    ],
    // Ordered items keep their numbers.
    [
      wrap(
        `<ol start="3"><li>before</li>${start}<li>in</li>${end}<li>after</li></ol>`,
      ),
      '4. in',
    ],
    // As in Chromium, the first start and the last end mark it.
    [
      wrap(
        `${start}<p>one</p>${start}<p>two</p>${end}<p>three</p>${end}<p>after</p>`,
      ),
      'one\n\ntwo\n\nthree',
    ],
    // Look-alike declarations parse to the same comments but mark nothing.
    [
      wrap(
        `<p>before</p><!StartFragment><p>between</p>${start}<p>in</p><!EndFragment><p>still in</p>${end}<p>after</p>`,
      ),
      'in\n\nstill in',
    ],
    // Markers before the body still mark it.
    [`${start}<p>in</p>${end}<p>after</p>`, 'in'],
    [`<meta charset="utf-8">${start}<p>in</p>${end}<p>after</p>`, 'in'],
  ]) {
    await clipboardEvent('paste', at, at, {
      'text/html': html,
      'text/plain': 'ignored',
    })
    await settled(note + expected)
    await undo()
    await settled(note)
  }
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

test('pasted web links open the browser target and relative urls keep local handling', {
  timeout: 30000,
}, async (t) => {
  await app.evaluate(({ shell }) => {
    globalThis.clipboardOpenExternal = shell.openExternal
    globalThis.clipboardOpened = []
    shell.openExternal = async (href) => {
      globalThis.clipboardOpened.push(href)
    }
  })
  try {
    for (const [href, expected] of [
      [String.raw`https://x.test/a\b`, 'https://x.test/a/b'],
      [String.raw`http://x.test/a\b`, 'http://x.test/a/b'],
      ['https://x.test/a%5Cb', 'https://x.test/a%5Cb'],
      [String.raw`missing\note.md`, null],
      [String.raw`//x.test/a\b`, null],
    ]) {
      await t.test(href, async () => {
        try {
          await app.evaluate(() => {
            globalThis.clipboardOpened = []
          })
          await clipboardEvent('paste', 0, null, {
            'text/html': `<p><a href="${href}">target</a> tail</p>`,
          })
          await waitForAsync(page, async () =>
            (await window.hibi.getDocument()).markdown.startsWith('[target]'),
          )
          if (expected) {
            await page.locator('.hibi-lp-link').click({ modifiers: ['Shift'] })
            await waitForAsync(app, () => globalThis.clipboardOpened.length > 0)
          } else {
            const target = marked.lexer(await markdown())[0].tokens[0].href
            assert.equal(target, href.replace(/\\/g, '%5C'))
            await assert.rejects(
              page.evaluate(
                async (href) =>
                  window.hibi.openDocumentLink(
                    href,
                    (await window.hibi.getDocument()).revision,
                  ),
                target,
              ),
            )
          }
          assert.deepEqual(
            await app.evaluate(() => globalThis.clipboardOpened),
            expected ? [expected] : [],
          )
        } finally {
          await setFixture(note)
        }
      })
    }
  } finally {
    await app.evaluate(({ shell }) => {
      shell.openExternal = globalThis.clipboardOpenExternal
      delete globalThis.clipboardOpenExternal
      delete globalThis.clipboardOpened
    })
  }
})

test('pasted link and image urls stay destinations through line breaks, controls and backslashes', {
  timeout: 60000,
}, async (t) => {
  for (const [name, html, expected, urls] of [
    [
      'line break',
      '<p><a href="a&#10;onclick=x">t</a> tail</p>',
      '[t](aonclick=x) tail',
      ['aonclick=x'],
    ],
    [
      'tab and carriage return',
      '<p><a href="https://x.test/a&#9;b&#13;c">t</a></p>',
      '[t](https://x.test/abc)',
      ['https://x.test/abc'],
    ],
    [
      'backslash before the closing angle bracket',
      '<p><a href="x onclick=y\\">t</a></p>',
      '[t](<x onclick=y%5C>)',
      ['x%20onclick=y%5C'],
    ],
    [
      'backslash before the closing parenthesis',
      '<p><a href="https://x.test/a\\">t</a> b</p>',
      '[t](https://x.test/a/) b',
      ['https://x.test/a/'],
    ],
    [
      'control character',
      '<p><a href="a&#1;b">t</a></p>',
      '[t](<a\u0001b>)',
      ['a%01b'],
    ],
    [
      'image source and description',
      '<p><img src="pic&#10;.png" alt="a&#10;&#10;b"> c</p>',
      '![a b](pic.png) c',
      ['pic.png'],
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
        assert.equal(inserted, expected)
        // The formatted view reads a link or image, not an html tag.
        const nodes = new Set()
        markdownParser.parse(inserted).iterate({
          enter: ({ name }) => {
            nodes.add(name)
          },
        })
        assert.ok(nodes.has('Link') || nodes.has('Image'), inserted)
        assert.ok(!nodes.has('HTMLTag'), inserted)
        // Exports render the same destination.
        const rendered = marked.parse(inserted)
        const actual = await page.evaluate(
          (rendered) =>
            [
              ...new DOMParser()
                .parseFromString(rendered, 'text/html')
                .querySelectorAll('a, img'),
            ].map(
              (node) => node.getAttribute('href') ?? node.getAttribute('src'),
            ),
          rendered,
        )
        assert.deepEqual(actual, urls)
      } finally {
        await setFixture(note)
      }
    })
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
