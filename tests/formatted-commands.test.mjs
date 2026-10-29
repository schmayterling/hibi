import assert from 'node:assert/strict'
import test from 'node:test'
import { history, isolateHistory, redo, undo } from '@codemirror/commands'
import { EditorSelection, EditorState } from '@codemirror/state'
import { Decoration, WidgetType } from '@codemirror/view'
import { NodeType, Tree } from '@lezer/common'
import { GFM, parser } from '@lezer/markdown'
import { MarkdownManager } from '@tiptap/markdown'
import { ChunkedMarkdownParser } from '../src/renderer/src/chunked-markdown.ts'
import {
  blockBreak,
  blockText,
  codeIndent,
  deleteBackward,
  deleteForward,
  exitBlock,
  gapInput,
  indent,
  lineBreak,
  lineInput,
} from '../src/renderer/src/formatted-commands.ts'
import {
  codeIndentLines,
  detectIndentUnit,
  tabIndent,
} from '../src/renderer/src/indentation.ts'
import { markdownConfiguration } from '../src/renderer/src/markdown.ts'
import { sourceEditorTextCooperatively } from '../src/renderer/src/source-session.ts'
import { Footnotes } from '../src/shared/markdown-extra-syntax.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'

const markdown = parser.configure(GFM)
const hide = Decoration.replace({})
const glyph = Decoration.replace({
  widget: new (class extends WidgetType {
    toDOM() {
      return null
    }
  })(),
})

/**
 * Run a structure command on `doc`, where `|` marks the caret, `⟦` `⟧`
 * enclose syntax the formatted view hides and `⟪` `⟫` text it shows as a
 * widget.
 */
function run(doc, command) {
  const hidden = []
  let text = '',
    caret = 0,
    anchor = null
  for (const char of doc) {
    if (char === '|') caret = text.length
    else if (char === '^') anchor = text.length
    else if (char === '⟦' || char === '⟪')
      hidden.push({ from: text.length, value: char === '⟦' ? hide : glyph })
    else if (char === '⟧' || char === '⟫') hidden.at(-1).to = text.length
    else text += char
  }
  const state = EditorState.create({
    doc: text,
    selection: { anchor: anchor ?? caret, head: caret },
  })
  const spec = command(
    state,
    markdown.parse(text),
    Decoration.set(hidden.map(({ from, to, value }) => value.range(from, to))),
  )
  if (!spec) return null
  const next = state.update(spec).state
  const { anchor: start, head } = next.selection.main
  if (start === head)
    return `${next.doc.sliceString(0, head)}|${next.doc.sliceString(head)}`
  const marks = [
    [start, '^'],
    [head, '|'],
  ].sort((a, b) => a[0] - b[0])
  return `${next.doc.sliceString(0, marks[0][0])}${marks[0][1]}${next.doc.sliceString(marks[0][0], marks[1][0])}${marks[1][1]}${next.doc.sliceString(marks[1][0])}`
}

/** Multi-line text input as a structure command for `run`. */
const typing = (text) => (state, tree) => {
  const { from, to } = state.selection.main
  return lineInput(state, tree, from, to, text)
}

test('a triple-click selects the text of its paragraph, task, heading or code block, like the rich editor', () => {
  const doc =
    'alpha line\nbeta line\n\n- [ ] task words\n\n> qa\n> qb\n\n## heading words ##  \n\nSetext words\n===\n\n```js\ncode one\ncode two\n```\n\n    indented one\n    indented two\n\n---'
  const state = EditorState.create({ doc })
  const tree = markdown.parse(doc)
  const at = (word, offset = 1) => {
    const block = blockText(state, tree, doc.indexOf(word) + offset)
    return block && doc.slice(block.from, block.to)
  }
  assert.equal(at('beta'), 'alpha line\nbeta line')
  assert.equal(at('alpha', 0), 'alpha line\nbeta line')
  assert.equal(at('beta line', 9), 'alpha line\nbeta line')
  assert.equal(at('task'), 'task words')
  assert.equal(at('qb'), 'qa\n> qb')
  assert.equal(at('heading'), 'heading words')
  assert.equal(at('Setext'), 'Setext words')
  assert.equal(at('code two'), 'code one\ncode two')
  assert.equal(at('indented two'), 'indented one\n    indented two')
  // Blank lines and other blocks have no text to select.
  assert.equal(at('\n\n- [ ]', 1), null)
  assert.equal(at('---'), null)
})

test('enter splits paragraphs and continues or leaves lists and quotes like the rich editor', () => {
  assert.equal(run('hello| world', blockBreak), 'hello\n\n| world')
  assert.equal(run('- one|', blockBreak), '- one\n- |')
  assert.equal(run('3. three|', blockBreak), '3. three\n4. |')
  assert.equal(run('- [x] done|', blockBreak), '- [x] done\n- [ ] |')
  // An empty item leaves the list; an empty quote line leaves the quote.
  assert.equal(run('- one\n- |', blockBreak), '- one\n\n|')
  assert.equal(run('> quote|', blockBreak), '> quote\n> |')
  assert.equal(run('> quote\n> |', blockBreak), '> quote\n\n|')
  assert.equal(run('```\n  code|\n```', blockBreak), '```\n  code\n  |\n```')
  assert.equal(run('- one|', lineBreak), '- one  \n  |')
  assert.equal(run('- one|', exitBlock), '- one\n\n|')
  assert.equal(run('para|', exitBlock), null)
})

test('backspace and delete edit visible text and remove block markers before joining blocks', () => {
  // The first Backspace at an item or heading turns it into plain text.
  assert.equal(run('⟦- ⟧|item', deleteBackward), '|item')
  assert.equal(run('⟦# ⟧|Title', deleteBackward), '|Title')
  assert.equal(run('⟦> ⟧|quoted', deleteBackward), '|quoted')
  // At the start of a paragraph it joins the previous one.
  assert.equal(run('one\n\n|two', deleteBackward), 'one|two')
  // Hidden syntax before the caret is skipped, never half deleted.
  assert.equal(run('⟦**⟧bold⟦**⟧|', deleteBackward), '**bol|**')
  assert.equal(run('one|\n\ntwo', deleteForward), 'one|two')
  assert.equal(run('|⟦**⟧bold⟦**⟧', deleteForward), '|**old**')
  // A widget shown for its text is deleted whole, like any character.
  assert.equal(run('ab ⟪&amp;⟫| cd', deleteBackward), 'ab | cd')
  assert.equal(run('ab |⟪&amp;⟫ cd', deleteForward), 'ab | cd')
  assert.equal(run('ab ⟪&amp;⟫⟦**⟧|', deleteBackward), 'ab |**')
})

test('tab nests and outdents list items, indents code and keeps paragraphs out of code', () => {
  assert.equal(
    run('- one\n- |two', (state, tree, hidden) =>
      indent(state, tree, false, hidden),
    ),
    '- one\n  - |two',
  )
  assert.equal(
    run('- one\n  - |two', (state, tree, hidden) =>
      indent(state, tree, true, hidden),
    ),
    '- one\n- |two',
  )
  assert.equal(
    run('```\n|code\n```', (state, tree, hidden) =>
      indent(state, tree, false, hidden),
    ),
    '```\n\t|code\n```',
  )
  // A tab at the start of a paragraph line would make it indented code.
  assert.equal(
    run('|para', (state, tree, hidden) => indent(state, tree, false, hidden)),
    '|para',
  )
})

