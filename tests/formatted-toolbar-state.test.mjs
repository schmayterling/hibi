import assert from 'node:assert/strict'
import test from 'node:test'
import { history, undo, undoDepth } from '@codemirror/commands'
import { DocInput } from '@codemirror/language'
import { EditorState, Text } from '@codemirror/state'
import { Tree } from '@lezer/common'
import { GFM, parser } from '@lezer/markdown'
import { Editor } from '@tiptap/core'
import { Strike } from '@tiptap/extension-strike'
import { TaskItem } from '@tiptap/extension-task-item'
import { TaskList } from '@tiptap/extension-task-list'
import { Markdown } from '@tiptap/markdown'
import { NativeTableKit } from '../src/addons/markdown/table-tokenizer.ts'
import {
  subscriptSyntax,
  subtextSyntax,
} from '../src/addons/text-extras/formatted-syntax.ts'
import { Subscript, Subtext } from '../src/addons/text-extras/nodes.ts'
import { cellLineBreak } from '../src/renderer/src/formatted/table-cells.ts'
import {
  formattedLiteral,
  formattedTree,
} from '../src/renderer/src/formatted-contributions.ts'
import { markdownConfiguration } from '../src/renderer/src/markdown.ts'
import { markdownSerializer } from '../src/renderer/src/markdown-serialization.ts'
import { markdownSyntax } from '../src/renderer/src/markdown-syntax.ts'
import {
  preserveRichSource,
  sameRichSourceDocument,
} from '../src/renderer/src/rich-source-preservation.ts'
import {
  sourceFormatting,
  tableActions,
} from '../src/renderer/src/source-formatting.ts'
import { ChunkedMarkdownParser } from '../src/shared/chunked-markdown.ts'

const markdown = parser.configure(GFM)
const note = [
  '# Title',
  'plain **bold** *italic* `code` [link](https://example.com) end',
  '- one\n- two\n  - nested',
  '1. first\n2. second',
  '- [ ] task',
  '> quote',
  '```js\nconst x = 1\n```',
  '| a | b |\n| - | - |\n| cell | 2 |',
  '',
].join('\n\n')

/** A formatted view of `doc` with the caret after `text`, `length` characters after it selected, or all of it for null. */
function view(doc, text, length, tree = markdown.parse(doc)) {
  const at = text === null ? 0 : doc.indexOf(text)
  assert.ok(at >= 0, text)
  const anchor =
    text === null ? 0 : at + (length === undefined ? text.length : 0)
  const head = text === null ? doc.length : anchor + (length ?? 0)
  return {
    state: EditorState.create({
      doc,
      selection: { anchor, head },
      extensions: formattedTree.of(() => tree),
    }),
    dispatch(spec) {
      this.state = this.state.update(spec).state
    },
    focus() {},
  }
}

/** The pressed and disabled states of `ids`: `pressed`, `disabled`, both or neither. */
function states(target, ids, formatting = sourceFormatting(target)) {
  const inspection = formatting.inspect()
  return Object.fromEntries(
    ids.map((id) => {
      const { pressed, disabled } = inspection.state(id)
      return [id, (pressed ? 'pressed ' : '') + (disabled ? 'disabled' : '')]
    }),
  )
}

const marks = ['bold', 'italic', 'inline-code', 'link', 'unlink']
const blocks = [
  'paragraph',
  'heading-1',
  'bullet-list',
  'numbered-list',
  'checklist',
  'indent',
  'outdent',
  'quote',
  'code-block',
]

test('formatted toolbar marks follow the syntax around the caret, not adjacent delimiters', () => {
  assert.deepEqual(states(view(note, 'plain **bo'), marks), {
    bold: 'pressed ',
    italic: '',
    'inline-code': '',
    link: '',
    unlink: '',
  })
  // Like the rich editor, a caret takes the marks of the text before it,
  // past hidden delimiters: on after bold text, off before it.
  assert.equal(states(view(note, '**bold'), marks).bold, 'pressed ')
  assert.equal(states(view(note, '**bold**'), marks).bold, 'pressed ')
  assert.equal(states(view(note, 'plain **'), marks).bold, '')
  assert.equal(states(view(note, 'plain '), marks).bold, '')
  assert.deepEqual(states(view(note, 'italic', 6), marks).italic, 'pressed ')
  assert.deepEqual(states(view(note, 'plain', 14), marks), {
    bold: '',
    italic: '',
    'inline-code': '',
    link: '',
    unlink: '',
  })
  assert.deepEqual(states(view(note, '`co'), marks), {
    bold: 'disabled',
    italic: 'disabled',
    'inline-code': 'pressed ',
    link: 'disabled',
    unlink: '',
  })
  assert.equal(states(view(note, '[li'), marks).link, 'pressed ')
  // Delimiters the toolbar opened at the caret are pressed until text fills them.
  assert.deepEqual(states(view('plain end****', 'plain end**'), marks), {
    bold: 'pressed ',
    italic: '',
    'inline-code': '',
    link: '',
    unlink: '',
  })
  assert.deepEqual(states(view(note, 'const'), marks), {
    bold: 'disabled',
    italic: 'disabled',
    'inline-code': 'disabled',
    link: 'disabled',
    unlink: '',
  })
})

test('formatted toolbar blocks follow the syntax tree around the selection', () => {
  assert.deepEqual(states(view(note, 'Ti'), blocks), {
    paragraph: '',
    'heading-1': 'pressed ',
    'bullet-list': 'disabled',
    'numbered-list': 'disabled',
    checklist: 'disabled',
    indent: 'disabled',
    outdent: 'disabled',
    quote: '',
    'code-block': '',
  })
  assert.deepEqual(states(view(note, 'pl'), blocks), {
    paragraph: 'pressed disabled',
    'heading-1': '',
    'bullet-list': '',
    'numbered-list': '',
    checklist: '',
    indent: 'disabled',
    outdent: 'disabled',
    quote: '',
    'code-block': '',
  })
  const item = {
    paragraph: 'pressed disabled',
    'heading-1': 'disabled',
    'bullet-list': 'pressed ',
    'numbered-list': '',
    checklist: '',
    indent: 'disabled',
    outdent: '',
    quote: 'disabled',
    'code-block': 'disabled',
  }
  assert.deepEqual(states(view(note, 'on'), blocks), item)
  assert.deepEqual(states(view(note, 'tw'), blocks), { ...item, indent: '' })
  assert.deepEqual(states(view(note, 'nes'), blocks), item)
  assert.deepEqual(states(view(note, 'sec'), blocks), {
    ...item,
    'bullet-list': '',
    'numbered-list': 'pressed ',
    indent: '',
  })
  assert.deepEqual(states(view(note, 'tas'), blocks), {
    ...item,
    'bullet-list': '',
    checklist: 'pressed ',
  })
  assert.deepEqual(states(view(note, 'quo'), blocks), {
    paragraph: 'pressed disabled',
    'heading-1': '',
    'bullet-list': '',
    'numbered-list': '',
    checklist: '',
    indent: 'disabled',
    outdent: 'disabled',
    quote: 'pressed ',
    'code-block': '',
  })
  assert.deepEqual(states(view(note, 'const'), blocks), {
    paragraph: '',
    'heading-1': '',
    'bullet-list': 'disabled',
    'numbered-list': 'disabled',
    checklist: 'disabled',
    indent: 'disabled',
    outdent: 'disabled',
    quote: '',
    'code-block': 'pressed ',
  })
  assert.equal(states(view(note, 'ce'), blocks).paragraph, 'pressed disabled')
  // A caret at a line's end, or between blocks, reads the block it types into.
  assert.equal(states(view(note, '# Title'), blocks)['heading-1'], 'pressed ')
  assert.equal(states(view(note, 'one'), blocks)['bullet-list'], 'pressed ')
  assert.equal(
    states(view(note, '# Title\n'), blocks).paragraph,
    'pressed disabled',
  )
  assert.deepEqual(states(view(note, null), blocks), {
    paragraph: '',
    'heading-1': '',
    'bullet-list': 'disabled',
    'numbered-list': 'disabled',
    checklist: 'disabled',
    indent: 'disabled',
    outdent: 'disabled',
    quote: '',
    'code-block': '',
  })
})

