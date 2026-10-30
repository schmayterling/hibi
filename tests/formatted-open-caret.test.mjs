import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  electron,
  waitForAsync,
  waitForDocumentEditor,
  waitForFormattedEditor,
} from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

// A note opens with the caret where the rich editor's Selection.atEnd puts
// it: the end of its last text block, inside quotes and lists, in a table's
// last cell and before a closing fence.
const notes = {
  paragraph: 'plain\n\nlast\n',
  'paragraph-no-newline': 'plain\n\nlast',
  'blank-tail-2': 'plain\n\nlast\n\n',
  'blank-tail-3': 'plain\n\nlast\n\n\n',
  'blank-tail-4': 'plain\n\nlast\n\n\n\n',
  heading: 'plain\n\n## Last heading\n',
  'heading-closed': 'plain\n\n## Last heading ##\n',
  setext: 'plain\n\nLast heading\n===\n',
  table: 'plain\n\n| aa   | bb   |\n| ---- | ---- |\n| cell | tail |\n',
  'table-no-closing-pipe':
    'plain\n\n| aa   | bb   |\n| ---- | ---- |\n| cell | tail\n',
  'table-no-closing-pipe-no-newline':
    'plain\n\n| aa   | bb   |\n| ---- | ---- |\n| cell | tail',
  'table-header-only': 'plain\n\n| aa   | bb   |\n| ---- | ---- |\n',
  'table-extra-cell':
    'plain\n\n| aa   | bb   |\n| ---- | ---- |\n| cell | tail | more |\n',
  'table-empty-cell':
    'plain\n\n| aa   | bb   |\n| ---- | ---- |\n| cell |      |\n',
  'table-blank-tail':
    'plain\n\n| aa   | bb   |\n| ---- | ---- |\n| cell | tail |\n\n\n',
  fenced: 'plain\n\n```js\nconst a = 1\nlast()\n```\n',
  'fenced-tilde': 'plain\n\n~~~\ncode\nlast\n~~~\n',
  'fenced-unclosed': 'plain\n\n```\ncode\nlast\n',
  quote: 'plain\n\n> quoted\n> last\n',
  'quote-marker-tail': 'plain\n\n> last\n>\n',
  'quote-table':
    'plain\n\n> | aa   | bb   |\n> | ---- | ---- |\n> | cell | tail |\n',
  'quote-table-no-closing-pipe':
    'plain\n\n> | aa   | bb   |\n> | ---- | ---- |\n> | cell | tail\n',
  'quote-code': 'plain\n\n> ```\n> code\n> last\n> ```\n',
  alert: 'plain\n\n> [!NOTE]\n> last\n',
  list: 'plain\n\n- one\n- last\n',
  'list-nested': 'plain\n\n- one\n  - two\n    - last\n',
  ordered: 'plain\n\n1. one\n2. last\n',
  tasks: 'plain\n\n- [ ] one\n- [x] last\n',
  'list-empty-item': 'plain\n\n- one\n-\n',
  'list-table':
    'plain\n\n- item\n\n  | aa   | bb   |\n  | ---- | ---- |\n  | cell | tail |\n',
  'list-table-no-closing-pipe':
    'plain\n\n- item\n\n  | aa   | bb   |\n  | ---- | ---- |\n  | cell | tail\n',
  'list-quote-table':
    'plain\n\n- item\n\n  > | aa   | bb   |\n  > | ---- | ---- |\n  > | cell | tail |\n',
  'list-code': 'plain\n\n- item\n\n  ```\n  code\n  last\n  ```\n',
  definition: 'plain\n\n[a]: https://example.test\n',
  frontmatter: '---\ntitle: last\n---\n',
  'frontmatter-paragraph': '---\ntitle: x\n---\n\nlast\n',
  empty: '',
  blank: '\n\n',
  // Taller than the pane; they open at their top, also where the cell's
  // editor puts the caret in the middle of an empty cell's padding.
  'tall-table': `${'line\n\n'.repeat(60)}| aa   | bb   |\n| ---- | ---- |\n| cell | tail |\n`,
  'tall-table-empty-cell': `${'line\n\n'.repeat(60)}| aa   | bb   |\n| ---- | ---- |\n| cell |      |\n`,
  'tall-table-empty-odd-cell': `${'line\n\n'.repeat(60)}| aa   | bb   |\n| ---- | ---- |\n| cell |   |\n`,
  // Accepted differences, below.
  html: 'plain\n\n<div>\nlast\n</div>\n',
  'html-comment': 'plain\n\n<!-- last -->\n',
  math: 'plain\n\n$$\nx^2\n$$\n',
  mermaid: 'plain\n\n```mermaid\ngraph TD\n  A --> B\n```\n',
  typst: 'plain\n\n```typst\n= last\n```\n',
  rule: 'plain\n\n***\n',
  divider: 'plain\n\n---\n',
  image: 'plain\n\n![last](missing.png)\n',
  'table-short-row': 'plain\n\n| aa   | bb   |\n| ---- | ---- |\n| cell |\n',
  indented: 'plain\n\n    code\n    last\n',
  'fenced-empty': 'plain\n\n```\n```\n',
  long: `${'line\n\n'.repeat(20000)}\`\`\`\ncode\nlast\n\`\`\`\n`,
  'long-table': `${'line\n\n'.repeat(20000)}| aa   | bb   |\n| ---- | ---- |\n| cell | tail |\n`,
  'long-mermaid': `${'line\n\n'.repeat(20000)}\`\`\`mermaid\ngraph TD\n  A --> B\n\`\`\`\n`,
  footnote: 'plain[^1]\n\n[^1]: last\n',
}