test('code indentation survives partial trees, prefix edits and repeated tail keys', () => {
  const source = `intro\n\n~~~\n  x\n${'word '.repeat(51).concat('\n').repeat(1024)}y\n~~~`
  let state = EditorState.create({
    doc: source,
    selection: { anchor: source.lastIndexOf('y') },
    extensions: codeIndent,
  })
  const press = (unit) => {
    const tree = markdown.parse(state.doc.toString())
    const code = tree.topNode.getChild('FencedCode')
    const opening = code.firstChild,
      closing = code.lastChild
    const tail = state.doc.lineAt(state.selection.main.head)
    // Match a chunked tree whose first CodeText starts near the block's tail.
    const fragment = new Tree(
      code.type,
      [
        new Tree(opening.type, [], [], opening.to - opening.from),
        new Tree(code.getChild('CodeText').type, [], [], tail.to - tail.from),
        new Tree(closing.type, [], [], closing.to - closing.from),
      ],
      [0, tail.from - code.from, closing.from - code.from],
      code.to - code.from,
    )
    const partial = new Tree(tree.type, [fragment], [code.from], tree.length)
    const { head } = state.selection.main
    const slice = state.sliceDoc.bind(state)
    const lineAt = state.doc.lineAt.bind(state.doc)
    let lines = 0
    Object.defineProperty(state, 'sliceDoc', {
      configurable: true,
      value(from, to) {
        assert.ok(to - from < 16384, 'no whole-block slice for a key')
        return slice(from, to)
      },
    })
    Object.defineProperty(state.doc, 'lineAt', {
      configurable: true,
      value(pos) {
        lines++
        return lineAt(pos)
      },
    })
    let spec
    try {
      spec = indent(state, partial, false, Decoration.none)
    } finally {
      delete state.sliceDoc
      delete state.doc.lineAt
    }
    assert.ok(lines < 10, 'tail keys must not rescan the code block')
    state = state.update(spec).state
    assert.equal(state.doc.sliceString(head, head + unit.length), unit)
  }
  press('  ')
  press('  ')
  press('  ')
  const before = state.field(codeIndent).first.from
  // An edit before the block maps its metadata; the partial tree then moves too.
  state = state.update({ changes: { from: 0, insert: 'before\n' } }).state
  assert.equal(state.field(codeIndent).first.from, before + 7)
  press('  ')
  const first = state.field(codeIndent).first.from
  state = state.update({
    changes: { from: first, to: first + 2, insert: '    ' },
  }).state
  assert.equal(state.field(codeIndent).first, null)
  press('    ')
  state = state.update({
    changes: { from: first, insert: '\tearlier\n' },
  }).state
  press('\t')
})

test('code indentation strips quote and indented-code prefixes', () => {
  const tab = (state, tree, hidden) => indent(state, tree, false, hidden)
  assert.equal(
    run('> ~~~\n>   x\n> |y\n> ~~~', tab),
    '> ~~~\n>   x\n>   |y\n> ~~~',
  )
  assert.equal(
    run('> > ~~~\n> >   x\n> > |y\n> > ~~~', tab),
    '> > ~~~\n> >   x\n> >   |y\n> > ~~~',
  )
  assert.equal(run('    x\n      |y', tab), '    x\n        |y')
  assert.equal(run('>     x\n>       |y', tab), '>     x\n>         |y')
})

test('code indentation strips container prefixes as the rich editor reads them', () => {
  const footnotes = parser.configure([GFM, Footnotes])
  const { parser: marked, options, core, addons } = markdownConfiguration([])
  const manager = new MarkdownManager({
    extensions: [...core, ...addons],
    marked,
    markedOptions: options,
  })
  /** The rich editor's Tab unit in the first code block of `doc`. */
  const rich = (doc) => {
    const code = (node) =>
      node.type === 'codeBlock'
        ? (node.content ?? []).map(({ text }) => text).join('')
        : node.content?.map(code).find((text) => text !== undefined)
    const text = code(manager.parse(doc.replace('|', '')))
    return detectIndentUnit(text, codeIndentLines) ?? tabIndent.snapshot().unit
  }
  const tab = (doc, codeTabs) => {
    const head = doc.indexOf('|')
    const text = doc.replace('|', '')
    const state = EditorState.create({ doc: text, selection: { anchor: head } })
    const spec = indent(
      state,
      footnotes.parse(text),
      false,
      Decoration.none,
      codeTabs,
    )
    const next = state.update(spec ?? {}).state
    const at = next.selection.main.head
    return `${next.doc.sliceString(0, at)}|${next.doc.sliceString(at)}`
  }
  for (const [doc, unit] of [
    // Bullet items read a line's leading tabs as spaces to each tab stop.
    ['- item\n\n  ```js\n  foo|\n  \tbar\n  ```', '  '],
    ['- item\n\n  ~~~\n\tfoo|\n\tbar\n  ~~~', '  '],
    ['- [ ] task\n\n  ```\n  foo|\n  \tbar\n  ```', '  '],
    [' * item\n\n   ~~~\n   foo|\n    \tbar\n   ~~~', '    '],
    ['- a\n  - b\n\n    ```\n    foo|\n    \tbar\n    ```', '    '],
    ['> - item\n>\n>   ```\n>   foo|\n>   \tbar\n>   ```', '  '],
    ['- item\n\n\t\tfoo|\n\t\tbar', '  '],
    ['- item\n\n      foo|\n      \tbar', '  '],
    // Quote markers, ordered items and footnotes leave a tab after them.
    ['- > ```\n  > foo|\n  > \tbar\n  > ```', '\t'],
    ['>~~~\n>foo|\n> \tbar\n>~~~', '\t'],
    ['10. item\n\n    ```\n    foo|\n    \tbar\n    ```', '\t'],
    ['[^1]: note\n\n    ```js\n    foo|\n    \tbar\n    ```', '\t'],
    ['    foo|\n      bar', '  '],
  ]) {
    assert.equal(rich(doc), unit, `rich editor: ${doc}`)
    assert.equal(tab(doc), doc.replace('|', `${unit}|`), doc)
  }
  // The rich editor reads an ordered item's code one column early, with a
  // leading space and three-space unit here; the code's own unit is two.
  assert.equal(
    tab('10. item\n\n    ```\n    foo|\n      bar\n    ```'),
    '10. item\n\n    ```\n    foo  |\n      bar\n    ```',
  )
  // Code in a first item, which cannot nest, indents with the preferred unit.
  assert.equal(
    tab('- item\n\n  ```js\n  foo|\n  ```'),
    '- item\n\n  ```js\n  foo\t|\n  ```',
  )
  // Without Tab indenting, Tab keeps the item and its code as they are.
  assert.equal(
    tab('- item\n\n  ```js\n  foo|\n  ```', false),
    '- item\n\n  ```js\n  foo|\n  ```',
  )
  // An item after a sibling still nests, as in the rich editor.
  assert.match(
    tab('- one\n- two\n\n  ```js\n  foo|\n  ```'),
    /^- one\n {2}- two\n/,
  )
})

/**
 * Line reads, and the units of text they return, for three Tabs on the last
 * line of a fenced block holding `body`, through a chunked tree that holds
 * only the block's fences and that line.
 */