/** The source after running `id` on a formatted view of `doc` with the caret after `text`, or null when it changes nothing. */
function ran(id, doc, text, length) {
  const target = view(doc, text, length)
  const before = target.state
  const done = sourceFormatting(target).run(id)
  if (!done) assert.equal(target.state, before)
  return done ? target.state.doc.toString() : null
}

test('formatted unlink removes links by their syntax and leaves other text unedited', () => {
  assert.equal(
    ran('unlink', note, '[li'),
    note.replace('[link](https://example.com)', 'link'),
  )
  // As the rich editor writes them: balanced destinations, escaped labels, autolinks and references.
  assert.equal(ran('unlink', '[x](https://example.com/a(b))', '[x'), 'x')
  assert.equal(ran('unlink', '[a\\]b](https://example.com)', '[a'), 'a\\]b')
  assert.equal(
    ran('unlink', '<https://example.com>', '<http'),
    'https\\://example.com',
  )
  assert.equal(
    ran('unlink', '[a][r]\n\n[r]: https://e.test', '[a'),
    'a\n\n[r]: https://e.test',
  )
  assert.equal(ran('unlink', 'a [b](u) c [d](v) e', 'a', 13), 'a b c d e')
  // A range unlinks only its own text, as the rich editor does.
  const link = '[abcdef](https://example.com)'
  assert.equal(
    ran('unlink', link, 'cd', 2),
    '[ab](https://example.com)cd[ef](https://example.com)',
  )
  assert.equal(ran('unlink', link, 'ab', 2), 'ab[cdef](https://example.com)')
  assert.equal(ran('unlink', link, 'ef', 2), '[abcd](https://example.com)ef')
  assert.equal(ran('unlink', 'x [ab](u) y', 'b](', 1), 'x [a](u)b y')
  // A split closes the formatting it cuts and opens it again after.
  assert.equal(
    ran('unlink', '[a**bc**d](u)', 'bc', 1),
    '[a](u)**b**[**c**d](u)',
  )
  // References keep their label, and an autolink its address.
  assert.equal(
    ran('unlink', '[abc][r]\n\n[r]: u', 'abc', 1),
    'a[bc][r]\n\n[r]: u',
  )
  assert.equal(
    ran('unlink', '[abc]\n\n[abc]: u', 'abc', 1),
    'a[bc][abc]\n\n[abc]: u',
  )
  assert.equal(
    ran('unlink', '<https://e.test>', 'e.', 2),
    '[https://](https://e.test)e.[test](https://e.test)',
  )
  // A range does not split an escape.
  assert.equal(ran('unlink', '[a\\@b c](u)', '@', 1), '[a](u)\\@[b c](u)')
  // Nothing to unlink leaves the note unedited.
  assert.equal(ran('unlink', note, 'pl'), null)
})

