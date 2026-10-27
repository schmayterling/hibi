import assert from 'node:assert/strict'
import test from 'node:test'
import { history, isolateHistory, redo, undo } from '@codemirror/commands'
import { EditorState } from '@codemirror/state'
import { Decoration, WidgetType } from '@codemirror/view'
import { Tree } from '@lezer/common'
import { GFM, parser } from '@lezer/markdown'
import {
  blockBreak,
  codeIndent,
  deleteBackward,
  deleteForward,
  exitBlock,
  gapInput,
  indent,
  lineBreak,
} from '../src/renderer/src/formatted-commands.ts'

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
