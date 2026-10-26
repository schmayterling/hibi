import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { parser } from '@lezer/markdown'
import { blockStep, selectionStep } from '../src/addons/block-drag/formatted.ts'
import { formattedSyntax } from '../src/renderer/src/formatted-syntax.ts'
import { createSourceSession } from '../src/renderer/src/source-session.ts'
import { DocumentSession } from '../src/shared/document-session.ts'
import { sourceEditorText } from './source-editor-text.mjs'

const move = (doc, token, direction) => {
  const syntax = formattedSyntax({ slice: 1000 })
  const state = EditorState.create({
    doc,
    selection: { anchor: doc.indexOf(token) },
    extensions: syntax.extension,
  })
  const spec = selectionStep(state, syntax.tree(state), direction)
  return spec && state.update(spec).state.doc.toString()
}

test('ordered moves keep quote prefixes and nested continuation indentation', () => {
  for (const mark of ['.', ')']) {
    for (const [prefix, indent] of [
      ['> ', ''],
      ['', '  '],
      ['> ', '  '],
    ]) {
      const parent = indent ? `${prefix}- parent\n${prefix.trimEnd()}\n` : ''
      const line = prefix + indent
      const before = `${parent}${line}9${mark} nine\n${line}   keep-nine\n${line}10${mark} ten\n${line}    keep-ten\n`
      const after = `${parent}${line}9${mark} ten\n${line}   keep-ten\n${line}10${mark} nine\n${line}    keep-nine\n`
      assert.equal(move(before, 'nine', 1), after)
      assert.equal(move(before, 'ten', -1), after)
    }
  }
})

test('indented code moves with its first-line indentation', () => {
  for (const indent of ['    ', '\t', '     ']) {
    const code = `${indent}code-one\n${indent}code-two`
    assert.equal(
      move(`first\n\n${code}\n\nlast\n`, 'code-one', -1),
      `${code}\n\nfirst\n\nlast\n`,
    )
    assert.equal(
      move(`first\n\n${code}\n\nlast\n`, 'first', 1),
      `${code}\n\nfirst\n\nlast\n`,
    )
  }
  const quoted = '> first\n>\n>     code-one\n>     code-two\n>\n> last\n'
  assert.equal(
    move(quoted, 'code-one', -1),
    '>     code-one\n>     code-two\n>\n> first\n>\n> last\n',
  )
  const nested = '- first\n\n      code-one\n      code-two\n\n  last\n'
  assert.equal(
    move(nested, 'code-one', 1),
    '- first\n\n  last\n\n      code-one\n      code-two\n',
  )
})

test('menu moves place the caret after an indented code prefix', () => {
  const syntax = formattedSyntax({ slice: 1000 })
  const doc = 'first\n\n    code\n'
  const state = EditorState.create({ doc, extensions: syntax.extension })
  const tree = syntax.tree(state)
  let code = tree.resolveInner(doc.indexOf('code'), 1)
  while (code.name !== 'CodeBlock') code = code.parent
  const next = state.update(blockStep(state, tree, code, -1)).state
  assert.equal(next.doc.toString(), '    code\n\nfirst\n')
  assert.equal(next.selection.main.head, 4)
})

test('moving an indented fence retains the opening indentation and code value', () => {
  const code = '  ```txt\n  code\n  ```'
  const after = move(`first\n\n${code}\n\nlast\n`, 'first', 1)
  assert.equal(after, `${code}\n\nfirst\n\nlast\n`)
  assert.equal(parser.parse(after).topNode.firstChild.name, 'FencedCode')
})

test('nested fences keep their indentation within quotes and lists', () => {
  for (const [prefix, first] of [
    ['> ', '> first'],
    ['  ', '- first'],
  ]) {
    const blank = prefix.trimEnd()
    const fence = `${prefix}  \x60\x60\x60txt\n${prefix}  code\n${prefix}  \x60\x60\x60`
    assert.equal(
      move(
        `${first}\n${blank}\n${fence}\n${blank}\n${prefix}last\n`,
        'code',
        1,
      ),
      `${first}\n${blank}\n${prefix}last\n${blank}\n${fence}\n`,
    )
  }
})

test('numbering does not mistake code content for an outer quote prefix', () => {
  assert.equal(
    move('9. nine\n       > code\n10. ten\n        > other\n', 'nine', 1),
    '9. ten\n       > other\n10. nine\n        > code\n',
  )
  // Tab expansion or a marker on its parent's first line is ambiguous.
  assert.equal(move('9. nine\n\tbody\n10. ten\n\tother\n', 'nine', 1), null)
  assert.equal(
    move('9.\tnine\n    body\n10.\tten\n    other\n', 'nine', 1),
    null,
  )
})

test('explicit crlf line separators keep offsets in document coordinates', () => {
  const syntax = formattedSyntax({ slice: 1000 })
  const state = EditorState.create({
    doc: 'first\r\n\r\n    code\r\n',
    selection: { anchor: 0 },
    extensions: [syntax.extension, EditorState.lineSeparator.of('\r\n')],
  })
  const spec = selectionStep(state, syntax.tree(state), 1)
  const next = state.update(spec).state
  assert.equal(next.sliceDoc(), '    code\r\n\r\nfirst\r\n')
  assert.equal(next.selection.main.head, next.doc.toString().indexOf('first'))
})