test('a partial unlink keeps the link and formatting of the text around it, as the rich editor does', () => {
  const read = (markdown) => {
    const editor = richEditor(markdown)
    const json = JSON.stringify(editor.getJSON())
    editor.destroy()
    return json
  }
  // [note, the text holding the selection, offset, length, split]:
  // selections in one text node of the rich editor. Notes with a split are
  // edited as written, the rest as the rich editor writes them.
  for (const [input, text, offset, length, split] of [
    ['[ab**cdef**gh](https://example.com)', 'cdef', 1, 2],
    ['[ab*cdef*gh](https://example.com)', 'cdef', 1, 2],
    ['[abcdefgh](https://example.com)', 'abcdefgh', 3, 2],
    ['[a***bcd***e](https://example.com)', 'bcd', 1, 1],
    ['[a**b*cd*e**f](https://example.com)', 'cd', 1, 1],
    ['[ab**cd**ef](https://example.com)', 'cd', 0, 2],
    ['[ab**cd**ef](https://example.com)', 'cd', 0, 1],
    ['[ab**cd**ef](https://example.com)', 'ef', 0, 1],
    ['[a`bcd`e](https://example.com)', 'bcd', 1, 1],
    ['[**abc**](https://example.com)', 'abc', 1, 1],
    ['x [ab**cd**](https://example.com) y', 'cd', 1, 1],
    [
      '[abcdef][r]\n\n[r]: https://example.com',
      'abcdef',
      2,
      2,
      '[ab][r]cd[ef][r]\n\n[r]: https://example.com',
    ],
    [
      '[abcdef]\n\n[abcdef]: https://example.com',
      'abcdef',
      2,
      2,
      '[ab][abcdef]cd[ef][abcdef]\n\n[abcdef]: https://example.com',
    ],
    [
      '[abcdef][]\n\n[abcdef]: https://example.com',
      'abcdef',
      2,
      2,
      '[ab][abcdef]cd[ef][abcdef]\n\n[abcdef]: https://example.com',
    ],
    [
      '[ab**cdef**gh][r]\n\n[r]: https://example.com',
      'cdef',
      1,
      2,
      '[ab**c**][r]**de**[**f**gh][r]\n\n[r]: https://example.com',
    ],
    [
      '<https://example.com>',
      'https://example.com',
      11,
      2,
      '[https://exa](https://example.com)mp[le.com](https://example.com)',
    ],
    [
      '<https://example.com>',
      'https://example.com',
      0,
      8,
      'https\\://[example.com](https://example.com)',
    ],
    // Unlinked text from an address does not read as one again.
    [
      '<https://e.test/path>',
      'https://e.test/path',
      0,
      17,
      'https\\://e.test/pa[th](https://e.test/path)',
    ],
    [
      '<https://e.test/path>',
      'https://e.test/path',
      0,
      19,
      'https\\://e.test/path',
    ],
    [
      '<HTTPS://EXAMPLE.COM/a>',
      'HTTPS://EXAMPLE.COM/a',
      0,
      10,
      'HTTPS\\://EX[AMPLE.COM/a](HTTPS://EXAMPLE.COM/a)',
    ],
    [
      '<https://www.example.com>',
      'https://www.example.com',
      8,
      15,
      '[https://](https://www.example.com)www\\.example.com',
    ],
    [
      '<a_b.c@example.com>',
      'a_b.c@example.com',
      1,
      14,
      '[a](mailto:a\\_b.c@example.com)\\_b.c\\@example.c[om](mailto:a\\_b.c@example.com)',
    ],
    [
      '<https://x.com/(a)>',
      'https://x.com/(a)',
      8,
      5,
      '[https://](<https://x.com/(a)>)x.com[/(a)](<https://x.com/(a)>)',
    ],
    [
      '<https://x.com/*a*&amp;>',
      'https://x.com/*a*&amp;',
      8,
      5,
      '[https://](https://x.com/\\*a\\*&amp;amp;)x.com[/\\*a\\*&amp;amp;](https://x.com/\\*a\\*&amp;amp;)',
    ],
    ['<a@b.co>', 'a@b.co', 2, 4, '[a@](mailto:a@b.co)b.co'],
    // So does unlinked text of a link that reads as an address.
    [
      '[https://e.test/path](https://else.test)',
      'https://e.test/path',
      0,
      16,
      'https\\://e.test/p[ath](https://else.test)',
    ],
    [
      '[https://e.test/path][r]\n\n[r]: https://else.test',
      'https://e.test/path',
      0,
      16,
      'https\\://e.test/p[ath][r]\n\n[r]: https://else.test',
    ],
    [
      '[www.example.com](https://else.test)',
      'www.example.com',
      0,
      15,
      'www\\.example.com',
    ],
    ['[a@b.co](https://else.test)', 'a@b.co', 0, 6, 'a\\@b.co'],
    [
      '[mail a@b.co](https://e.test)',
      'mail a@b.co',
      5,
      6,
      '[mail ](https://e.test)a\\@b.co',
    ],
    // Code split by the range is fenced and padded again around its text.
    [
      '[abc` DEFghi `jkl](https://e.test)',
      'DEFghi',
      0,
      3,
      '[abc](https://e.test)`DEF`[`ghi`jkl](https://e.test)',
    ],
    [
      '[abc`  DEFghi  `jkl](https://e.test)',
      'DEFghi',
      0,
      3,
      '[abc` `](https://e.test)`DEF`[`ghi `jkl](https://e.test)',
    ],
    [
      '[``a`b``](https://e.test)',
      'a`b',
      1,
      1,
      '[`a`](https://e.test)`` ` ``[`b`](https://e.test)',
    ],
    // A delimiter next to a space spells the space as a character reference.
    [
      '[*a `b c` d*](https://e.test)',
      'a',
      0,
      1,
      '*a*[*&#32;`b c` d*](https://e.test)',
    ],
  ]) {
    const editor = richEditor(input)
    const source = split ? input : editor.getMarkdown()
    let from
    editor.state.doc.descendants((node, pos) => {
      if (from === undefined && node.isText && node.text.includes(text))
        from = pos + node.text.indexOf(text) + offset
    })
    editor.commands.setTextSelection({ from, to: from + length })
    editor.commands.unsetLink()
    const anchor = source.indexOf(text) + offset
    const target = {
      state: EditorState.create({
        doc: source,
        selection: { anchor, head: anchor + length },
        extensions: [
          history(),
          formattedTree.of((state) => markdown.parse(state.doc.toString())),
        ],
      }),
      dispatch(spec) {
        target.state = target.state.update(spec).state
      },
      focus() {},
    }
    assert.equal(sourceFormatting(target).run('unlink'), true)
    const actual = target.state.doc.toString()
    if (split) assert.equal(actual, split)
    // The same text and marks as the rich editor's, though it spells some with HTML.
    assert.equal(read(actual), JSON.stringify(editor.getJSON()), actual)
    const { from: start, to: end } = target.state.selection.main
    assert.equal(
      actual.slice(start, end).replace(/\\(.)/g, '$1'),
      text.slice(offset, offset + length),
    )
    // The formatted view reads no link in the unlinked text either.
    markdown.parse(actual).iterate({
      from: start,
      to: end,
      enter: (node) =>
        assert.ok(
          !/^(Link|Autolink|URL)$/.test(node.name) ||
            node.to <= start ||
            node.from >= end,
          actual,
        ),
    })
    assert.equal(undoDepth(target.state), 1)
    undo(target)
    assert.equal(target.state.doc.toString(), source)
    editor.destroy()
  }
  // A range across formatting splits at both of its edges.
  const crossing = {
    state: EditorState.create({
      doc: '[ab**cd**ef](u)',
      selection: { anchor: 2, head: 6 },
      extensions: formattedTree.of((state) =>
        markdown.parse(state.doc.toString()),
      ),
    }),
    dispatch(spec) {
      crossing.state = crossing.state.update(spec).state
    },
    focus() {},
  }
  sourceFormatting(crossing).run('unlink')
  assert.equal(crossing.state.doc.toString(), '[a](u)b**c**[**d**ef](u)')
})

test('with escaped punctuation turned off, unlinked text spells punctuation as character references', () => {
  markdownSyntax.setEnabled('core.escapes', false)
  try {
    // [note, the text holding the selection, offset, length, result]
    for (const [input, text, offset, length, result] of [
      [
        '[www.example.com](https://else.test)',
        'www.example.com',
        0,
        15,
        'www&#46;example.com',
      ],
      ['[a@b.co](https://else.test)', 'a@b.co', 0, 6, 'a&#64;b.co'],
      [
        '[https://e.test/path](https://else.test)',
        'https://e.test/path',
        0,
        16,
        'https&#58;//e.test/p[ath](https://else.test)',
      ],
      [
        '<https://x.com/*a*>',
        'https://x.com/*a*',
        8,
        5,
        '[https://](https://x.com/&#42;a&#42;)x.com[/&#42;a&#42;](https://x.com/&#42;a&#42;)',
      ],
    ]) {
      const editor = richEditor(input)
      let from
      editor.state.doc.descendants((node, pos) => {
        if (from === undefined && node.isText && node.text.includes(text))
          from = pos + node.text.indexOf(text) + offset
      })
      editor.commands.setTextSelection({ from, to: from + length })
      editor.commands.unsetLink()
      const anchor = input.indexOf(text) + offset
      const target = {
        state: EditorState.create({
          doc: input,
          selection: { anchor, head: anchor + length },
          extensions: [
            history(),
            formattedLiteral.of('Escape'),
            formattedTree.of((state) => markdown.parse(state.doc.toString())),
          ],
        }),
        dispatch(spec) {
          target.state = target.state.update(spec).state
        },
        focus() {},
      }
      assert.equal(sourceFormatting(target).run('unlink'), true)
      const actual = target.state.doc.toString()
      assert.equal(actual, result)
      // The rich editor reads the same text and marks, with no backslash shown.
      const read = editor.schema.nodeFromJSON(editor.markdown.parse(actual))
      assert.ok(sameRichSourceDocument(read, editor.state.doc, true), actual)
      assert.equal(undoDepth(target.state), 1)
      undo(target)
      assert.equal(target.state.doc.toString(), input)
      editor.destroy()
    }
  } finally {
    markdownSyntax.reset()
  }
})

test('a code label with many backtick runs splits within the call stack', () => {
  const source = `[\`\`${'a`'.repeat(131072)}z\`\`](https://e.test)`
  const target = {
    state: EditorState.create({
      doc: source,
      selection: { anchor: 6, head: 7 },
      extensions: [
        history(),
        formattedTree.of((state) => markdown.parse(state.doc.toString())),
      ],
    }),
    dispatch(spec) {
      target.state = target.state.update(spec).state
    },
    focus() {},
  }
  assert.equal(sourceFormatting(target).run('unlink'), true)
  const actual = target.state.doc.toString()
  assert.ok(
    actual.startsWith('[``a`a``](https://e.test)`` ` ``[``a`a`'),
    actual.slice(0, 60),
  )
  assert.ok(actual.endsWith('a`z``](https://e.test)'), actual.slice(-30))
  undo(target)
  assert.equal(target.state.doc.toString(), source)
})