function tailTabReads(body) {
  const source = `intro\n\n~~~\n${body}y\n~~~\n`
  const sample = markdown.parse('intro\n\n~~~\nx\ny\n~~~\n')
  const code = sample.topNode.getChild('FencedCode')
  const from = source.indexOf('~~~'),
    closing = source.lastIndexOf('~~~'),
    tail = source.lastIndexOf('y\n~~~')
  /** The tree after `typed` tabs on the last line. */
  const tree = (typed) =>
    new Tree(
      sample.type,
      [
        new Tree(
          code.type,
          [
            new Tree(code.firstChild.type, [], [], 3),
            new Tree(code.getChild('CodeText').type, [], [], 1 + typed),
            new Tree(code.lastChild.type, [], [], 3),
          ],
          [0, tail - from, closing + typed - from],
          closing + typed + 3 - from,
        ),
      ],
      [from],
      source.length + typed,
    )
  let state = EditorState.create({
    doc: source,
    selection: { anchor: tail + 1 },
    extensions: codeIndent,
  })
  const counts = []
  for (let key = 0; key < 3; key++) {
    const prototype = Object.getPrototypeOf(state.doc)
    const originals = { lineAt: prototype.lineAt, line: prototype.line }
    let lines = 0,
      units = 0
    for (const name of ['lineAt', 'line'])
      prototype[name] = function (...args) {
        const line = originals[name].apply(this, args)
        lines++
        units += line.length
        return line
      }
    const head = state.selection.main.head
    try {
      state = state.update(
        indent(state, tree(key), false, Decoration.none),
      ).state
    } finally {
      Object.assign(prototype, originals)
    }
    counts.push({ lines, units })
    assert.equal(state.doc.sliceString(head, head + 1), '\t')
  }
  return counts
}

test('the first tab in a 50 MiB code block with no indented line reads only its first lines', () => {
  const counts = tailTabReads(
    `${'word '.repeat(11)}\n`.repeat(Math.ceil((50 * 2 ** 20) / 56)),
  )
  console.log('code-indent-50mib-reads', JSON.stringify(counts))
  // 936,232 line reads before the window; the first key now reads at most it.
  assert.ok(
    counts.every(({ lines, units }) => lines <= 1010 && units <= 1010 * 60),
    JSON.stringify(counts),
  )
  assert.ok(counts.slice(1).every(({ lines }) => lines < 12))
})

test('a 50 MiB last sampled line is read once, not on every tab', () => {
  const giant = 50 * 2 ** 20
  const counts = tailTabReads(
    `${'x\n'.repeat(codeIndentLines - 1)}${'x'.repeat(giant)}\n`,
  )
  console.log('code-indent-sample-edge-reads', JSON.stringify(counts))
  // Each key read that line twice, 104,857,606 units, before the sample was kept.
  assert.ok(counts[0].units < giant + 10_000, JSON.stringify(counts))
  assert.ok(
    counts.slice(1).every(({ units }) => units < 100),
    JSON.stringify(counts),
  )
})

test('code samples its lines again after an edit among them, not after one past them', () => {
  const doc = `~~~\n${'x\n'.repeat(codeIndentLines)}z\n~~~`
  let state = EditorState.create({
    doc,
    selection: { anchor: doc.indexOf('z') },
    extensions: codeIndent,
  })
  const tab = () => {
    const head = state.selection.main.head
    state = state.update(
      indent(
        state,
        markdown.parse(state.doc.toString()),
        false,
        Decoration.none,
      ),
    ).state
    return state.doc.sliceString(head, state.selection.main.head)
  }
  const indentLine = (number) => {
    state = state.update({
      changes: { from: state.doc.line(number).from, insert: '  ' },
    }).state
  }
  assert.equal(tab(), '\t')
  indentLine(codeIndentLines + 2)
  assert.equal(tab(), '\t')
  indentLine(codeIndentLines + 1)
  assert.equal(tab(), '  ')
})

test('code that runs to the end of the note keeps its sample through later edits', () => {
  for (const doc of ['~~~', 'a\n\n~~~', '    x', '~~~\nx']) {
    let state = EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: codeIndent,
    })
    state = state.update(
      indent(state, markdown.parse(doc), false, Decoration.none),
    ).state
    state = state.update({ changes: { from: 0, insert: 'z' } }).state
    assert.equal(state.doc.toString(), `z${doc}\t`, doc)
  }
})

test('code indentation follows an indented line among its first thousand lines only', () => {
  const tab = (state, tree, hidden) => indent(state, tree, false, hidden)
  for (const [before, unit] of [
    [999, '  '],
    [1000, '\t'],
  ]) {
    const doc = `~~~\n${'x\n'.repeat(before)}  y\n|z\n~~~`
    assert.equal(run(doc, tab), doc.replace('|z', `${unit}|z`), `${before}`)
  }
})

test('indented code ignores whitespace-only lines when choosing its unit', () => {
  const tab = (state, tree, hidden) => indent(state, tree, false, hidden)
  for (const prefix of ['', '> ', '> > ']) {
    const control = `${prefix}    x\n${prefix}      y\n${prefix}    |z`
    assert.equal(run(control, tab), control.replace('|z', '  |z'))
    for (const whitespace of ['\t\t', ' \t \t', '        ']) {
      const source = `${prefix}    x\n${prefix}${whitespace}\n${prefix}      y\n${prefix}    |z`
      assert.equal(run(source, tab), source.replace('|z', '  |z'))
    }
  }
  // Fenced code preserves its blank tabs as CodeText.
  assert.equal(
    run('~~~\nx\n\t\t\n  y\n|z\n~~~', tab),
    '~~~\nx\n\t\t\n  y\n\t|z\n~~~',
  )
})

for (const size of [4, 1024])
  for (const partial of [false, true])
    test(`tail tabs bound line reads with no earlier indent: ${size} lines, partial ${partial}`, () => {
      const source = `~~~\n${'word '.repeat(51).concat('\n').repeat(size)}y\n~~~`
      let state = EditorState.create({
        doc: source,
        selection: { anchor: source.lastIndexOf('y') },
        extensions: codeIndent,
      })
      const tree = () => {
        const complete = markdown.parse(state.doc.toString())
        if (!partial) return complete
        const code = complete.topNode.getChild('FencedCode')
        const opening = code.firstChild,
          closing = code.lastChild
        const tail = state.doc.lineAt(state.selection.main.head)
        const fragment = new Tree(
          code.type,
          [
            new Tree(opening.type, [], [], opening.to - opening.from),
            new Tree(
              code.getChild('CodeText').type,
              [],
              [],
              tail.to - tail.from,
            ),
            new Tree(closing.type, [], [], closing.to - closing.from),
          ],
          [0, tail.from - code.from, closing.from - code.from],
          code.to - code.from,
        )
        return new Tree(complete.type, [fragment], [code.from], complete.length)
      }
      // Prime detection without editing, so all three keys have a checked prefix.
      state = state.update({
        effects: indent(state, tree(), false, Decoration.none).effects,
      }).state
      const counts = []
      for (let key = 0; key < 3; key++) {
        const parsed = tree()
        const prototype = Object.getPrototypeOf(state.doc)
        const originals = { lineAt: prototype.lineAt, line: prototype.line }
        let lines = 0,
          units = 0
        for (const name of ['lineAt', 'line'])
          prototype[name] = function (...args) {
            const line = originals[name].apply(this, args)
            lines++
            units += line.length
            return line
          }
        const head = state.selection.main.head
        try {
          state = state.update(
            indent(state, parsed, false, Decoration.none),
          ).state
        } finally {
          Object.assign(prototype, originals)
        }
        counts.push({ lines, units })
        assert.equal(state.doc.sliceString(head, head + 1), '\t')
      }
      console.log(
        'tail-indent-reads',
        JSON.stringify({ size, partial, counts }),
      )
      assert.ok(
        counts.every(({ lines, units }) => lines < 12 && units < 4096),
        'warm tail keys must only read local lines',
      )
    })