/*
 * Each engine's own outcome where they differ (open-001 to open-004 in
 * formatted-engine-gaps.md). 'end' is the end of the note's text, where the
 * formatted view keeps the caret until its view reaches the note's end. A
 * block the rich editor node-selects is selected whole in the formatted
 * view: 'block', from its first character to its last.
 */
const node = { selection: 'node' }
const atoms = [
  'html',
  'html-comment',
  'math',
  'mermaid',
  'typst',
  'rule',
  'divider',
  'image',
]
const accepted = {
  ...Object.fromEntries(
    atoms.map((name) => [name, { native: node, codemirror: 'block' }]),
  ),
  'table-short-row': {
    native: { cell: [1, 1], code: false, text: ['', ''] },
    codemirror: { cell: [1, 0], code: false, text: ['cell', ''] },
  },
  indented: {
    native: { cell: null, code: true, text: ['', ''] },
    codemirror: { cell: null, code: true, text: ['last', ''] },
  },
  'fenced-empty': {
    native: { cell: null, code: true, text: ['', ''] },
    codemirror: { cell: null, code: false, text: ['', ''] },
  },
  // The end may be parsed and drawn by the first paint on a fast machine.
  long: { codemirror: 'end or native' },
  'long-table': { codemirror: 'end or native' },
  'long-mermaid': { native: node, codemirror: 'end or block' },
  // The rich editor opens a note with footnotes beside its source, read-only.
  footnote: {
    native: { focus: 'source view' },
    codemirror: { cell: null, code: false, text: ['last', ''] },
  },
}

// Where the caret is, read from the DOM in terms both engines share.
function caret() {
  const roots = [
    ...document.querySelectorAll('.rich-pane [aria-label="Document editor"]'),
  ]
  const active = document.activeElement
  const root =
    roots.find((root) => root.contains(active)) ??
    roots.find((root) => root.getClientRects().length)
  const clean = (fragment) => {
    for (const node of fragment.querySelectorAll?.(
      '.hibi-lp-marker, .cm-placeholder, [aria-hidden="true"], label',
    ) ?? [])
      node.remove()
    return fragment.textContent ?? ''
  }
  const selection = getSelection()
  const node = selection?.focusNode,
    offset = selection?.focusOffset ?? 0
  const element =
    node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement
  const cell = element?.closest('td, th')
  const block =
    cell ??
    element?.closest('.cm-line, p, h1, h2, h3, h4, h5, h6, pre, li') ??
    null
  let text = null
  if (block && root?.contains(block)) {
    const before = document.createRange(),
      after = document.createRange()
    before.selectNodeContents(block)
    before.setEnd(node, offset)
    after.selectNodeContents(block)
    after.setStart(node, offset)
    // The formatted view draws each line of code apart.
    text = [
      clean(before.cloneContents()).split('\n').at(-1),
      clean(after.cloneContents()).split('\n')[0],
    ]
  }
  return {
    focus: root?.contains(active) ? 'editor' : 'outside',
    cell: cell ? [cell.parentElement.rowIndex, cell.cellIndex] : null,
    code: !!element?.closest('pre, .hibi-lp-codeblock'),
    text,
    selection: root?.editor?.state.selection.toJSON().type,
    anchor: root?.cmTile?.root.view.state.selection.main.anchor,
    head: root?.cmTile?.root.view.state.selection.main.head,
    top: root?.closest('.rich-pane')?.scrollTop,
  }
}

