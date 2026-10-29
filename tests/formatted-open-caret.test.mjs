import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForAsync, waitForDocumentEditor } from './electron.mjs'
import { selectFormattedEngine } from './formatted-engine.mjs'
import { clickMenu } from './keyboard.mjs'

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
  // Accepted differences, below.
  html: 'plain\n\n<div>\nlast\n</div>\n',
  'html-comment': 'plain\n\n<!-- last -->\n',
  math: 'plain\n\n$$\nx^2\n$$\n',
  mermaid: 'plain\n\n```mermaid\ngraph TD\n  A --> B\n```\n',
  typst: 'plain\n\n```typst\n= last\n```\n',
  rule: 'plain\n\n***\n',
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
  }
}

const native = new Map()
for (const engine of ['tiptap', 'codemirror'])
  test(`${engine}: a note opens with the caret at the end of its last text`, {
    timeout: 300000,
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
    await selectFormattedEngine(app, page, engine)
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
      t.diagnostic(JSON.stringify({ engine, name, ...observed }))
      const expected =
        accepted[name]?.[engine === 'tiptap' ? 'native' : 'codemirror']
      const end = markdown.trimEnd().length
      const block = [markdown.lastIndexOf('\n\n', end) + 2, end]
      if (engine === 'tiptap') native.set(name, key(observed))
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
      else if (engine === 'codemirror')
        check(name, key(observed), native.get(name))
    }
    // Typing replaces a selected block, and Enter adds a paragraph after it.
    // The rich editor's selected divider takes no keys.
    const rendered = { math: 'x^2', mermaid: 'graph TD', typst: '= last' }
    for (const name of atoms)
      for (const press of ['Z', 'Enter']) {
        const markdown = notes[name]
        await open(`${name}-${press}`, markdown)
        if (engine === 'codemirror' && rendered[name])
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
        const after = await page.evaluate(
          async () => (await window.hibi.getDocument()).markdown,
        )
        const kept = markdown.trimEnd()
        const want =
          engine === 'tiptap' && name === 'rule'
            ? markdown
            : press === 'Z'
              ? `${kept.slice(0, kept.lastIndexOf('\n\n') + 2)}Z\n`
              : `${kept}\n\n`
        check(
          name,
          { name, press, kept: after.startsWith(want) },
          { name, press, kept: true },
        )
        t.diagnostic(JSON.stringify({ engine, name, press, after }))
      }
    // The formatted view moves the caret where the rich editor puts it once
    // its view reaches a long note's end, unless the user moved it first.
    if (engine === 'codemirror')
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
        t.diagnostic(JSON.stringify({ engine, name, moved, ...last }))
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
    assert.deepEqual(differences, [])
  })