test('cached code indentation matches fresh detection through edits, undo and redo', () => {
  for (const source of [
    'intro\n\n  ~~~\nx\ny\n  ~~~',
    'intro\n\n> >   ~~~\n> > x\n> > y\n> >   ~~~',
    'intro\n\n    x\n\t\t\n      y\n    z',
  ]) {
    let state = EditorState.create({
      doc: source,
      selection: {
        anchor: source.lastIndexOf(source.endsWith('z') ? 'z' : 'y'),
      },
      extensions: [codeIndent, history()],
    })
    const check = () => {
      const tree = markdown.parse(state.doc.toString())
      const fresh = EditorState.create({
        doc: state.doc,
        selection: state.selection,
      })
      const expected = indent(fresh, tree, false, Decoration.none)
      const spec = indent(state, tree, false, Decoration.none)
      assert.deepEqual(
        state.changes(spec.changes).toJSON(),
        fresh.changes(expected.changes).toJSON(),
      )
      state = state.update({ effects: spec.effects }).state
    }
    let edits = 0
    const edit = (changes) => {
      state = state.update({
        changes,
        annotations: isolateHistory.of('full'),
      }).state
      edits++
      check()
    }
    check()
    // Editing inside an indented opening fence must never scan that fence as code.
    if (source.includes('~~~')) {
      const opening = state.doc.toString().indexOf('  ~~~')
      edit({ from: opening + 1, insert: ' ' })
    }
    edit({ from: 0, insert: 'before\n' })
    edit({ from: state.doc.toString().indexOf('x'), insert: '  ' })
    const first = state.doc.toString().indexOf('x')
    edit({ from: first - 2, to: first, insert: '\t' })
    const at = state.doc.toString().indexOf('x')
    const line = state.doc.lineAt(at)
    edit({ from: at, insert: `a\n${line.text.slice(0, at - line.from)}` })
    const removed = state.doc.lineAt(state.doc.toString().indexOf('a'))
    edit({ from: removed.from, to: removed.to + 1 })
    edit([
      { from: 0, insert: 'prefix\n' },
      { from: state.selection.main.head, insert: '    ' },
    ])
    // Restore every earlier first-line choice, then replay it with warm metadata.
    for (let step = 0; step < edits; step++) {
      assert.ok(
        undo({
          state,
          dispatch: (transaction) => {
            state = transaction.state
          },
        }),
      )
      check()
    }
    assert.equal(state.doc.toString(), source)
    for (let step = 0; step < edits; step++) {
      assert.ok(
        redo({
          state,
          dispatch: (transaction) => {
            state = transaction.state
          },
        }),
      )
      check()
    }
  }
})

test('typing on the blank line between two blocks starts its own paragraph', () => {
  const type = (doc, text) => {
    const at = doc.indexOf('|')
    const plain = doc.replace('|', '')
    const state = EditorState.create({ doc: plain })
    const spec = gapInput(state, markdown.parse(plain), at, at, text)
    if (!spec) return null
    const next = state.update(spec).state
    const head = next.selection.main.head
    return `${next.doc.sliceString(0, head)}|${next.doc.sliceString(head)}`
  }
  assert.equal(type('one\n|\ntwo', 'x'), 'one\n\nx|\n\ntwo')
  assert.equal(type('one\n\n|\n\ntwo', 'x'), null)
  // Before, a blank line inside a fence was taken for a gap between blocks.
  assert.equal(type('```\na\n|\nb\n```', 'x'), null)
})

test('tab on selected code lines indents each line, and delete never joins a fence line', () => {
  const tab = (state, tree, hidden) => indent(state, tree, false, hidden)
  const untab = (state, tree, hidden) => indent(state, tree, true, hidden)
  // Before, the selected lines became one tab.
  assert.equal(run('```\n^x\ny|\n```', tab), '```\n\t^x\n\ty|\n```')
  assert.equal(run('```\n\t^x\n\ty|\n```', untab), '```\n^x\ny|\n```')
  // Inside a quote the tab goes after the hidden quote markers.
  assert.equal(
    run('> ```\n⟦> ⟧^x\n⟦> ⟧y|\n> ```', tab),
    '> ```\n> \t^x\n> \ty|\n> ```',
  )
  // A selection reaching a fence line leaves the fence alone.
  assert.equal(run('^```\nx|\n```', tab), '^```\n\tx|\n```')
  // Code indents like its first indented line, as in the rich editor.
  assert.equal(run('```\n  x\n|y\n```', tab), '```\n  x\n  |y\n```')
  assert.equal(run('```\n  x\n^y\nz|\n```', tab), '```\n  x\n  ^y\n  z|\n```')
  assert.equal(
    run('> ```\n⟦> ⟧  x\n⟦> ⟧|y\n> ```', tab),
    '> ```\n>   x\n>   |y\n> ```',
  )
  // Before, Shift-Tab took four spaces off code indented by two.
  assert.equal(run('```\n  x\n    |y\n```', untab), '```\n  x\n  |y\n```')
  // Before, Delete joined `code~~~` and the prose after became code.
  assert.equal(
    run('~~~\ncode|\n~~~\n\nafter', deleteForward),
    '~~~\ncode|\n~~~\n\nafter',
  )
  assert.equal(
    run('para|\n~~~\ncode\n~~~', deleteForward),
    'para|\n~~~\ncode\n~~~',
  )
  // A heading's underline is never joined to its text or the paragraph after it.
  assert.equal(run('Title|\n===\n\nnext', deleteForward), 'Title|\n===\n\nnext')
  assert.equal(run('Title\n===\n|next', deleteBackward), 'Title\n===\n|next')
  // Blank lines after a fence or a hidden definition go; the caret stays at the text.
  assert.equal(
    run('~~~\ncode\n~~~\n\n|after', deleteBackward),
    '~~~\ncode\n~~~\n|after',
  )
  assert.equal(
    run('[ref]: /target\n\n|after', deleteBackward),
    '[ref]: /target\n|after',
  )
  assert.equal(
    run('[ref]: /target\n|after', deleteBackward),
    '[ref]: /target\n|after',
  )
})

test('enter inside formatting closes it before the break and opens it again after', () => {
  // Before, `**bo|ld**` became `**bo` and `ld**`, and the bold was lost.
  assert.equal(run('**bo|ld**', blockBreak), '**bo**\n\n**|ld**')
  assert.equal(run('a *b **c|d** e*', blockBreak), 'a *b **c***\n\n***|d** e*')
  assert.equal(run('`co|de`', blockBreak), '`co`\n\n`|de`')
  assert.equal(run('[la|bel](/u)', blockBreak), '[la](/u)\n\n[|bel](/u)')
  assert.equal(run('- ~~st|ruck~~', blockBreak), '- ~~st~~\n- ~~|ruck~~')
  // At the edge of formatting the break stays outside it.
  assert.equal(run('**bold**|', blockBreak), '**bold**\n\n|')
})

test('backspace at the start of an item lifts it a level or ends the list before it', () => {
  // Before, the marker went and the item became lazy text of the item above.
  assert.equal(
    run('- parent\n⟦  - ⟧|child', deleteBackward),
    '- parent\n- |child',
  )
  assert.equal(run('- one\n⟦- ⟧|two', deleteBackward), '- one\n\n|two')
  assert.equal(run('⟦- ⟧|item', deleteBackward), '|item')
})

test('enter in a numbered list keeps nested blocks under their item and counts on', () => {
  // Before, `10.` left the child indented for `9.` and the next item stayed `10.`.
  assert.equal(
    run('9. nine|\n   - child\n10. ten', blockBreak),
    '9. nine\n10. |\n    - child\n11. ten',
  )
  assert.equal(
    run('1. one|\n2. two\n3. three', blockBreak),
    '1. one\n2. |\n3. two\n4. three',
  )
  // A gap in the numbers ends the renumbering.
  assert.equal(run('1. one|\n5. five', blockBreak), '1. one\n2. |\n5. five')
})