test('the pressed code block action turns fenced code back into text', () => {
  assert.equal(ran('code-block', '```js\ncodeA\n```', 'co'), 'codeA')
  assert.equal(ran('code-block', '> ```\n> a\n> b\n> ```', '> a'), '> a\n> b')
  assert.equal(ran('code-block', '- ```\n  a\n  ```', '  a'), '- a')
})

test('formatted toolbar states match the reviewed rich editor outcomes', () => {
  const at = (doc, anchor, head = anchor, extensions = []) =>
    sourceFormatting({
      state: EditorState.create({
        doc,
        selection: { anchor, head },
        extensions: [
          formattedTree.of(() => markdown.parse(doc)),
          ...extensions,
        ],
      }),
    }).inspect()
  const state = (inspection, id) => {
    const { pressed, disabled } = inspection.state(id)
    return { pressed, disabled }
  }
  // An interior heading is not a paragraph, and a list can wrap from the first paragraph.
  const mixed = at('aa\n\n# mid\n\nzz', 1, 12)
  assert.deepEqual(state(mixed, 'paragraph'), {
    pressed: false,
    disabled: false,
  })
  assert.deepEqual(state(mixed, 'bullet-list'), {
    pressed: false,
    disabled: false,
  })
  // Marks hold over all of a range's text, across blocks.
  assert.deepEqual(state(at('**aa**\n\n**zz**', 3, 11), 'bold'), {
    pressed: true,
    disabled: false,
  })
  assert.equal(at('preA **boldB** postC', 7).state('bold').pressed, false)
  assert.equal(
    at('preA https://example.com postB', 10).state('link').pressed,
    true,
  )
  // Delimiters in code are its text.
  for (const [doc, caret] of [
    ['````\n****\n````', 6],
    ['`****`', 3],
  ])
    assert.deepEqual(state(at(doc, caret), 'bold'), {
      pressed: false,
      disabled: true,
    })
  // A disabled syntax feature has no action.
  assert.deepEqual(
    state(
      at('preA **boldB** postC', 9, 9, [formattedLiteral.of('StrongEmphasis')]),
      'bold',
    ),
    { pressed: false, disabled: true },
  )
})

/** The rich editor's flavors and the formatted view's syntax for its markdown. */
const flavors = [
  {
    id: 'github',
    markedOptions: { gfm: true },
    richExtensions: [
      Strike,
      NativeTableKit.configure({ table: { resizable: false } }),
      TaskList,
      TaskItem.configure({ nested: true }),
    ],
  },
  { id: 'text-extras', richExtensions: [Subscript, Subtext] },
]
const grammar = parser.configure([GFM, subscriptSyntax, subtextSyntax])

/** A headless rich editor of `content`. */
function richEditor(content) {
  const { core, addons, parser, options } = markdownConfiguration(flavors)
  return new Editor({
    element: null,
    extensions: [
      ...core,
      Markdown.configure({ marked: parser, markedOptions: options }),
      ...addons,
    ],
    content,
    contentType: 'markdown',
  })
}

// accepted difference toolbar-001: a list or quote is not active for a
// range with blocks outside every one of them; the rich editor counts the
// positions of nested lists twice and can report the list.
const containerTypes = ['bulletList', 'orderedList', 'taskList', 'blockquote']
/** Whether the rich selection touches a text block outside every `type` node. */
const outside = (editor, type) => {
  const { from, to } = editor.state.selection
  let found = false
  editor.state.doc.nodesBetween(from, to, (node, pos) => {
    if (found || !node.isTextblock) return !found
    const $pos = editor.state.doc.resolve(pos + 1)
    let inside = false
    for (let depth = $pos.depth; depth > 0; depth--)
      if ($pos.node(depth).type.name === type) inside = true
    if (!inside) found = true
    return false
  })
  return found
}

/** The rich editor's pressed state for `active`, without the double counting of toolbar-001. */
const doubleCounted = (editor, active) =>
  containerTypes.includes(active) &&
  editor.isActive(active) &&
  outside(editor, active)
const richPressed = (editor, active, attrs) =>
  !!active && editor.isActive(active, attrs) && !doubleCounted(editor, active)
/** The rich editor's disabled state; its quote toggle refuses a double-counted quote, which the formatted view joins. */
const richDisabled = (editor, active, allowed) =>
  !allowed && !(active === 'blockquote' && doubleCounted(editor, active))

/** A seeded generator from the high bits of a 32-bit LCG. */
function random(seed) {
  let state = seed
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return (state >>> 8) / 0x1000000
  }
}