test('footnote definitions and their continuation cannot be split by a move', () => {
  for (const gap of ['\n', '\n\n']) {
    const doc = `alpha\n\n[^f]: footnote${gap}    continuation\n\nbeta\n`
    for (const [token, direction] of [
      ['alpha', 1],
      ['[^f]', 1],
      ['[^f]', -1],
      ['continuation', 1],
      ['continuation', -1],
      ['beta', -1],
    ])
      assert.equal(move(doc, token, direction), null, `${token}: ${direction}`)
  }
  const quoted = '> alpha\n>\n> [^f]: footnote\n>     continuation\n>\n> beta\n'
  for (const [token, direction] of [
    ['alpha', 1],
    ['continuation', 1],
    ['continuation', -1],
    ['beta', -1],
  ])
    assert.equal(move(quoted, token, direction), null)
  // Unrelated blocks in a note with a definition remain movable.
  assert.equal(
    move('one\n\ntwo\n\n[^f]: footnote\n    continuation\n', 'one', 1),
    'two\n\none\n\n[^f]: footnote\n    continuation\n',
  )
})

test('unterminated fences and raw html reject moves that could absorb source', () => {
  for (const block of [
    '```txt\ncode',
    '<!-- open',
    '<script>\ncode',
    '<style>\ncode',
    '<pre>\ncode',
    '<textarea>\ncode',
  ]) {
    for (const tail of ['', '\n', '\n\n']) {
      const doc = `first\n\n${block}${tail}`
      assert.equal(move(doc, 'first', 1), null, JSON.stringify(doc))
      assert.equal(move(doc, block, -1), null, JSON.stringify(doc))
    }
  }
})

test('processing instructions reject open moves and preserve closed moves in both directions', () => {
  for (const tail of ['', '\n', '\n\n']) {
    const open = `first\n\n<?php\ncontent${tail}`
    assert.equal(
      parser.parse(open).topNode.lastChild.name,
      'ProcessingInstructionBlock',
    )
    assert.equal(move(open, 'first', 1), null)
    assert.equal(move(open, '<?php', -1), null)
    for (const block of ['<?php\ncontent\n?>', '<?php content ?>']) {
      const doc = `first\n\n${block}${tail}`
      const expected = `${block}\n\nfirst${tail}`
      assert.equal(move(doc, 'first', 1), expected)
      assert.equal(move(doc, '<?php', -1), expected)
      assert.equal(parser.parse(expected).topNode.lastChild.name, 'Paragraph')
    }
  }
})

test('closed code and html moves preserve final newline count', () => {
  for (const block of [
    '```txt\ncode\n```',
    '<!-- closed -->',
    '<script>\ncode\n</script>',
    '<div>\ncode\n</div>',
    '    code',
  ]) {
    for (const tail of ['', '\n', '\n\n']) {
      const doc = `first\n\n${block}${tail}`
      assert.equal(move(doc, 'first', 1), `${block}\n\nfirst${tail}`)
    }
  }
})

test('moves preserve crlf source, selection and shared undo/redo', () => {
  for (const eol of ['\n', '\r\n', '\r']) {
    const raw = [
      '> 9. nine 😀',
      '>    keep-nine',
      '> 10. ten',
      '>     keep-ten',
      '',
    ].join(eol)
    const expected = [
      '> 9. ten',
      '>    keep-ten',
      '> 10. nine 😀',
      '>     keep-nine',
      '',
    ].join(eol)
    const session = new DocumentSession(
      raw,
      { tabId: 'move', revision: 0 },
      0,
      {
        enqueue() {},
        onError(error) {
          throw error
        },
      },
    )
    const syntax = formattedSyntax({ slice: 1000 })
    const attach = (id) => {
      const bridge = createSourceSession(session, id)
      const view = {
        state: EditorState.create({
          doc: sourceEditorText(session.snapshot()),
          selection: { anchor: 7 },
          extensions: syntax.extension,
        }),
        update(transactions) {
          for (const transaction of transactions) this.state = transaction.state
        },
      }
      return { bridge, view, dispose: bridge.attach(view) }
    }
    const a = attach('formatted'),
      b = attach('source')
    const spec = selectionStep(a.view.state, syntax.tree(a.view.state), 1)
    a.bridge.dispatch([a.view.state.update(spec)], a.view)
    assert.equal(session.snapshot().materialize(), expected)
    assert.equal(b.view.state.doc.toString(), a.view.state.doc.toString())
    assert.equal(
      a.view.state.doc.sliceString(
        a.view.state.selection.main.head,
        a.view.state.selection.main.head + 1,
      ),
      'n',
    )
    assert.equal(session.historyDepth().undo, 1)
    b.bridge.undo()
    assert.equal(session.snapshot().materialize(), raw)
    a.bridge.redo()
    assert.equal(session.snapshot().materialize(), expected)
    a.dispose()
    b.dispose()
    session.dispose()
  }
})