test('enter and backspace keep list numbers, quoted fences and formatting edges intact', () => {
  // Before, renumbering wrote into the replaced selection: `1. \n2. 3\n4. three`.
  assert.equal(
    run('1. ^one\n2. two|\n3. three', blockBreak),
    '1. \n2. |\n3. three',
  )
  // Before, a bare newline split the quote and the closing fence opened code.
  assert.equal(
    run('> ```\n> code|\n> ```\n\n> after', blockBreak),
    '> ```\n> code\n> |\n> ```\n\n> after',
  )
  // At the edges of formatting the break moves outside it.
  assert.equal(run('**bold|**', blockBreak), '**bold**\n\n|')
  assert.equal(run('**|bold**', blockBreak), '\n\n|**bold**')
  // Lifting the first item keeps the items after it a list.
  assert.equal(
    run('⟦1. ⟧|one\n2. two\n3. three', deleteBackward),
    '|one\n\n2. two\n3. three',
  )
  // An empty item's enter replaces the whole selection.
  assert.equal(run('- one\n- ^\n- two|', blockBreak), '- one\n\n|')
})

test('enter keeps formatting around a replaced selection, quotes from syntax, and lifts empty nested items', () => {
  // Before, a selection inside bold lost the bold on both sides.
  assert.equal(run('**bo^ld|ly**', blockBreak), '**bo**\n\n**|ly**')
  assert.equal(run('[la^b|el](/u)', blockBreak), '[la](/u)\n\n[|el](/u)')
  assert.equal(run('`co^d|e`', blockBreak), '`co`\n\n`|e`')
  // A `>` in code is text: only the quotes around the code continue.
  assert.equal(run('```\n> code|\n```', blockBreak), '```\n> code\n|\n```')
  assert.equal(
    run('> ```\n> > code|\n> ```', blockBreak),
    '> ```\n> > code\n> |\n> ```',
  )
  assert.equal(
    run('> ```\n>     code|\n> ```', blockBreak),
    '> ```\n>     code\n>     |\n> ```',
  )
  // An empty nested item moves up a level; only an empty top item leaves.
  assert.equal(
    run('- parent\n  - child\n  - |', blockBreak),
    '- parent\n  - child\n- |',
  )
  assert.equal(run('- one\n- |', blockBreak), '- one\n\n|')
})

test('enter with a selection at the edges of formatting leaves no empty markers, and a lifted item counts on', () => {
  // Before, `bo` selected in bold left `****` and `**ld**`.
  assert.equal(run('**^bo|ld**', blockBreak), '\n\n**|ld**')
  assert.equal(run('**bo^ld|**', blockBreak), '**bo**\n\n|')
  assert.equal(run('**^bold|**', blockBreak), '\n\n|')
  assert.equal(run('[^la|bel](/u)', blockBreak), '\n\n[|bel](/u)')
  assert.equal(run('`^code|`', blockBreak), '\n\n|')
  // Before, the lifted item and the next one were both `2.`.
  assert.equal(
    run('1. parent\n   - child\n   - |\n2. after', blockBreak),
    '1. parent\n   - child\n2. |\n3. after',
  )
})

test('multi-line text input is literal and breaks blocks where it lands', () => {
  // Before, typed syntax became Markdown and each break was one source line.
  assert.equal(run('|', typing('# a\n*b* <i>')), '\\# a\n\n\\*b\\* \\<i>|')
  assert.equal(run('a\n|\nb', typing('x\ny')), 'a\n\nx\n\ny|\n\nb')
  // In a quote in a list item, the next line is the list's next item.
  assert.equal(run('- > a|', typing('b\nc')), '- > ab\n- c|')
  assert.equal(
    run('- parent\n  > ab|cd\n- tail', typing('x\ny')),
    '- parent\n  > abx\n- y|cd\n- tail',
  )
  // Spaces and tabs typed with a line break are text, not Enter.
  assert.equal(
    run('- [x] ab|cd', typing('\n\t\t')),
    '- [x] ab\n- [ ] &#9;\t|cd',
  )
  assert.equal(run('1. a|\n2. b', typing('x\ny')), '1. ax\n2. y|\n3. b')
  assert.equal(run('> - a|', typing('\n\nb')), '> - a\n>\n> b|')
  assert.equal(
    run('> - a|\n> - b', typing('x\n\ny')),
    '> - ax\n>\n> y|\n>\n> - b',
  )
  // Bold goes on to later lines; a link only where its text continues.
  assert.equal(run('**ab|**', typing('x\ny')), '**abx**\n\n**y|**')
  assert.equal(
    run('**[a|b](u)**', typing('x\ny')),
    '**[ax](u)**\n\n**y|[b](u)**',
  )
  // One blank break is Enter; code, tables and several carets keep the default.
  assert.equal(run('ab|', typing('\n')), 'ab\n\n|')
  assert.equal(run('```\na|\n```', typing('x\ny')), null)
  const table = '| a |\n| - |\n| b |'
  const cell = EditorState.create({ doc: table, selection: { anchor: 15 } })
  assert.equal(lineInput(cell, markdown.parse(table), 15, 15, 'x\ny'), null)
  const carets = EditorState.create({
    doc: 'ab',
    selection: EditorSelection.create([
      EditorSelection.cursor(1),
      EditorSelection.cursor(2),
    ]),
    extensions: EditorState.allowMultipleSelections.of(true),
  })
  assert.equal(lineInput(carets, markdown.parse('ab'), 1, 1, 'x\ny'), null)
})