test('formatted toolbar states match the rich toolbar on random selections', () => {
  // FormattingToolbar's rich checks.
  const list = (editor) =>
    editor.isActive('taskList') ? 'taskItem' : 'listItem'
  const actions = [
    ['bold', 'bold', (c) => c.toggleBold()],
    ['italic', 'italic', (c) => c.toggleItalic()],
    ['strike', 'strike', (c) => c.toggleStrike()],
    ['inline-code', 'code', (c) => c.toggleCode()],
    ['subscript', 'subscript', (c) => c.toggleMark('subscript')],
    ['subtext', 'subtext', (c) => c.setNode('subtext')],
    ['paragraph', 'paragraph', (c) => c.setParagraph()],
    ...[1, 2, 3, 4, 5, 6].map((level) => [
      `heading-${level}`,
      'heading',
      (c) => c.toggleHeading({ level }),
      { level },
    ]),
    ['bullet-list', 'bulletList', (c) => c.toggleBulletList()],
    ['numbered-list', 'orderedList', (c) => c.toggleOrderedList()],
    ['checklist', 'taskList', (c) => c.toggleTaskList()],
    ['indent', null, (c, editor) => c.sinkListItem(list(editor))],
    ['outdent', null, (c, editor) => c.liftListItem(list(editor))],
    ['quote', 'blockquote', (c) => c.toggleBlockquote()],
    ['code-block', 'codeBlock', (c) => c.toggleCodeBlock()],
    ['hard-break', null, (c) => c.setHardBreak()],
    ['link', 'link', (c) => c.setLink({ href: 'https://example.com' })],
    ['unlink', null, (c) => c.unsetLink()],
  ]
  // accepted difference input-071: block actions stay disabled while the
  // selection's head is in a table cell.
  const cellBlocks = [
    'paragraph',
    'subtext',
    ...[1, 2, 3, 4, 5, 6].map((level) => `heading-${level}`),
    'bullet-list',
    'numbered-list',
    'checklist',
    'indent',
    'outdent',
    'quote',
    'code-block',
  ]
  const documents = [
    'plainA\n\n# headingB\n\nplainC',
    '**boldA**\n\n**boldB**',
    'preA **boldB** postC',
    '**outerA *innerB* tailC**',
    'preA [linkB](https://example.com) postC',
    'preA https://example.com postB',
    '- itemA\n- itemB\n  - itemC\n\nplainD',
    '- itemA\n\n  itemB\n- itemC',
    '> quoteA\n>\n> # headingB\n>\n> quoteC\n\nplainD',
    '> quoteA\n>\n> > quoteB\n>\n> quoteC\n\nplainD',
    '```js\ncodeA\n```\n\nplainB\n\n```\ncodeC\n```',
    '# headingA\n\n## headingB\n\n###### headingC',
    '**boldA** `codeB` **boldC**',
    'preA ~~strikeB~~ postC',
    'preA ~subscriptB~ postC',
    '-# smallA\n\nplainB',
    '- [ ] taskA\n- [x] taskB\n  - [ ] taskC\n\nplainD',
    '| headerA | headerB |\n| --- | --- |\n| cellC | cellD |',
    note,
  ]
  const mismatches = []
  let comparisons = 0
  for (const seed of [0x552c0ffe, 0x552a11ce]) {
    const next = random(seed)
    for (const input of documents) {
      const editor = richEditor(input)
      // The rich editor's source and each text's position in both editors.
      const source = editor.getMarkdown()
      const tree = grammar.parse(source)
      const points = []
      editor.state.doc.descendants((node, pos) => {
        if (!node.isText) return
        const at = source.indexOf(node.text)
        if (at < 0 || source.indexOf(node.text, at + 1) >= 0) return
        for (const offset of new Set([
          0,
          1,
          Math.floor(node.text.length / 2),
          node.text.length,
        ]))
          points.push({ rich: pos + offset, formatted: at + offset })
      })
      const table = (view) => {
        for (
          let node = tree.resolveInner(view.state.selection.main.head, 1);
          node;
          node = node.parent
        )
          if (node.name === 'Table') return true
        return false
      }
      for (let round = 0; round < 40; round++) {
        const a = points[Math.floor(next() * points.length)]
        const b = next() < 0.4 ? a : points[Math.floor(next() * points.length)]
        editor.commands.setTextSelection({
          from: Math.min(a.rich, b.rich),
          to: Math.max(a.rich, b.rich),
        })
        const target = {
          state: EditorState.create({
            doc: source,
            selection: {
              anchor: Math.min(a.formatted, b.formatted),
              head: Math.max(a.formatted, b.formatted),
            },
            extensions: [
              formattedTree.of(() => tree),
              tableActions.of({ active: table, run: () => false }),
            ],
          }),
        }
        const inspection = sourceFormatting(target).inspect()
        const inCell = table(target)
        for (const [id, active, command, attrs] of actions) {
          let allowed = false
          try {
            allowed = command(editor.can().chain(), editor).run()
          } catch {}
          const expected = {
            pressed: richPressed(editor, active, attrs),
            disabled:
              richDisabled(editor, active, allowed) ||
              (inCell && cellBlocks.includes(id)),
          }
          const { pressed, disabled } = inspection.state(id)
          comparisons++
          if (pressed !== expected.pressed || disabled !== expected.disabled)
            mismatches.push({
              source,
              selection: target.state.selection.main,
              id,
              expected,
            })
        }
      }
      editor.destroy()
    }
  }
  assert.ok(comparisons > 30000)
  assert.deepEqual(mismatches.slice(0, 5), [])
})

test("accepted difference toolbar-001 covers the rich editor's double-counted lists and quotes", () => {
  for (const [id, type, input, start, nested] of [
    [
      'bullet-list',
      'bulletList',
      '- itemA\n- itemB\n  - itemC\n\nplainD',
      'itemB',
      'itemC',
    ],
    [
      'checklist',
      'taskList',
      '- [ ] taskA\n- [x] taskB\n  - [ ] taskC\n\nplainD',
      'taskB',
      'taskC',
    ],
    [
      'numbered-list',
      'orderedList',
      '1. itemA\n2. itemB\n   1. itemC\n\nplainD',
      'itemB',
      'itemC',
    ],
    [
      'quote',
      'blockquote',
      '> quoteA\n>\n> > quoteB\n>\n> quoteC\n\nplainD',
      'quoteB',
      'quoteB',
    ],
  ]) {
    const editor = richEditor(input)
    const source = editor.getMarkdown()
    const position = (text) => {
      let at
      editor.state.doc.descendants((node, pos) => {
        if (at === undefined && node.isText && node.text.includes(text))
          at = pos + node.text.indexOf(text)
      })
      return at
    }
    const command = {
      bulletList: (c) => c.toggleBulletList(),
      taskList: (c) => c.toggleTaskList(),
      orderedList: (c) => c.toggleOrderedList(),
      blockquote: (c) => c.toggleBlockquote(),
    }[type]
    const formatted = (anchor, head) => {
      const target = {
        state: EditorState.create({
          doc: source,
          selection: { anchor, head },
          extensions: [
            history(),
            formattedTree.of((state) => markdown.parse(state.doc.toString())),
          ],
        }),
        dispatch(spec) {
          target.state = target.state.update(spec).state
        },
        focus() {},
      }
      return target
    }
    // From inside the nested node into the paragraph after the list or quote.
    editor.commands.setTextSelection({
      from: position(start) + 1,
      to: position('plainD') + 3,
    })
    assert.equal(editor.isActive(type), true, id)
    const outside = formatted(
      source.indexOf(start) + 1,
      source.indexOf('plainD') + 3,
    )
    const state = sourceFormatting(outside).inspect().state(id)
    assert.equal(state.pressed, false, id)
    if (type === 'blockquote') {
      // The rich editor's toggle tries to lift its double-counted quote and
      // refuses; the formatted view quotes the selected blocks, which join
      // the quote around the selection's start.
      assert.equal(command(editor.can().chain()).run(), false)
      assert.equal(state.disabled, false)
      assert.equal(sourceFormatting(outside).run('quote'), true)
      assert.equal(
        outside.state.doc.toString(),
        '> quoteA\n>\n> > quoteB\n> >\n> quoteC\n> \n> plainD',
      )
      assert.equal(
        richEditor(outside.state.doc.toString()).state.doc.toString(),
        'doc(blockquote(paragraph("quoteA"), blockquote(paragraph("quoteB")), paragraph("quoteC"), paragraph("plainD")))',
      )
      assert.equal(undoDepth(outside.state), 1)
    } else
      assert.equal(state.disabled, !command(editor.can().chain()).run(), id)
    // Inside the nested node both editors report it.
    editor.commands.setTextSelection({
      from: position(start) + 1,
      to: position(nested) + 2,
    })
    assert.equal(editor.isActive(type), true, id)
    const inside = formatted(
      source.indexOf(start) + 1,
      source.indexOf(nested) + 2,
    )
    assert.equal(sourceFormatting(inside).inspect().state(id).pressed, true, id)
    editor.destroy()
  }
})