const native = new Map()
{
  test(`codemirror: a note opens with the caret at the end of its last text`, {
    timeout: 600000,
  }, async (t) => {
    const folder = await mkdtemp(join(tmpdir(), 'hibi-open-caret-'))
    const profile = join(folder, 'profile')
    await mkdir(profile)
    await writeFile(
      join(profile, 'addons.json'),
      JSON.stringify({ math: true, typst: true }),
    )
    const app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${profile}`],
    })
    t.after(async () => {
      await app.close()
      await rm(folder, { recursive: true, force: true })
    })
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    const page = await app.firstWindow()
    page.setDefaultTimeout(10000)
    await waitForFormattedEditor(app, page)
    const session = await page.context().newCDPSession(page)
    await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    const open = async (name, markdown) => {
      const file = join(folder, `${name}.md`)
      await writeFile(file, markdown)
      await app.evaluate(({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [file],
        })
      }, file)
      await clickMenu(app, 'Open…')
      await waitForAsync(
        page,
        async (name) => (await window.hibi.getDocument()).name === name,
        `${name}.md`,
      )
      // The rich editor opens a note it cannot show in or beside its source.
      const shown = await (
        await page.waitForFunction(() => {
          const panel = document.querySelector(
            '.app[aria-busy="false"] #document-editor-panel[aria-busy="false"]',
          )
          if (!panel) return false
          const editable = panel.querySelectorAll(
            '.rich-pane [aria-label="Document editor"][contenteditable="true"]',
          )
          if (
            [...editable].some(
              (element) =>
                element.getClientRects().length && !element.closest('[inert]'),
            )
          )
            return 'rich'
          return panel.querySelector(
            '.editor-panes.mode-markdown, .editor-panes.mode-side-by-side',
          )
            ? 'source'
            : false
        })
      ).jsonValue()
      if (shown === 'source') return { focus: 'source view' }
      await waitForDocumentEditor(app, page)
      // The first note a new window opens may not take focus.
      await page
        .waitForFunction(
          () => document.activeElement?.closest('.rich-pane'),
          null,
          { timeout: 3000 },
        )
        .catch(() => {})
      // The formatted view's table opens its cell editor after its focus update.
      let last = null
      for (let read = 0; read < 30; read++) {
        await page.waitForTimeout(100)
        const now = await page.evaluate(caret)
        if (JSON.stringify(now) === JSON.stringify(last)) return now
        last = now
      }
      return last
    }
    await open('warmup', 'warmup\n')
    const key = ({ focus, cell, code, text }) =>
      focus === 'editor' ? { cell, code, text } : { focus }
    const differences = []
    const check = (name, actual, want) => {
      if (JSON.stringify(actual) !== JSON.stringify(want))
        differences.push(
          `${name}: ${JSON.stringify(actual)} != ${JSON.stringify(want)}`,
        )
    }
    for (const [name, markdown] of Object.entries(notes)) {
      const observed = await open(name, markdown)
      t.diagnostic(JSON.stringify({ engine: 'codemirror', name, ...observed }))
      const expected = accepted[name]?.['codemirror']
      const end = markdown.trimEnd().length
      const block = [markdown.lastIndexOf('\n\n', end) + 2, end]

      if (expected === node)
        check(name, { selection: observed.selection }, node)
      else if (expected === 'block')
        check(name, [observed.anchor, observed.head], block)
      else if (expected === 'end or block') {
        if (observed.head !== end)
          check(name, [observed.anchor, observed.head], block)
      } else if (expected === 'end or native') {
        if (observed.head !== end) check(name, key(observed), native.get(name))
      } else if (expected) check(name, key(observed), expected)
      else check(name, key(observed), native.get(name))
      // Wherever its caret is, a note opens at its top.
      if (observed.focus === 'editor')
        check(name, { name, top: observed.top }, { name, top: 0 })
    }
    // Typing replaces a selected block, Enter adds a paragraph after it, and
    // Backspace or Delete removes it with the blank line before it. The rich
    // editor's selected rule written other than `---` takes none of them.
    const rendered = { math: 'x^2', mermaid: 'graph TD', typst: '= last' }
    const markdown = () =>
      page.evaluate(async () => (await window.hibi.getDocument()).markdown)
    const inert = (name) => false
    for (const name of atoms)
      for (const press of ['Z', 'Enter', 'Backspace', 'Delete']) {
        const note = notes[name]
        await open(`${name}-${press}`, note)
        if (rendered[name])
          check(
            name,
            {
              name,
              shown: await page.evaluate(
                (text) =>
                  // innerText leaves out hidden source.
                  document
                    .querySelector('.rich-pane .cm-content')
                    // biome-ignore lint/performance/useDomNodeTextContent: shown text only.
                    .innerText.includes(text),
                rendered[name],
              ),
            },
            { name, shown: false },
          )
        await page.keyboard.press(press)
        await page.waitForTimeout(300)
        const after = await markdown()
        const kept = note.trimEnd()
        const want = inert(name)
          ? note
          : press === 'Z'
            ? 'plain\n\nZ\n'
            : press === 'Enter'
              ? `${kept}\n\n`
              : 'plain\n'
        check(name, { name, press, after }, { name, press, after: want })
      }
    // Formatting acts on a selected block as on the rich editor's node
    // selection: a quote wraps it and keeps it selected, a divider goes after
    // it, and the other actions, marks and block types alike, do nothing.
    // Both engines leave the same no-op actions enabled.
    const actions = [
      'bold',
      'heading-1',
      'paragraph',
      'bullet-list',
      'code-block',
      'hard-break',
      'table',
      `${mod}+b`,
      `${mod}+Alt+c`,
      'quote',
      `${mod}+Shift+b`,
      'divider',
    ]
    const enabled = [
      'quote enabled',
      'divider enabled',
      'hard-break enabled',
      'unlink enabled',
      'table enabled',
    ]
    for (const name of atoms) {
      const kept = notes[name].trimEnd()
      for (const action of actions) {
        await open(`${name}-${action.replace(/\W/g, '')}`, notes[name])
        if (action === actions[0]) {
          // The enabled or pressed actions, or whether they are `want`.
          const shown = (want) => {
            const ids = [
              ...document.querySelectorAll(
                '.editor-toolbar [data-toolbar-id^="format."]',
              ),
            ]
              .filter(
                (button) =>
                  !button.disabled ||
                  button.getAttribute('aria-pressed') === 'true',
              )
              .filter(
                (button) =>
                  !['undo', 'redo', 'image'].includes(
                    button.dataset.toolbarId.slice(7),
                  ),
              )
              .map(
                (button) =>
                  `${button.dataset.toolbarId.slice(7)}${button.disabled ? '' : ' enabled'}${button.getAttribute('aria-pressed') === 'true' ? ' pressed' : ''}`,
              )
            return want ? JSON.stringify(ids) === JSON.stringify(want) : ids
          }
          // The toolbar refreshes after a paint.
          await page
            .waitForFunction(shown, enabled, { timeout: 3000 })
            .catch(() => {})
          check(name, await page.evaluate(shown, null), enabled)
        }
        if (action.includes('+')) await pressShortcut(app, action)
        else
          await page
            .locator(`.editor-toolbar [data-toolbar-id="format.${action}"]`)
            .evaluate((button) => {
              // A disabled action runs nothing either. React keeps the
              // attribute it last wrote, so it is put back.
              const disabled = button.disabled
              button.disabled = false
              button.click()
              button.disabled = disabled
            })
        await page.waitForTimeout(300)
        const quote = action === 'quote' || action === `${mod}+Shift+b`
        const changed = inert(name)
          ? quote
            ? `plain\n\n> ${kept.slice(7)}\n`
            : notes[name]
          : quote
            ? `plain\n\n${kept
                .slice(7)
                .split('\n')
                .map((line) => `> ${line}`)
                .join('\n')}\n`
            : action === 'divider'
              ? `${kept}\n\n---\n\n\n`
              : notes[name]
        check(
          name,
          { name, action, after: await markdown() },
          { name, action, after: changed },
        )
        if (action !== 'quote' && action !== 'divider') continue
        await page.keyboard.press('Z')
        await page.waitForTimeout(300)
        const typed = inert(name)
          ? changed
          : action === 'quote'
            ? 'plain\n\n> Z\n'
            : `${kept}\n\n---\n\nZ\n`
        check(
          name,
          { name, action, typed: await markdown() },
          { name, action, typed },
        )
      }
    }
    // The formatted view moves the caret where the rich editor puts it once
    // its view reaches a long note's end, unless the user moved it first.
    for (const [name, moved] of [
      ['long', false],
      ['long-table', false],
      ['long-mermaid', false],
      ['long', true],
    ]) {
      const markdown = notes[name]
      await open(`${name}-scrolled${moved ? '-moved' : ''}`, markdown)
      const end = markdown.trimEnd().length
      if (moved) await page.keyboard.press('ArrowLeft')
      const before = await page.evaluate(caret)
      await page.evaluate(() => {
        const pane = document.querySelector('.rich-pane')
        pane.scrollTop = pane.scrollHeight
      })
      let last = null
      for (let read = 0; read < 30; read++) {
        await page.waitForTimeout(100)
        const now = await page.evaluate(caret)
        if (JSON.stringify(now) === JSON.stringify(last)) break
        last = now
      }
      t.diagnostic(
        JSON.stringify({ engine: 'codemirror', name, moved, ...last }),
      )
      if (moved)
        check(name, { name, head: last.head }, { name, head: before.head })
      else if (name === 'long-mermaid')
        check(
          name,
          [last.anchor, last.head],
          [markdown.lastIndexOf('\n\n', end) + 2, end],
        )
      else check(name, key(last), native.get(name))
    }
    // Undo can bring back the selection a note opened with, but the reader
    // has been there since: the cell it lands in is shown, as after any undo.
    const note = `${'line\n\n'.repeat(60)}| aa | bb |\n| -- | -- |\n${Array.from(
      { length: 80 },
      (_, row) => `| r${row} | v${row} |`,
    ).join('\n')}\n`
    const rows = async (count) =>
      (await window.hibi.getDocument()).markdown
        .split('\n')
        .filter((line) => line.startsWith('|')).length === count
    await open('tall-table-undo', note)
    // Tab in the last cell adds a row.
    await page.keyboard.press('Tab')
    await waitForAsync(page, rows, 83)
    await page.evaluate(() => {
      document.querySelector('.rich-pane').scrollTop = 0
    })
    await page.keyboard.press('ControlOrMeta+z')
    await waitForAsync(page, rows, 82)
    let last = null
    for (let read = 0; read < 30; read++) {
      await page.waitForTimeout(100)
      const now = await page.evaluate(() => {
        const shown = document
          .querySelector('.rich-pane')
          .getBoundingClientRect()
        const cell = document.activeElement?.closest('td, th')
        const box = cell?.getBoundingClientRect()
        return {
          cell: cell ? [cell.parentElement.rowIndex, cell.cellIndex] : null,
          shown:
            !!box && box.top >= shown.top - 1 && box.bottom <= shown.bottom + 1,
        }
      })
      if (JSON.stringify(now) === JSON.stringify(last)) break
      last = now
    }
    t.diagnostic(
      JSON.stringify({
        engine: 'codemirror',
        name: 'tall-table-undo',
        ...last,
      }),
    )
    check('tall-table-undo', last, { cell: [80, 1], shown: true })
    assert.deepEqual(differences, [])
  })
}

// A note opens at its top: the caret it opens with is not where the reader
// is, so diagrams drawn above it keep the top in place. The Mermaid language
// and renderer are held until the caret is placed, and the pane is made a
// little shorter than the note, so the formatted view reads where the reader
// is while the caret is still on screen above the diagrams' placeholders, as
// when they load late.
test('a note opens at its top while diagrams above its caret draw', {
  timeout: 120000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-open-top-'))
  const profile = join(folder, 'profile')
  await mkdir(profile)
  const file = join(folder, 'diagrams.md')
  const markdown =
    '# Diagrams\n\nText before.\n\n```mermaid\ngraph TD\n  A[One] --> B[Two]\n  B --> C[Three]\n  C --> D[Four]\n  D --> E[Five]\n  E --> F[Six]\n```\n\nBetween.\n\n```mermaid\ngraph TD\n  G[Seven] --> H[Eight]\n  H --> I[Nine]\n```\n\nAfter.\n'
  await writeFile(file, markdown)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(30000)
  await waitForFormattedEditor(app, page)
  const chunks = JSON.parse(
    await readFile('out/renderer/startup-bundle.json', 'utf8'),
  )
  const held = [
    'src/addons/mermaid/language.ts',
    'node_modules/pele/dist/esm/lazy.js',
  ].map((module) => {
    // A linked dependency install names its modules by their real path.
    const chunk = chunks.find((chunk) =>
      chunk.modules.some((id) => id === module || id.endsWith(`/${module}`)),
    )
    return `/${chunk.file}`
  })
  await app.evaluate(({ app, protocol, net }, held) => {
    const { join } = process.getBuiltinModule('node:path')
    const { pathToFileURL } = process.getBuiltinModule('node:url')
    globalThis.chunkGates = Object.fromEntries(
      held.map((path) => {
        const gate = { entered: false }
        gate.ready = new Promise((resolve) => {
          gate.release = resolve
        })
        return [path, gate]
      }),
    )
    protocol.unhandle('app')
    protocol.handle('app', async (request) => {
      const { pathname } = new URL(request.url)
      const gate = globalThis.chunkGates[pathname]
      if (gate) {
        gate.entered = true
        await gate.ready
      }
      return net.fetch(
        pathToFileURL(
          join(
            app.getAppPath(),
            'out/renderer',
            pathname === '/' ? 'index.html' : pathname,
          ),
        ).href,
      )
    })
  }, held)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  await page.reload({ waitUntil: 'commit' })
  await waitForDocumentEditor(app, page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    })
  }, file)
  await clickMenu(app, 'Open…')
  const end = markdown.trimEnd().length
  const place = () =>
    page.evaluate(() => {
      const pane = document.querySelector('.rich-pane')
      const content = pane.querySelector('.hibi-formatted .cm-content')
      const view = content.cmTile.root.view
      const { head } = view.state.selection.main
      const caret = view.coordsAtPos(head)
      const shown = pane.getBoundingClientRect()
      return {
        top: pane.scrollTop,
        height: pane.scrollHeight,
        client: pane.clientHeight,
        content: view.contentHeight,
        head,
        focused: view.hasFocus,
        caretShown:
          !!caret && caret.top >= shown.top && caret.bottom <= shown.bottom,
        drawn: content.querySelectorAll('.mermaid-diagram svg').length,
      }
    })
  await page.waitForFunction(
    (end) =>
      document.querySelector('.rich-pane .hibi-formatted .cm-content')?.cmTile
        ?.root.view.state.selection.main.head === end,
    end,
  )
  for (let read = 0; ; read++) {
    const entered = await app.evaluate(() =>
      Object.values(globalThis.chunkGates).every((gate) => gate.entered),
    )
    if (entered) break
    assert.ok(read < 100, 'the Mermaid language and renderer are requested')
    await page.waitForTimeout(100)
  }
  const shown = await place()
  const target = Math.floor(shown.content) - 8
  await app.evaluate(({ BrowserWindow }, by) => {
    const window = BrowserWindow.getAllWindows().find((window) =>
      window.webContents.getURL().startsWith('app://hibi/'),
    )
    const [width, height] = window.getContentSize()
    window.setContentSize(width, height - by)
  }, shown.client - target)
  await page.waitForFunction(
    (target) => document.querySelector('.rich-pane').clientHeight === target,
    target,
  )
  await page.waitForTimeout(300)
  const opened = await place()
  t.diagnostic(JSON.stringify({ shown, opened }))
  // The diagrams draw only once their renderer arrives, and the caret is on
  // screen above their placeholders in a pane that scrolls.
  assert.equal(opened.head, end, JSON.stringify(opened))
  assert.equal(opened.drawn, 0, JSON.stringify(opened))
  assert.ok(opened.height > opened.client, JSON.stringify(opened))
  assert.ok(opened.caretShown, JSON.stringify(opened))
  const release = (path) =>
    app.evaluate(
      (_electron, path) => globalThis.chunkGates[path].release(),
      path,
    )
  await release(held[0])
  await page.waitForTimeout(500)
  await release(held[1])
  await page.waitForFunction(
    () =>
      document.querySelectorAll(
        '.rich-pane .hibi-formatted .mermaid-diagram svg',
      ).length === 2,
  )
  let drawn = await place()
  for (let read = 0; read < 20; read++) {
    await page.waitForTimeout(100)
    const now = await place()
    if (JSON.stringify(now) === JSON.stringify(drawn) && read >= 5) break
    drawn = now
  }
  t.diagnostic(JSON.stringify({ drawn }))
  // The drawn note is taller than the pane, so it could have scrolled.
  assert.ok(drawn.height > drawn.client + 100, JSON.stringify(drawn))
  assert.deepEqual(
    { top: drawn.top, head: drawn.head, focused: drawn.focused },
    { top: 0, head: end, focused: true },
  )
})