test('multi-line text input repairs formatting it cuts, as the browser types', () => {
  // Before, a selection cutting formatting fell back to raw source: `**aX\nYd`.
  assert.equal(run('**a^b**c|d', typing('X\nY')), '**aX**\n\nY|d')
  assert.equal(run('**a^b**c|d', typing('\nY')), '**a**\n\n**Y|**d')
  assert.equal(run('a^b**c|d**', typing('x\ny')), 'ax\n\n**y|d**')
  assert.equal(run('a^b**c|d**', typing('\ny')), 'a\n\ny|**d**')
  assert.equal(run('**a^b**\n\nc|d', typing('x\ny')), '**ax**\n\ny|d')
  // Joins across nested items and soft lines.
  assert.equal(
    run('- a^b\n  - c|d\n- tail', typing('x\ny')),
    '- ax\n- y|d\n- tail',
  )
  assert.equal(run('a^b\ncd\n\ne|f\ngh', typing('X\nY')), 'aX\n\nY|f\ngh')
  // Spaces at the ends of typed text stay outside markers, which cannot
  // close after a space.
  assert.equal(run('**ab|cd**', typing(' x \ny ')), '**ab x** \n\n**y |cd**')
  assert.equal(run('*ab|cd*', typing(' x \ny ')), '*ab x* \n\n*y |cd*')
  assert.equal(run('`ab|cd`', typing(' x \ny ')), '`ab x` \n\n`y |cd`')
  assert.equal(
    run('**ab|cd**', typing('\tx\n    y')),
    '**ab\tx**\n\n&#32;   **y|cd**',
  )
  assert.equal(run('**ab |cd**', typing('\ny')), '**ab&#32;**\n\n**y|cd**')
  // A character reference keeps existing trailing spaces inside their marks.
  assert.equal(run('**a   |b**', typing('\ny')), '**a  &#32;**\n\n**y|b**')
  // A line break alone is the browser's input, not Enter: a heading continues.
  assert.equal(run('## ab|cd', typing('\n')), '## ab\n\n## |cd')
  assert.equal(run('## a^b\n\nc|d', typing('\n')), '## a\n\n## |d')
  // Numbered items in a quote count on past its markers, for Enter too.
  assert.equal(
    run('> 9. ab|cd\n> 10. tail', typing('x\ny')),
    '> 9. abx\n> 10. y|cd\n> 11. tail',
  )
  assert.equal(
    run('> 9. ab|\n> 10. tail', blockBreak),
    '> 9. ab\n> 10. |\n> 11. tail',
  )
  // In a quote in an item, new items continue only the inner list, after
  // the outer item's indentation.
  assert.equal(
    run('- > 8. ab|cd\n  > 9. tail', typing('x\ny')),
    '- > 8. abx\n  > 9. y|cd\n  > 10. tail',
  )
  assert.equal(run('- > - ab|cd', typing('x\ny')), '- > - abx\n  > - y|cd')
  assert.equal(
    run('- > 8. ab|\n  > 9. tail', blockBreak),
    '- > 8. ab\n  > 9. |\n  > 10. tail',
  )
  // A wider number moves the item's later lines inside the quote markers.
  assert.equal(
    run('> 8. ab|cd\n> 9. tail\n>\n>    more', typing('x\ny')),
    '> 8. abx\n> 9. y|cd\n> 10. tail\n>\n>     more',
  )
  assert.equal(
    run('> 9. ab|\n> 9. tail\n>\n>    more', blockBreak),
    '> 9. ab\n> 10. |\n> 11. tail\n>\n>     more',
  )
  // Each line in a task list is a task, as Enter makes it (an accepted
  // difference: the rich editor nests later lines as bullets).
  assert.equal(
    run('- [x] ab|cd\n- [ ] tail', typing('x\n\ny')),
    '- [x] abx\n- [ ] \n- [ ] y|cd\n- [ ] tail',
  )
})

test('multi-line input over select-all replaces all of a partly parsed note', () => {
  // Before, text after the last parsed block survived: `x\n\ny\n\nold tail`.
  const doc = 'first\n\nold tail'
  const sample = markdown.parse('first')
  const pending = new Tree(
    sample.type,
    [
      new Tree(sample.topNode.firstChild.type, [], [], 5),
      new Tree(NodeType.none, [], [], 8),
    ],
    [0, 7],
    doc.length,
  )
  const large = `first\n\n${'old tail\n\n'.repeat(20000)}`
  const chunked = new ChunkedMarkdownParser(markdown, markdown)
  const parse = chunked.startChunkedParse(
    {
      length: large.length,
      lineChunks: false,
      chunk: (from) => large.slice(from, from + 4096),
      read: (from, to) => large.slice(from, to),
    },
    [],
    { from: 0, to: 8192 },
  )
  let partial = parse.advance()
  while (!partial) partial = parse.advance()
  for (const [source, tree] of [
    [doc, pending],
    [large, partial],
    // The trailing blank lines are an empty paragraph the selection holds.
    ['first\n\n', markdown.parse('first\n\n')],
  ]) {
    const state = EditorState.create({
      doc: source,
      selection: { anchor: 0, head: source.length },
    })
    const spec = lineInput(state, tree, 0, source.length, 'x\ny')
    assert.equal(state.update(spec).state.doc.toString(), 'x\n\ny')
  }
})

test('multi-line input after a long run of spaces reads a bounded part of it', () => {
  // Before, the spaces before the caret were read and moved: 4,194,245 units for 1 MiB.
  const sample = markdown.parse('**ab**')
  const strong = sample.topNode.firstChild.firstChild
  const mark = strong.firstChild.type
  for (const size of [2 ** 20, 50 * 2 ** 20]) {
    const doc = `**a${' '.repeat(size)}b**`
    const tree = new Tree(
      sample.type,
      [
        new Tree(
          sample.topNode.firstChild.type,
          [
            new Tree(
              strong.type,
              [new Tree(mark, [], [], 2), new Tree(mark, [], [], 2)],
              [0, doc.length - 2],
              doc.length,
            ),
          ],
          [0],
          doc.length,
        ),
      ],
      [0],
      doc.length,
    )
    const caret = doc.length - 3
    const state = EditorState.create({ doc, selection: { anchor: caret } })
    const prototype = Object.getPrototypeOf(state.doc)
    const originals = Object.fromEntries(
      ['sliceString', 'lineAt', 'line'].map((name) => [name, prototype[name]]),
    )
    let units = 0
    for (const name of Object.keys(originals))
      prototype[name] = function (...args) {
        const value = originals[name].apply(this, args)
        units += value.length
        return value
      }
    let spec
    try {
      spec = lineInput(state, tree, caret, caret, '\ny')
    } finally {
      Object.assign(prototype, originals)
    }
    assert.ok(spec)
    const changes = []
    spec.changes.iterChanges((from, to, _from, _to, insert) =>
      changes.push({ from, to, insert: insert.toString() }),
    )
    assert.deepEqual(changes, [
      { from: caret - 1, to: caret, insert: '&#32;**\n\n**y' },
    ])
    assert.equal(spec.selection.head, caret + 11)
    // The old bounded fallback read 259 units and declined. The completed
    // edit reads only the two markers and the final space at either size.
    assert.equal(units, 5)
  }
})

test('multi-line text input at the edges of formatting, headings and lists, as the browser types', () => {
  // Typed right after an opening marker: an empty first line leaves no empty
  // markers (before, `****` made a thematic break), and its spaces stay
  // outside them (before, `** x**` could not open).
  for (const mark of ['**', '*', '~~', '`']) {
    const source = `${mark}|abcd${mark}`
    assert.equal(run(source, typing('\ny')), `\n\n${mark}y|abcd${mark}`)
    assert.equal(
      run(source, typing(' x\ny')),
      ` ${mark}x${mark}\n\n${mark}y|abcd${mark}`,
    )
  }
  // An empty task the input adds leaves the list, as a plain item does.
  assert.equal(run('- [x] ab|', typing('x\n\ny')), '- [x] abx\n\ny|')
  assert.equal(run('- [x] ab|', typing('\n\n')), '- [x] ab\n- [ ] |')
  // A setext heading's underline stays with its last part.
  assert.equal(run('ab|cd\n====', typing('X\nY')), '# abX\n\nY|cd\n====')
  assert.equal(run('abcd|\n====', typing('X\nY')), 'abcdX\n====\n\nY|')
  // Select-all keeps the formatting the text starts with, and a first code
  // block, which takes the text as code.
  assert.equal(run('^**abcd**|', typing('x\ny')), '**x**\n\n**y|**')
  assert.equal(
    run('^```\nabcd\n```\n\nend|', typing('**x**\ny')),
    '```\n**x**\ny|\n```',
  )
  // A carriage return is a line break too.
  assert.equal(run('ab|', typing('# typed\ry')), 'ab\\# typed\n\ny|')
  assert.equal(
    run('^plain\n\n```\ncode\n```|', typing('# typed\ry')),
    '\\# typed\n\ny|',
  )
  assert.equal(
    run('^```\nabcd\n```\n\nend|', typing('# typed\r\ny')),
    '```\n# typed\ny|\n```',
  )
  // Wider numbers in quotes shift continuation lines and children inside them.
  assert.equal(
    run('> 8. ab|cd\n> 9. tail\n>    - child', typing('x\ny')),
    '> 8. abx\n> 9. y|cd\n> 10. tail\n>     - child',
  )
  assert.equal(
    run('> > 8. ab|cd\n> > 9. tail\n> >\n> >    more', typing('x\ny')),
    '> > 8. abx\n> > 9. y|cd\n> > 10. tail\n> >\n> >     more',
  )
})