/** Syntax tree steps: node and cursor moves between parents, children and siblings. */
function treeSteps(tree, run) {
  let steps = 0
  const restore = []
  const count = (prototype, name) => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name)
    if (!descriptor) return
    const wrapped = descriptor.get
      ? {
          ...descriptor,
          get() {
            steps++
            return descriptor.get.call(this)
          },
        }
      : {
          ...descriptor,
          value(...args) {
            steps++
            return descriptor.value.apply(this, args)
          },
        }
    Object.defineProperty(prototype, name, wrapped)
    restore.push(() => Object.defineProperty(prototype, name, descriptor))
  }
  for (const name of [
    'firstChild',
    'lastChild',
    'nextSibling',
    'prevSibling',
    'parent',
    'next',
    'prev',
    'enter',
    'childAfter',
    'childBefore',
    'moveTo',
  ])
    count(Object.getPrototypeOf(tree.cursor()), name)
  const nodes = new Set([
    Object.getPrototypeOf(tree.topNode),
    Object.getPrototypeOf(tree.resolveInner(3, 1)),
  ])
  for (const prototype of nodes)
    for (const name of [
      'firstChild',
      'lastChild',
      'nextSibling',
      'prevSibling',
      'parent',
      'childAfter',
      'childBefore',
      'getChild',
      'getChildren',
      'enter',
    ])
      count(prototype, name)
  try {
    run()
  } finally {
    for (const undo of restore) undo()
  }
  return steps
}

for (const [name, parse] of [
  ['lezer', (doc) => markdown.parse(doc)],
  [
    'chunked',
    (doc) =>
      new ChunkedMarkdownParser(markdown, markdown, {
        opaque: new Set(['FencedCode', 'CodeBlock']),
      }).parse(new DocInput(Text.of(doc.split('\n')))),
  ],
])
  test(`formatted toolbar inspection walks a bounded part of the ${name} syntax tree`, () => {
    const ids = [...marks, ...blocks, 'subtext', 'strike', 'subscript']
    const steps = (doc, anchor, head = anchor) => {
      const tree = parse(doc)
      const target = {
        state: EditorState.create({
          doc,
          selection: { anchor, head },
          extensions: formattedTree.of(() => tree),
        }),
      }
      const formatting = sourceFormatting(target)
      return treeSteps(tree, () => states(target, ids, formatting))
    }
    // A caret at the end of a link's text finds its `]` from the link's end, not by reading its text.
    const link = (spans) => {
      const doc = `pre [${'**b** '.repeat(spans)}xy](https://e.test) post`
      return steps(doc, doc.indexOf('xy') + 1)
    }
    assert.equal(link(32768), link(512))
    assert.ok(link(32768) < 64)
    // A caret, or a range of three items, in a list of 200,000 items: a
    // balanced tree adds a few steps for each tenfold growth, not one per item.
    const items = (count) => {
      const doc = `${Array.from({ length: count }, (_, i) => `- item${i}`).join('\n')}\n`
      const from = doc.indexOf('item10') + 2
      return {
        caret: steps(doc, from),
        range: steps(doc, from, doc.indexOf('item13') + 3),
      }
    }
    const small = items(20),
      large = items(200000)
    assert.equal(large.caret, small.caret)
    assert.ok(large.range - small.range < 64, `${small.range} ${large.range}`)
  })

test('formatted toolbar states match the rich toolbar with syntax features turned off', () => {
  const features = [
    'core.bold',
    'core.italic',
    'core.inline-code',
    'core.links',
    'core.heading-1',
    'core.code-blocks',
    'core.quotes',
    'core.bullet-lists',
    'core.numbered-lists',
  ]
  const documents = [
    'aa **outerA *innerB* tailC** zz',
    'aa **boldB** zz',
    '**boldA**\n\n**boldB**',
    'aa [**boldB**](https://example.com) zz',
    'preA `codeB` postC',
    '# titleA\n\nplainB *italicC*',
    '```js\ncodeA\n```\n\nplainB',
    '> quoteA\n\nplainB',
    '- itemA\n- itemB\n\n1. oneC\n2. twoD',
    note,
  ]
  const actions = [
    ['bold', 'bold', (c) => c.toggleBold()],
    ['italic', 'italic', (c) => c.toggleItalic()],
    ['inline-code', 'code', (c) => c.toggleCode()],
    ['link', 'link', (c) => c.setLink({ href: 'https://example.com' })],
    ['unlink', null, (c) => c.unsetLink()],
    ['paragraph', 'paragraph', (c) => c.setParagraph()],
    [
      'heading-2',
      'heading',
      (c) => c.toggleHeading({ level: 2 }),
      { level: 2 },
    ],
    ['bullet-list', 'bulletList', (c) => c.toggleBulletList()],
    ['numbered-list', 'orderedList', (c) => c.toggleOrderedList()],
    ['quote', 'blockquote', (c) => c.toggleBlockquote()],
    ['code-block', 'codeBlock', (c) => c.toggleCodeBlock()],
  ]
  const next = random(0x552d15ab)
  const mismatches = []
  let comparisons = 0
  for (const feature of features) {
    markdownSyntax.setEnabled(feature, false)
    try {
      const literal = markdownSyntax
        .snapshot()
        .find(({ id }) => id === feature).nodes
      for (const input of documents) {
        // The note as the rich editor reads its own saved source back.
        const source = richEditor(input).getMarkdown()
        const editor = richEditor(source)
        // Task lists are the GitHub flavor's in the rich editor, whatever bullet lists do.
        if (feature === 'core.bullet-lists' && /\[[ x]\]/.test(source)) continue
        const tree = grammar.parse(source)
        const points = []
        editor.state.doc.descendants((node, pos, parent) => {
          if (!node.isText) return
          const at = source.indexOf(node.text)
          if (at < 0 || source.indexOf(node.text, at + 1) >= 0) return
          // A literal atom's text edges are also the positions beside it.
          const atom = parent?.type.name.startsWith('hibiLiteral')
          const offsets = atom
            ? [1, Math.floor(node.text.length / 2), node.text.length - 1]
            : [0, 1, Math.floor(node.text.length / 2), node.text.length]
          for (const offset of new Set(offsets))
            if (!atom || (offset > 0 && offset < node.text.length))
              points.push({ rich: pos + offset, formatted: at + offset })
        })
        for (let round = 0; round < 12 && points.length; round++) {
          const a = points[Math.floor(next() * points.length)]
          const b =
            next() < 0.5 ? a : points[Math.floor(next() * points.length)]
          editor.commands.setTextSelection({
            from: Math.min(a.rich, b.rich),
            to: Math.max(a.rich, b.rich),
          })
          const inspection = sourceFormatting({
            state: EditorState.create({
              doc: source,
              selection: {
                anchor: Math.min(a.formatted, b.formatted),
                head: Math.max(a.formatted, b.formatted),
              },
              extensions: [
                formattedTree.of(() => tree),
                literal.map((name) => formattedLiteral.of(name)),
              ],
            }),
          }).inspect()
          for (const [id, active, command, attrs] of actions) {
            let allowed = false
            try {
              allowed = command(editor.can().chain()).run()
            } catch {}
            const expected = {
              pressed: richPressed(editor, active, attrs),
              disabled: richDisabled(editor, active, allowed),
            }
            const { pressed, disabled } = inspection.state(id)
            comparisons++
            if (pressed !== expected.pressed || disabled !== expected.disabled)
              mismatches.push({
                feature,
                source,
                selection: [a.formatted, b.formatted],
                id,
                expected,
              })
          }
        }
        editor.destroy()
      }
    } finally {
      markdownSyntax.reset()
    }
  }
  assert.ok(comparisons > 5000, String(comparisons))
  assert.deepEqual(mismatches.slice(0, 5), [])
})