test('backticks typed into inline code keep the code span', () => {
  for (const [source, text, expected] of [
    ['`ab|cd`', 'x\n`y`', '`abx`\n\n`` `y`|cd ``'],
    ['`ab|cd`', '`x`\ny', '`` ab`x` ``\n\n`y|cd`'],
    ['`` `ab|cd` ``', 'x\n`y`', '`` `abx ``\n\n`` `y`|cd` ``'],
    ['``a`|b``', '`x`\n``y``', '``` a``x` ```\n\n` ``y``|b `'],
    ['`abcd|`', '`x`\ny', '`` abcd`x` ``\n\ny|'],
    ['`|abcd`', '`x`\ny', '`` `x` ``\n\n`y|abcd`'],
    ['**`ab|cd`**', 'x\n`y`', '**`abx`**\n\n**`` `y`|cd ``**'],
    ['- `ab|cd`\n- tail', 'x\n`y`', '- `abx`\n- `` `y`|cd ``\n- tail'],
    ['`a  |b`', '\n`y`', '`a  `\n\n`` `y`|b ``'],
    ['`ab^cd|ef`', 'x\n`y`', '`abx`\n\n`` `y`|ef ``'],
    ['^`abcd`|', '`x`\ny', '`` `x` ``\n\ny|'],
    ['^`` `abcd` ``|', '`x`\ny', '`` `x` ``\n\ny|'],
    ['`\nab|cd\n`', 'x\n`y`', '`abx`\n\n`` `y`|cd ``'],
    ['`ab|cd`', '`x`\n`y`\nz', '`` ab`x` ``\n\n`` `y` ``\n\n`z|cd`'],
  ])
    assert.equal(run(source, typing(text)), expected, source)
})

test('inline code re-fencing reads only its span and leaves the document tail untouched', () => {
  const reads = []
  for (const length of [2 ** 16, 2 ** 20]) {
    const source = '`abcd`\n\n' + 'z'.repeat(length)
    const state = EditorState.create({ doc: source, selection: { anchor: 3 } })
    const tree = markdown.parse('`abcd`\n\nz')
    const prototype = Object.getPrototypeOf(state.doc)
    const originals = Object.fromEntries(
      ['sliceString', 'lineAt', 'line'].map((name) => [name, prototype[name]]),
    )
    let units = 0
    for (const name of Object.keys(originals))
      prototype[name] = function (...args) {
        const value = originals[name].apply(this, args)
        units += value.length
        return value
      }
    let spec
    try {
      spec = lineInput(state, tree, 3, 3, 'x\n`y`')
    } finally {
      Object.assign(prototype, originals)
    }
    assert.ok(spec)
    const next = state.update(spec)
    assert.equal(next.state.doc.sliceString(0, 20), '`abx`\n\n`` `y`cd ``\n\n')
    next.changes.iterChanges((from, to) => assert.ok(from <= 6 && to <= 6))
    assert.ok(units > 0 && units <= 32, `${units} units read`)
    reads.push(units)
  }
  assert.equal(reads[0], reads[1])
})

test('multi-line input in a 50 MiB block reads and rewrites only around the caret', () => {
  const size = 50 * 2 ** 20
  const sample = markdown.parse('# a\n\nb')
  const heading = sample.topNode.firstChild,
    paragraph = sample.topNode.lastChild
  const blocks = [
    // Before, the paragraph after the caret was read and rewritten: 52,428,799 units.
    [`a${'b'.repeat(size)}`, 1, new Tree(paragraph.type, [], [], size + 1)],
    [
      `# a${'b'.repeat(size)}`,
      3,
      new Tree(
        heading.type,
        [new Tree(heading.firstChild.type, [], [], 1)],
        [0],
        size + 3,
      ),
    ],
  ]
  const reads = []
  for (const [doc, caret, block] of blocks) {
    const tree = new Tree(sample.type, [block], [0], doc.length)
    const state = EditorState.create({ doc, selection: { anchor: caret } })
    const prototype = Object.getPrototypeOf(state.doc)
    const originals = Object.fromEntries(
      ['sliceString', 'lineAt', 'line'].map((name) => [name, prototype[name]]),
    )
    let units = 0
    for (const name of Object.keys(originals))
      prototype[name] = function (...args) {
        const value = originals[name].apply(this, args)
        units += value.length
        return value
      }
    let spec
    try {
      spec = lineInput(state, tree, caret, caret, 'x\ny')
    } finally {
      Object.assign(prototype, originals)
    }
    let removed = 0,
      inserted = 0
    spec.changes.iterChanges((fromA, toA, _fromB, _toB, text) => {
      removed += toA - fromA
      inserted += text.length
    })
    reads.push(units)
    assert.ok(units <= 4096, `${units} units read`)
    assert.equal(removed, 0)
    assert.ok(inserted > 0 && inserted <= 16, `${inserted} inserted`)
  }
  // The heading's text start and end are read from its first characters.
  assert.ok(reads[1] > 0, 'positive read control')
})

test('select-all code input keeps matching fences as literal code', () => {
  const { parser: marked, options, core, addons } = markdownConfiguration([])
  const manager = new MarkdownManager({
    extensions: [...core, ...addons],
    marked,
    markedOptions: options,
  })
  for (const [opening, input, closing] of [
    ['```', '```\nX', '````'],
    ['```js', '  `````\nX', '``````'],
    ['~~~js', '~~~\r\nX', '~~~~'],
    ['`````js', '```\nX', '`````'],
    ['```', '~~~\nX', '```'],
  ]) {
    const source = `${opening}\nabcd\n${opening.match(/`+|~+/)[0]}\n\nend`
    const normalized = input.replace(/\r\n?/g, '\n')
    const next = run(`^${source}|`, typing(input))
    assert.equal(
      next,
      `${closing}${opening.replace(/`+|~+/, '')}\n${normalized}|\n${closing}`,
    )
    const doc = manager.parse(next.replace('|', ''))
    assert.equal(doc.content.length, 1)
    assert.equal(doc.content[0].type, 'codeBlock')
    assert.equal(
      doc.content[0].attrs.language,
      opening.replace(/`+|~+/, '') || null,
    )
    assert.equal(doc.content[0].content[0].text, normalized)
  }
})

test('enter on a blank line after the last block adds an empty paragraph, and one line between blocks', () => {
  // Before, it added one line break, which the rich view shows as nothing.
  assert.equal(run('first\n\n|', blockBreak), 'first\n\n\n\n|')
  assert.equal(run('first\n\n|\n', blockBreak), 'first\n\n\n\n|\n')
  assert.equal(run('a\n\n|\n\nb', blockBreak), 'a\n\n\n|\n\nb')
  // The note's end is where it ends once the selection is gone.
  assert.equal(run('first\n\n^\n\nsecond|', blockBreak), 'first\n\n\n\n|')
})

test('enter on a blank line after the last block reads no more of a 50 MiB blank tail', () => {
  // Before, it read every blank line after the caret: 12,800 lines, 52,416,000 units.
  const doc = `x\n\n${`${' '.repeat(4095)}\n`.repeat(12800)}`
  const sample = markdown.parse('x')
  const tree = new Tree(
    sample.type,
    [new Tree(sample.topNode.firstChild.type, [], [], 1)],
    [0],
    doc.length,
  )
  const state = EditorState.create({ doc, selection: { anchor: 2 } })
  const prototype = Object.getPrototypeOf(state.doc)
  const originals = Object.fromEntries(
    ['sliceString', 'lineAt', 'line'].map((name) => [name, prototype[name]]),
  )
  let lines = 0,
    units = 0
  for (const name of Object.keys(originals))
    prototype[name] = function (...args) {
      const value = originals[name].apply(this, args)
      if (name !== 'sliceString') lines++
      units += value.length
      return value
    }
  let spec
  try {
    spec = blockBreak(state, tree)
  } finally {
    Object.assign(prototype, originals)
  }
  assert.ok(lines >= 1 && lines <= 4, `${lines} lines read`)
  assert.ok(units <= 4096, `${units} units read`)
  const next = state.update(spec).state.doc
  assert.equal(next.length, doc.length + 2)
  assert.equal(next.sliceString(0, 5), 'x\n\n\n\n')
})

for (const [name, tail, direction] of [
  ['no suffix', ''],
  ['4096 line feeds', '\n'.repeat(4096)],
  ['4097 line feeds', '\n'.repeat(4097)],
  ['8192 line feeds', '\n'.repeat(8192)],
  ['8192 line feeds before text', `${'\n'.repeat(8192)}last`],
  ['4098 spaces and tabs', ' \t\n'.repeat(1366)],
  ['mixed whitespace before text', `${' \t\n'.repeat(1366)}last`],
  ['JavaScript whitespace', ' \t\u00a0\ufeff\u2003\n'.repeat(1000)],
  ['whitespace before an astral character', `${' \t\n'.repeat(1366)}😀`],
  [
    'mixed tail after a forward selection',
    `\n${' \t\n'.repeat(1366)}`,
    'forward',
  ],
  [
    'mixed tail after a backward selection',
    `\n${' \t\n'.repeat(1366)}`,
    'backward',
  ],
]) {
  test(`enter before ${name} agrees with a complete parse`, async () => {
    const prefix = `first\n\n${'old tail\n\n'.repeat(20000)}`
    const selected = direction ? '\n\nsecond' : ''
    const doc = prefix + selected + tail
    const parse = new ChunkedMarkdownParser(
      markdown,
      markdown,
    ).startChunkedParse(
      {
        length: doc.length,
        lineChunks: false,
        chunk: (from) => doc.slice(from, from + 4096),
        read: (from, to) => doc.slice(from, to),
      },
      [],
      { from: 0, to: 8192 },
    )
    let partial = parse.advance()
    while (!partial) partial = parse.advance()
    assert.ok(partial.topNode.lastChild.to < 20000, 'parsed only at the start')
    const store = new SourceStore(doc, { tabId: 'blank-tail', revision: 0 })
    const text = await sourceEditorTextCooperatively(store.snapshot(), {
      signal: new AbortController().signal,
      yieldTask: async () => {},
    })
    const state = EditorState.create({
      doc: text,
      selection:
        direction === 'backward'
          ? { anchor: prefix.length + selected.length, head: prefix.length }
          : { anchor: prefix.length, head: prefix.length + selected.length },
    })
    let units = 0
    const slice = state.sliceDoc.bind(state)
    state.sliceDoc = (...args) => {
      const value = slice(...args)
      units += value.length
      return value
    }
    const actual = state.update(blockBreak(state, partial)).state
    const expected = state.update(blockBreak(state, markdown.parse(doc))).state
    assert.ok(actual.doc.eq(expected.doc))
    assert.ok(actual.selection.eq(expected.selection))
    assert.equal(
      actual.doc.length,
      doc.length - selected.length + (/\S/.test(tail) ? 1 : 2),
    )
    assert.ok(units <= 4096, `${units} source units read`)
  })
}

test('enter on a blank line keeps the same pairs while the note is partly parsed', () => {
  // Before, a caret after text not parsed yet always gained one line break.
  const doc = `first\n\n${'old tail\n\n'.repeat(20000)}`
  const chunked = new ChunkedMarkdownParser(markdown, markdown)
  const parse = chunked.startChunkedParse(
    {
      length: doc.length,
      lineChunks: false,
      chunk: (from) => doc.slice(from, from + 4096),
      read: (from, to) => doc.slice(from, to),
    },
    [],
    { from: 0, to: 8192 },
  )
  let partial = parse.advance()
  while (!partial) partial = parse.advance()
  assert.ok(partial.topNode.lastChild.to < 20000, 'parsed only at the start')
  const complete = markdown.parse(doc)
  // At the end, and on a blank line followed by text not parsed yet.
  for (const caret of [doc.length, doc.indexOf('\n\nold', 100000) + 1]) {
    const state = EditorState.create({ doc, selection: { anchor: caret } })
    const added = (tree) =>
      state.update(blockBreak(state, tree)).state.doc.length - doc.length
    assert.equal(added(partial), added(complete), String(caret))
  }
})

test('multiline selections preserve unselected formatting edges', async (t) => {
  const cases = [
    ['both edges', '`a` mid `b`', 2, 9, '`a`\\`x\\`\n\n\\`y\\``b`'],
    ['start edge', '`a` mid `b`', 2, 6, '`a`\\`x\\`\n\n\\`y\\`d `b`'],
    ['end edge', '`a` mid `b`', 4, 9, '`a` \\`x\\`\n\n\\`y\\``b`'],
    [
      'nested edges',
      '**`a`** mid **`b`**',
      4,
      15,
      '**`a`**\\`x\\`\n\n\\`y\\`**`b`**',
      '**`a`**&#120;\n\n&#121;**`b`**',
    ],
    [
      'shared bold',
      '**`a` mid `b`**',
      4,
      11,
      '**`a`\\`x\\`**\n\n**\\`y\\``b`**',
    ],
    ['full selection', '`a` mid `b`', 0, 11, '`` `x` ``\n\n\\`y\\`'],
  ]
  for (const [name, source, from, to, expected, plainExpected] of cases)
    for (const backward of [false, true])
      for (const ticks of [true, false])
        await t.test(
          name +
            ': ' +
            (backward ? 'backward' : 'forward') +
            ', ' +
            (ticks ? 'backticks' : 'plain'),
          () => {
            const state = EditorState.create({
              doc: source,
              selection: backward
                ? { anchor: to, head: from }
                : { anchor: from, head: to },
            })
            const spec = lineInput(
              state,
              markdown.parse(source),
              from,
              to,
              ticks ? '`x`\n`y`' : 'x\ny',
            )
            assert.ok(spec, 'selection must be handled')
            const plain =
              plainExpected ??
              (name === 'full selection'
                ? '`x`\n\ny'
                : expected
                    .replaceAll('\\`x\\`', 'x')
                    .replaceAll('\\`y\\`', 'y'))
            assert.equal(
              state.update(spec).state.doc.toString(),
              ticks ? expected : plain,
            )
          },
        )
})

test('multiline input keeps selections through partial inline markers valid', () => {
  for (const source of ['`a` mid `b`', '**`a`** mid **`b`**']) {
    const tree = markdown.parse(source)
    for (let from = 0; from <= source.length; from++)
      for (let to = from; to <= source.length; to++)
        for (const backward of [false, true])
          for (const text of ['x\ny', '`x`\n`y`']) {
            const state = EditorState.create({
              doc: source,
              selection: backward
                ? { anchor: to, head: from }
                : { anchor: from, head: to },
            })
            assert.doesNotThrow(() => {
              const spec = lineInput(state, tree, from, to, text)
              if (spec) state.update(spec)
            }, `${source}: ${from}..${to}, ${backward}, ${text}`)
          }
  }
})