/** A tree for `unit` repeated `count` times, built from one parse of it, as balanced as a parse's. */
function repeated(unit, count) {
  const part = markdown.parse(unit)
  const children = [],
    positions = []
  for (let index = 0; index < count; index++)
    part.children.forEach((child, child_index) => {
      children.push(child)
      positions.push(part.positions[child_index] + index * unit.length)
    })
  return {
    doc: unit.repeat(count),
    tree: new Tree(
      part.type,
      children,
      positions,
      unit.length * count,
    ).balance(),
  }
}

test('a range of mixed blocks stops reading once every state is known', () => {
  const ids = [...marks, ...blocks, 'subtext', 'strike', 'subscript']
  const unit =
    '# heading\n\nplain **bold** *it* `code` [l](u) text\n\n- one\n- two\n\n> quote\n\n'
  const steps = (count, end = 0) => {
    const { doc, tree } = repeated(unit, count)
    const target = {
      state: EditorState.create({
        doc,
        selection: { anchor: 0, head: doc.length - end },
        extensions: formattedTree.of(() => tree),
      }),
    }
    const formatting = sourceFormatting(target)
    return treeSteps(tree, () => states(target, ids, formatting))
  }
  // Select all, then shrink by one: the same few blocks are read in a note
  // of 20 or 20,000 of them, plus a balanced tree's few steps per tenfold growth.
  for (const end of [0, 1]) {
    const small = steps(20, end),
      large = steps(20000, end)
    assert.ok(small > 20, `${small}`)
    assert.ok(large - small < 64, `${small} ${large}`)
  }
})

test('a range of one kind of block reads it in one pass', () => {
  const ids = [...marks, ...blocks, 'subtext', 'strike', 'subscript']
  for (const count of [2000, 20000]) {
    const { doc, tree } = repeated('plain text\n\n', count)
    const target = {
      state: EditorState.create({
        doc,
        selection: { anchor: 0, head: doc.length },
        extensions: formattedTree.of(() => tree),
      }),
    }
    const formatting = sourceFormatting(target)
    const inspection = treeSteps(tree, () => states(target, ids, formatting))
    // The rich editor checks every block of such a selection too; one walk over them is the floor.
    const pass = treeSteps(tree, () =>
      tree.iterate({ from: 0, to: doc.length, enter() {} }),
    )
    assert.ok(inspection >= pass / 2, `${inspection} ${pass}`)
    // Each block's own markers are read once more, so a few steps per block.
    assert.ok(inspection <= 3 * pass, `${inspection} ${pass}`)
  }
})

/** Characters read from documents and syntax tree lookups while `run` inspects. */
function counted(run) {
  const reads = { chars: 0, resolves: 0, scans: 0 }
  const restore = []
  // A large document's text reads its parts' text: count only the outermost call.
  let depth = 0
  const patch = (target, name, count) => {
    const original = target[name]
    target[name] = function (...args) {
      depth++
      try {
        const result = original.apply(this, args)
        if (depth === 1) count(result)
        return result
      } finally {
        depth--
      }
    }
    restore.push(() => {
      target[name] = original
    })
  }
  const leaf = Object.getPrototypeOf(Text.of(['a']))
  const node = Object.getPrototypeOf(Text.of(Array(1000).fill('a')))
  for (const prototype of new Set([leaf, node])) {
    patch(prototype, 'sliceString', (text) => {
      reads.chars += text.length
    })
  }
  patch(Object.getPrototypeOf(leaf), 'lineAt', (line) => {
    reads.chars += line.length
  })
  patch(Tree.prototype, 'resolveInner', () => reads.resolves++)
  for (const name of ['iterate', 'cursor', 'cursorAt'])
    patch(Tree.prototype, name, () => reads.scans++)
  try {
    run()
  } finally {
    for (const undo of restore) undo()
  }
  return reads
}

test('formatted toolbar inspection reads the same text and syntax in a 50 MiB note as in a small one', () => {
  const ids = [...marks, ...blocks, 'subtext', 'strike', 'subscript']
  const code = (line) => `${note}\`\`\`\n${line}\n\`\`\`\n`
  const small = code('x')
  const large = code('x'.repeat(50 * 1024 * 1024))
  const trees = new Map([small, large].map((doc) => [doc, markdown.parse(doc)]))
  for (const [text, length] of [
    ['plain **bo'],
    ['[li'],
    ['tw'],
    ['plain', 14],
    // A caret in the last line, which is giant in the large note.
    ['```\nx'],
    [null],
  ]) {
    const inspect = (doc) => {
      const target = view(doc, text, length, trees.get(doc))
      const formatting = sourceFormatting(target)
      return counted(() => states(target, ids, formatting))
    }
    const expected = inspect(small)
    assert.deepEqual(inspect(large), expected, String(text))
    // A caret walks up from its position; only a range reads its syntax in order.
    if (length === undefined && text !== null) assert.equal(expected.scans, 0)
  }
  // A note of 50 MiB of headings, formatting, lists and quotes.
  const unit =
    '# heading\n\nplain **bold** *it* `code` [l](u) text\n\n- one\n- two\n\n> quote\n\n'
  const rich = repeated(unit, Math.ceil((50 * 1024 * 1024) / unit.length))
  const brief = repeated(unit, 3)
  for (const [anchor, head] of [
    [unit.indexOf('**bold') + 4],
    [unit.indexOf('[l') + 2],
    [unit.indexOf('two') + 1],
    [unit.indexOf('plain'), unit.indexOf('one')],
    [0, null],
  ]) {
    const inspect = ({ doc, tree }) => {
      const target = {
        state: EditorState.create({
          doc,
          selection: {
            anchor,
            head: head === null ? doc.length : (head ?? anchor),
          },
          extensions: formattedTree.of(() => tree),
        }),
      }
      const formatting = sourceFormatting(target)
      return counted(() => states(target, ids, formatting))
    }
    const expected = inspect(brief)
    assert.ok(expected.chars > 0, `${anchor}`)
    assert.deepEqual(inspect(rich), expected, `${anchor} ${head}`)
  }
})

/**
 * The source each toolbar action writes, against the rich editor's: a note
 * with each kind of block, a caret or range in each, and each action the
 * formatted view enables there. Differences that main already had are
 * ledgered by cause.
 */
test("formatted toolbar actions write the rich editor's source", async (t) => {
  const note = [
    '# headA',
    'plainB **boldC** *italicD* ~~strikeE~~ `codeF` [linkG](https://example.com) tailQ',
    '- oneH\n- twoI\n  - nestedJ',
    '1. firstK\n2. secondL',
    '- [ ] taskM',
    '> quoteN',
    '```js\ncodeO\n```',
    '| a | b |\n| - | - |\n| cellP | 2 |',
  ].join('\n\n')
  const selections = [
    ['heading', 'headA'],
    ['plain', 'plainB'],
    ['bold', 'boldC'],
    ['italic-range', 'italicD', 0, 7],
    ['mixed-range', 'plainB', 0, 13],
    ['inline-code', 'codeF'],
    ['link', 'linkG'],
    ['partial-link', 'linkG', 1, 3],
    ['first-item', 'oneH'],
    ['second-item', 'twoI'],
    ['nested', 'nestedJ'],
    ['numbered', 'secondL'],
    ['task', 'taskM'],
    ['quote', 'quoteN'],
    ['fence', 'codeO'],
    ['cell', 'cellP'],
    ['all', null],
  ]
  const list = (editor) =>
    editor.isActive('taskList') ? 'taskItem' : 'listItem'
  // The rich toolbar's commands; a caret link action inserts its address, as FormattingToolbar does.
  const actions = [
    ['bold', (c) => c.toggleBold()],
    ['italic', (c) => c.toggleItalic()],
    ['strike', (c) => c.toggleStrike()],
    ['subscript', (c) => c.toggleMark('subscript')],
    ['inline-code', (c) => c.toggleCode()],
    [
      'link',
      (c, editor) =>
        editor.state.selection.empty && !editor.isActive('link')
          ? c.insertContent({
              type: 'text',
              text: 'https://example.com',
              marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
            })
          : c.extendMarkRange('link').setLink({ href: 'https://example.com' }),
    ],
    ['unlink', (c) => c.unsetLink()],
    ['subtext', (c) => c.setNode('subtext')],
    ['paragraph', (c) => c.setParagraph()],
    ...[1, 2, 3, 4, 5, 6].map((level) => [
      `heading-${level}`,
      (c) => c.toggleHeading({ level }),
    ]),
    ['bullet-list', (c) => c.toggleBulletList()],
    ['numbered-list', (c) => c.toggleOrderedList()],
    ['checklist', (c) => c.toggleTaskList()],
    ['indent', (c, editor) => c.sinkListItem(list(editor))],
    ['outdent', (c, editor) => c.liftListItem(list(editor))],
    ['quote', (c) => c.toggleBlockquote()],
    ['code-block', (c) => c.toggleCodeBlock()],
    ['divider', (c) => c.setHorizontalRule()],
    ['hard-break', (c) => c.setHardBreak()],
    ['table', (c) => c.insertTable({ rows: 3, cols: 2, withHeaderRow: true })],
  ]
  const marks = ['bold', 'italic', 'strike', 'subscript', 'inline-code', 'link']
  // Each difference's cause, by action and selection.
  const causes = [
    [
      'formatted gap action-008: the link action at a caret inserts a link beside formatting, or edits the link around the caret',
      (id, _label, caret) => caret && id === 'link',
    ],
    [
      'formatted gap action-001: a caret mark action formats the text typed next instead of writing empty delimiters',
      (id, label, caret) => caret && marks.includes(id) && label !== 'cell',
    ],
    [
      'formatted gap action-002: a caret mark action in a table cell formats the text typed next',
      (id, _label, caret) => caret && marks.includes(id),
    ],
    [
      'formatted gap action-003: a mark action over a range across other formatting writes the delimiters the rich editor writes',
      (id) => marks.includes(id),
    ],
    [
      'formatted gap action-004: divider and line break actions split the surrounding block and formatting as the rich editor does',
      (id) => id === 'divider' || id === 'hard-break',
    ],
    [
      'formatted gap action-005: the table action inserts the table the rich editor inserts and splits the surrounding block',
      (id) => id === 'table',
    ],
    [
      'formatted gap input-076: the code block action turns the selected blocks into code',
      (id) => id === 'code-block',
    ],
    [
      'formatted gap action-007: list actions renumber, nest and convert items as the rich editor does',
      (id) =>
        [
          'bullet-list',
          'numbered-list',
          'checklist',
          'indent',
          'outdent',
        ].includes(id),
    ],
    [
      'formatted gap action-006: block actions convert each selected block and keep its containers as the rich editor does',
      () => true,
    ],
  ]
  const differences = new Map(causes.map(([todo]) => [todo, []]))
  let compared = 0
  const undone = []
  for (const [label, text, offset = 1, length = 0] of selections)
    for (const [id, command] of actions) {
      const editor = richEditor(note)
      const source = editor.getMarkdown()
      const serialize = markdownSerializer(editor.markdown, true)
      const before = serialize(editor.state.doc).source
      let anchor = 0,
        head = source.length
      if (text === null) editor.commands.selectAll()
      else {
        let from
        editor.state.doc.descendants((node, pos) => {
          if (from === undefined && node.isText && node.text.includes(text))
            from = pos + node.text.indexOf(text) + offset
        })
        editor.commands.setTextSelection({ from, to: from + length })
        anchor = head = source.indexOf(text) + offset
        if (length) {
          // The range's ends in the source, placed by sentinels.
          const first = 'HIBIACTIONSTART871',
            last = 'HIBIACTIONEND871'
          const { from: start, to: end } = editor.state.selection
          const transaction = editor.state.tr
            .insert(
              end,
              editor.schema.text(last, editor.state.doc.resolve(end).marks()),
            )
            .insert(
              start,
              editor.schema.text(
                first,
                editor.state.doc.resolve(start).nodeAfter?.marks ?? [],
              ),
            )
          const marked = editor.markdown.serialize(transaction.doc.toJSON())
          anchor = marked.indexOf(first)
          head = marked.indexOf(last) - first.length
        }
      }
      const cell = label === 'cell'
      const tree = grammar.parse(source)
      const view = {
        state: EditorState.create({
          doc: source,
          selection: { anchor, head },
          extensions: [
            history(),
            formattedTree.of(() => tree),
            tableActions.of({
              active: () => cell,
              run: (target, action) =>
                action === 'hard-break' ? cellLineBreak(target) : false,
            }),
          ],
        }),
        dispatch(spec) {
          view.state = view.state.update(spec).state
        },
        focus() {},
      }
      const formatting = sourceFormatting(view)
      if (formatting.inspect().state(id).disabled) continue
      let allowed = false
      try {
        allowed = command(editor.can().chain(), editor).run()
      } catch {}
      if (!allowed) continue
      command(editor.chain(), editor).run()
      formatting.run(id, { url: 'https://example.com', alt: 'alt' })
      let expected = serialize(editor.state.doc).source
      if (source !== before)
        expected =
          preserveRichSource(source, before, expected, (candidate) =>
            sameRichSourceDocument(
              editor.schema.nodeFromJSON(editor.markdown.parse(candidate)),
              editor.state.doc,
              true,
            ),
          ) ?? (text === null ? expected : source)
      let actual = view.state.doc.toString()
      compared++
      const undoes =
        actual === source
          ? undoDepth(view.state) === 0
          : undoDepth(view.state) === 1 &&
            undo(view) &&
            view.state.doc.toString() === source
      if (!undoes) undone.push(`${label} ${id}`)
      // A cell's edit keeps its column's padding, as typing in a cell does.
      if (cell) {
        const pad = (markdown) =>
          markdown.replace(/^\|.*\|$/gm, (row) =>
            row.replace(/ {2,}/g, ' ').replace(/-{3,}/g, '---'),
          )
        actual = pad(actual)
        expected = pad(expected)
      }
      if (actual === expected) continue
      const [todo] = causes.find(([, applies]) =>
        applies(id, label, anchor === head),
      )
      differences.get(todo).push(`${label} ${id}`)
    }
  t.diagnostic(
    JSON.stringify({
      compared,
      differences: Object.fromEntries(
        [...differences].map(([todo, rows]) => [
          todo.split(':')[0].replace('formatted gap ', ''),
          rows.length,
        ]),
      ),
    }),
  )
  await t.test('every action that changes the note undoes in one step', () => {
    assert.ok(compared > 250, String(compared))
    assert.deepEqual(undone, [])
  })
  for (const [todo] of causes)
    await t.test(todo.slice(todo.indexOf(': ') + 2), { todo }, () => {
      assert.deepEqual(differences.get(todo), [])
    })
})
