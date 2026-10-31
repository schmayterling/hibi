import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { history, undo, undoDepth } from '@codemirror/commands'
import { DocInput } from '@codemirror/language'
import { EditorState, StateEffect, Text } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { Tree } from '@lezer/common'
import { GFM, parser } from '@lezer/markdown'
import {
  subscriptSyntax,
  subtextSyntax,
} from '../src/addons/text-extras/formatted-syntax.ts'
import { cellLineBreak } from '../src/renderer/src/formatted/table-cells.ts'
import {
  formattedLiteral,
  formattedTree,
} from '../src/renderer/src/formatted-contributions.ts'
import {
  openAtEnd,
  openSelection,
  selectedBlock,
} from '../src/renderer/src/formatted-text-end.ts'
import { markdownSyntax } from '../src/renderer/src/markdown-syntax.ts'
import {
  sourceFormatting,
  storedMarkInput,
  tableActions,
} from '../src/renderer/src/source-formatting.ts'
import { createSourceSession } from '../src/renderer/src/source-session.ts'
import { ChunkedMarkdownParser } from '../src/shared/chunked-markdown.ts'
import { DocumentSession } from '../src/shared/document-session.ts'
import { frozenOracle } from './frozen-oracle.mjs'

/**
 * What the removed rich editor, with the GitHub and text extras flavors,
 * wrote, read and reported for this suite's notes, selections and actions.
 */
const rich = frozenOracle('formatted-toolbar-state')
/** A note's name in the keys that would repeat it: its text's short digest. */
const digest = (text) =>
  createHash('sha256').update(text).digest('hex').slice(0, 12)
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
    const source = split ? input : rich({ kind: 'markdown', input })
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
    assert.equal(
      JSON.stringify(rich({ kind: 'json', markdown: actual })),
      JSON.stringify(rich({ kind: 'unlink', input, text, offset, length })),
      actual,
    )
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
      assert.equal(target.state.doc.toString(), result)
      assert.equal(undoDepth(target.state), 1)
      undo(target)
      assert.equal(target.state.doc.toString(), input)
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

/** The formatted view's syntax for the rich editor's markdown. */
const grammar = parser.configure([GFM, subscriptSyntax, subtextSyntax])

/** A seeded generator from the high bits of a 32-bit LCG. */
function random(seed) {
  let state = seed
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return (state >>> 8) / 0x1000000
  }
}

test('formatted toolbar states match the rich toolbar on random selections', () => {
  // The actions FormattingToolbar checked in the rich editor. Its recorded
  // states leave out accepted difference toolbar-001: a list or quote is not
  // active for a range with blocks outside every one of them, though the rich
  // editor counted the positions of nested lists twice and could report it.
  const actions = [
    'bold',
    'italic',
    'strike',
    'inline-code',
    'subscript',
    'subtext',
    'paragraph',
    ...[1, 2, 3, 4, 5, 6].map((level) => `heading-${level}`),
    'bullet-list',
    'numbered-list',
    'checklist',
    'indent',
    'outdent',
    'quote',
    'code-block',
    'hard-break',
    'link',
    'unlink',
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
      // The rich editor's source and the source positions at the start, second
      // character, middle and end of each text it read once in that source.
      const { source, points } = rich({ kind: 'random points', input })
      const tree = grammar.parse(source)
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
        const a = Math.floor(next() * points.length)
        const b = next() < 0.4 ? a : Math.floor(next() * points.length)
        const target = {
          state: EditorState.create({
            doc: source,
            selection: {
              anchor: Math.min(points[a], points[b]),
              head: Math.max(points[a], points[b]),
            },
            extensions: [
              formattedTree.of(() => tree),
              tableActions.of({ active: table, run: () => false }),
            ],
          }),
        }
        const inspection = sourceFormatting(target).inspect()
        const inCell = table(target)
        // The rich toolbar's pressed and disabled actions for the same text selected.
        const recorded = rich({
          kind: 'random states',
          note: digest(input),
          seed,
          round,
          a,
          b,
        })
        for (const id of actions) {
          const expected = {
            pressed: recorded.pressed.includes(id),
            disabled:
              recorded.disabled.includes(id) ||
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
    const source = rich({ kind: 'markdown', input })
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
    // From inside the nested node into the paragraph after the list or quote,
    // which the rich editor reported as in the list or quote.
    const outside = formatted(
      source.indexOf(start) + 1,
      source.indexOf('plainD') + 3,
    )
    const state = sourceFormatting(outside).inspect().state(id)
    assert.equal(state.pressed, false, id)
    if (type === 'blockquote') {
      // The rich editor's toggle tried to lift its double-counted quote and
      // refused; the formatted view quotes the selected blocks, which join
      // the quote around the selection's start.
      assert.equal(state.disabled, false)
      assert.equal(sourceFormatting(outside).run('quote'), true)
      assert.equal(
        outside.state.doc.toString(),
        '> quoteA\n>\n> > quoteB\n> >\n> quoteC\n> \n> plainD',
      )
      assert.equal(undoDepth(outside.state), 1)
    } else
      assert.equal(
        state.disabled,
        !rich({
          kind: 'list toggle',
          input,
          type,
          from: [start, 1],
          to: ['plainD', 3],
        }),
        id,
      )
    // Inside the nested node both editors report it.
    const inside = formatted(
      source.indexOf(start) + 1,
      source.indexOf(nested) + 2,
    )
    assert.equal(sourceFormatting(inside).inspect().state(id).pressed, true, id)
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
  // The actions the rich toolbar checked, recorded without toolbar-001's double counting.
  const actions = [
    'bold',
    'italic',
    'inline-code',
    'link',
    'unlink',
    'paragraph',
    'heading-2',
    'bullet-list',
    'numbered-list',
    'quote',
    'code-block',
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
        // The note as the rich editor read its own saved source back, and the
        // source positions in each text it read once in that source; a literal
        // atom's text edges are also the positions beside it.
        const { source, points } = rich({
          kind: 'feature points',
          feature,
          input,
        })
        // Task lists are the GitHub flavor's in the rich editor, whatever bullet lists do.
        if (feature === 'core.bullet-lists' && /\[[ x]\]/.test(source)) continue
        const tree = grammar.parse(source)
        for (let round = 0; round < 12 && points.length; round++) {
          const a = Math.floor(next() * points.length)
          const b = next() < 0.5 ? a : Math.floor(next() * points.length)
          const inspection = sourceFormatting({
            state: EditorState.create({
              doc: source,
              selection: {
                anchor: Math.min(points[a], points[b]),
                head: Math.max(points[a], points[b]),
              },
              extensions: [
                formattedTree.of(() => tree),
                literal.map((name) => formattedLiteral.of(name)),
              ],
            }),
          }).inspect()
          const recorded = rich({
            kind: 'feature states',
            note: digest(input),
            feature,
            round,
            a,
            b,
          })
          for (const id of actions) {
            const expected = {
              pressed: recorded.pressed.includes(id),
              disabled: recorded.disabled.includes(id),
            }
            const { pressed, disabled } = inspection.state(id)
            comparisons++
            if (pressed !== expected.pressed || disabled !== expected.disabled)
              mismatches.push({
                feature,
                source,
                selection: [points[a], points[b]],
                id,
                expected,
              })
          }
        }
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
  // The rich toolbar's actions; a caret link action inserted its address, as FormattingToolbar did.
  const actions = [
    'bold',
    'italic',
    'strike',
    'subscript',
    'inline-code',
    'link',
    'unlink',
    'subtext',
    'paragraph',
    ...[1, 2, 3, 4, 5, 6].map((level) => `heading-${level}`),
    'bullet-list',
    'numbered-list',
    'checklist',
    'indent',
    'outdent',
    'quote',
    'code-block',
    'divider',
    'hard-break',
    'table',
  ]
  const marks = ['bold', 'italic', 'strike', 'subscript', 'inline-code', 'link']
  // Each difference's cause, by action and selection.
  const causes = [
    [
      'the link action at a caret inserts a link beside formatting, or edits the link around the caret',
      (id, _label, caret) => caret && id === 'link',
    ],
    [
      'a caret mark action formats the text typed next instead of writing empty delimiters',
      (id, label, caret) => caret && marks.includes(id) && label !== 'cell',
    ],
    [
      'a caret mark action in a table cell formats the text typed next',
      (id, _label, caret) => caret && marks.includes(id),
    ],
    [
      'a mark action over a range across other formatting writes the delimiters the rich editor writes',
      (id) => marks.includes(id),
    ],
    [
      'divider and line break actions split the surrounding block and formatting as the rich editor does',
      (id) => id === 'divider' || id === 'hard-break',
    ],
    [
      'the table action inserts the table the rich editor inserts and splits the surrounding block',
      (id) => id === 'table',
    ],
    [
      'the code block action turns the selected blocks into code',
      (id) => id === 'code-block',
    ],
    [
      'list actions renumber, nest and convert items as the rich editor does',
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
      'block actions convert each selected block and keep its containers as the rich editor does',
      () => true,
    ],
  ]
  const differences = new Map(causes.map(([todo]) => [todo, []]))
  let compared = 0
  const undone = []
  const source = rich({ kind: 'markdown', input: note })
  for (const [label, text, offset = 1, length = 0] of selections)
    for (const id of actions) {
      let anchor = 0,
        head = source.length
      if (text !== null) {
        anchor = head = source.indexOf(text) + offset
        // A range's ends in the rich editor's source, which it placed by sentinels.
        if (length)
          ({ anchor, head } = rich({
            kind: 'action range',
            note: digest(note),
            text,
            offset,
            length,
          }))
      }
      const cell = label === 'cell'
      let cellView = null
      const tree = grammar.parse(source)
      const view = {
        state: EditorState.create({
          doc: source,
          selection: { anchor, head },
          extensions: [
            history(),
            storedMarkInput,
            formattedTree.of(() => tree),
            tableActions.of({
              active: () => cell,
              run: (target, action, values) =>
                action === 'hard-break'
                  ? cellLineBreak(target)
                  : (cellView?.formatting.run(action, values) ?? false),
              state: (_target, id) => cellView?.formatting.state(id) ?? null,
            }),
          ],
        }),
        dispatch(spec) {
          view.state = view.state.update(spec).state
        },
        focus() {},
      }
      if (cell) {
        let node = tree.resolveInner(anchor, 1)
        while (node && node.name !== 'TableCell') node = node.parent
        assert.ok(node)
        const start = node.from
        cellView = typing(source.slice(start, node.to), anchor - start)
        const dispatch = cellView.dispatch.bind(cellView)
        cellView.dispatch = (spec) => {
          const transaction = cellView.state.update(spec)
          dispatch(spec)
          if (transaction.docChanged) {
            const changes = []
            transaction.changes.iterChanges((from, to, _a, _b, insert) =>
              changes.push({ from: start + from, to: start + to, insert }),
            )
            view.dispatch({ changes, annotations: transaction.annotations })
          }
        }
      }
      const formatting = sourceFormatting(view)
      if (formatting.inspect().state(id).disabled) continue
      // Whether the rich toolbar's command applied, and the source the rich
      // editor saved after it, keeping the note's own spelling where its
      // parse proved the same document.
      const recorded = rich({
        kind: 'action',
        note: digest(note),
        text,
        offset,
        length,
        id,
      })
      if (!recorded.allowed) continue
      formatting.run(id, { url: 'https://example.com', alt: 'alt' })
      let expected = recorded.expected
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
        [...differences].map(([name, rows]) => [name, rows.length]),
      ),
    }),
  )
  await t.test('every action that changes the note undoes in one step', () => {
    assert.ok(compared > 250, String(compared))
    assert.deepEqual(undone, [])
  })
  for (const [name] of causes)
    await t.test(name, () => {
      assert.deepEqual(differences.get(name), [])
    })
})

function sessionTyping(source, at) {
  const target = typing(source, at)
  const session = new DocumentSession(
    source,
    { tabId: 'formatting', revision: 0 },
    0,
    {
      enqueue() {},
      onError(error) {
        throw error
      },
    },
  )
  const bridge = createSourceSession(session, 'formatted')
  target.update = (transactions) => {
    for (const transaction of transactions) target.state = transaction.state
  }
  const detach = bridge.attach(target)
  target.dispatch = (spec) =>
    bridge.dispatch([target.state.update(spec)], target)
  return {
    target,
    session,
    bridge,
    dispose() {
      detach()
      session.dispose()
    },
  }
}

test('block ranges exclude an untouched leaf at their end', () => {
  for (const [first, last] of [
    ['a', 'b'],
    ['😀 a', '😀 b'],
  ])
    for (const id of ['heading-2', 'numbered-list'])
      for (const reverse of [false, true]) {
        const source = `${first}\n\n${last}`
        const target = typing(source, 0)
        target.dispatch({
          selection: {
            anchor: reverse ? first.length + 2 : 0,
            head: reverse ? 0 : first.length + 2,
          },
        })
        // The rich editor's source after the action on its first paragraph's text.
        const expected = rich({
          kind: 'leaf range',
          source,
          from: 1,
          to: first.length + 1,
          id,
        })
        assert.equal(target.formatting.run(id), true)
        assert.equal(target.state.doc.toString(), expected)
      }
  const caret = typing('a\n\nb', 3)
  caret.formatting.run('heading-2')
  assert.equal(caret.state.doc.toString(), 'a\n\n## b')
})

test('list actions preserve raw first blocks', async (t) => {
  for (const [first, numbered] of [
    [
      '- ```js\n  keep **literal**\n  ```',
      '1. ```js\n   keep **literal**\n   ```',
    ],
    ['-     keep **literal**', '1.     keep **literal**'],
    ['- # keep', '1. # keep'],
  ])
    for (const id of ['indent', 'numbered-list', 'outdent'])
      await t.test(`${id}: ${first.split('\n')[0]}`, () => {
        const source = `${first}\n- target`
        const { target, session, bridge, dispose } = sessionTyping(
          source,
          source.indexOf('target'),
        )
        target.dispatch({
          selection: {
            anchor: source.indexOf('target'),
            head: source.indexOf('target') + 6,
          },
        })
        try {
          assert.equal(target.formatting.run(id), true)
          const actual = target.state.doc.toString()
          const expected =
            id === 'numbered-list'
              ? `${numbered}\n2. target`
              : id === 'indent'
                ? `${first}\n  - target`
                : `${first}\n\ntarget`
          assert.equal(actual, expected)
          assert.equal(
            actual.slice(
              target.state.selection.main.from,
              target.state.selection.main.to,
            ),
            'target',
          )
          assert.equal(session.snapshot().version, 1)
          assert.equal(bridge.undo(), true)
          assert.equal(target.state.doc.toString(), source)
          assert.equal(bridge.redo(), true)
          assert.equal(target.state.doc.toString(), actual)
          assert.equal(
            actual.slice(
              target.state.selection.main.from,
              target.state.selection.main.to,
            ),
            'target',
          )

          const syntax = extras.parse(actual),
            listNode = syntax.topNode.firstChild,
            firstItem = listNode.getChild('ListItem')
          assert.equal(
            listNode.name,
            id === 'numbered-list' ? 'OrderedList' : 'BulletList',
          )
          const block = firstItem.getChild(
            first.includes('```')
              ? 'FencedCode'
              : first.startsWith('-     ')
                ? 'CodeBlock'
                : 'ATXHeading1',
          )
          assert.ok(block)
          if (block.name === 'ATXHeading1')
            assert.equal(actual.slice(block.from, block.to), '# keep')
          else {
            const text = block.getChild('CodeText')
            assert.equal(actual.slice(text.from, text.to), 'keep **literal**')
            if (block.name === 'FencedCode') {
              const language = block.getChild('CodeInfo')
              assert.equal(actual.slice(language.from, language.to), 'js')
            }
          }
          target.dispatch({
            selection: { anchor: target.state.selection.main.head },
          })
          target.dispatch({
            ...target.state.replaceSelection('Q'),
            userEvent: 'input.type',
          })
          assert.equal(target.state.doc.toString(), `${actual}Q`)
          assert.equal(session.snapshot().version, 4)
          assert.equal(bridge.undo(), true)
          assert.equal(target.state.doc.toString(), actual)
          assert.equal(bridge.redo(), true)
          assert.equal(target.state.doc.toString(), `${actual}Q`)
          assert.equal(
            target.state.selection.main.head,
            target.state.doc.length,
          )
        } finally {
          dispose()
        }
      })
  await t.test('indent retains a paragraph and code sibling', () => {
    const source = '- lead\n  ```js\n  keep **literal**\n  ```\n- target'
    const { target, bridge, dispose } = sessionTyping(
      source,
      source.indexOf('target'),
    )
    try {
      target.dispatch({
        selection: { anchor: source.indexOf('target'), head: source.length },
      })
      assert.equal(target.formatting.run('indent'), true)
      const actual = target.state.doc.toString()
      assert.equal(actual, source.replace('\n- target', '\n  - target'))
      assert.equal(bridge.undo(), true)
      assert.equal(target.state.doc.toString(), source)
      assert.equal(bridge.redo(), true)
      assert.equal(target.state.doc.toString(), actual)
    } finally {
      dispose()
    }
  })
})

test('table spelling changes retain range direction, cell endpoints and next input', () => {
  const source = 'plain\n\n| aa | bb |\n| --- | --- |\n| cell | tail |'
  for (const reverse of [false, true]) {
    const to = source.indexOf('cell') + 2
    const { target, session, bridge, dispose } = sessionTyping(source, 0)
    target.dispatch({
      effects: StateEffect.appendConfig.of(
        tableActions.of({ active: () => true, run: () => false }),
      ),
      selection: { anchor: reverse ? to : 0, head: reverse ? 0 : to },
    })
    try {
      assert.equal(target.formatting.run('bold'), true)
      const actual = target.state.doc.toString(),
        cell = actual.indexOf('ce') + 2
      assert.deepEqual(target.state.selection.toJSON(), {
        ranges: [{ anchor: reverse ? cell : 2, head: reverse ? 2 : cell }],
        main: 0,
      })
      assert.equal(bridge.undo(), true)
      assert.equal(target.state.doc.toString(), source)
      assert.equal(bridge.redo(), true)
      assert.equal(target.state.doc.toString(), actual)
      assert.equal(target.state.selection.main.head, reverse ? 2 : cell)
      target.dispatch({
        selection: { anchor: target.state.selection.main.head },
      })
      target.dispatch({
        ...target.state.replaceSelection('Q'),
        userEvent: 'input.type',
      })
      assert.equal(session.snapshot().version, 4)
      assert.equal(
        session.snapshot().materialize(),
        target.state.doc.toString(),
      )
      // The rich editor, given the same bold range and then Q at its head,
      // read the typed source as its own document.
      assert.equal(
        rich({
          kind: 'table spelling',
          source,
          reverse,
          markdown: target.state.doc.toString(),
        }),
        true,
      )
    } finally {
      dispose()
    }
  }
})

test('inline actions preserve untouched marked source, as the production rich codec did', () => {
  for (const prefix of ['__keep__', '_keep_', '``keep``']) {
    const source = `${prefix} and take\n\nuntouched __suffix__`
    const target = typing(source, source.indexOf('take'))
    target.dispatch({
      selection: {
        anchor: source.indexOf('take'),
        head: source.indexOf('take') + 4,
      },
    })
    assert.equal(target.formatting.run('italic'), true)
    assert.equal(
      target.state.doc.toString(),
      `${prefix} and *take*\n\nuntouched __suffix__`,
    )
  }
  const adjacent = typing('plainB **boldC** *italicD* tail', 0)
  adjacent.dispatch({ selection: { anchor: 0, head: 17 } })
  adjacent.formatting.run('italic')
  assert.equal(adjacent.state.doc.toString(), '*plainB **boldC** italicD* tail')
})

test('inner style changes preserve unchanged outer delimiters and source history', () => {
  for (const [source, id, expected] of [
    [
      '__take__ and __keep__\n\nuntouched _suffix_',
      'italic',
      '__*take*__ and __keep__\n\nuntouched _suffix_',
    ],
    [
      '_take_ and _keep_\n\nuntouched ``suffix``',
      'bold',
      '_**take**_ and _keep_\n\nuntouched ``suffix``',
    ],
  ])
    for (const reverse of [false, true]) {
      const start = source.indexOf('take'),
        end = start + 4
      const { target, bridge, session, dispose } = sessionTyping(source, start)
      target.dispatch({
        selection: {
          anchor: reverse ? end : start,
          head: reverse ? start : end,
        },
      })
      try {
        assert.equal(target.formatting.run(id), true)
        assert.equal(target.state.doc.toString(), expected)
        const selection = target.state.selection
        assert.equal(
          expected.slice(selection.main.from, selection.main.to),
          'take',
        )
        assert.equal(selection.main.anchor > selection.main.head, reverse)
        assert.equal(session.snapshot().version, 1)
        assert.equal(bridge.undo(), true)
        assert.equal(target.state.doc.toString(), source)
        assert.equal(bridge.redo(), true)
        assert.equal(target.state.doc.toString(), expected)
        assert.ok(target.state.selection.eq(selection))
        target.dispatch({
          ...target.state.replaceSelection('Q'),
          userEvent: 'input.type',
        })
        const typed = expected.replace('take', 'Q')
        assert.equal(target.state.doc.toString(), typed)
        assert.equal(session.snapshot().version, 4)
        assert.equal(bridge.undo(), true)
        assert.equal(target.state.doc.toString(), expected)
        assert.equal(bridge.redo(), true)
        assert.equal(target.state.doc.toString(), typed)
      } finally {
        dispose()
      }
    }
})

test('touching styles write one canonical span', () => {
  for (const [source, anchor, head, expected] of [
    ['take _keep_', 0, 5, '*take keep*'],
    ['_keep_ take', 6, 11, '*keep take*'],
    ['take *keep*', 0, 5, '*take keep*'],
    ['*keep* take', 6, 11, '*keep take*'],
  ]) {
    const { target, bridge, session, dispose } = sessionTyping(source, anchor)
    try {
      target.dispatch({ selection: { anchor, head } })
      assert.equal(target.formatting.run('italic'), true)
      assert.equal(target.state.doc.toString(), expected)
      const selection = target.state.selection
      assert.equal(session.snapshot().version, 1)
      assert.equal(bridge.undo(), true)
      assert.equal(target.state.doc.toString(), source)
      assert.equal(bridge.redo(), true)
      assert.equal(target.state.doc.toString(), expected)
      assert.ok(target.state.selection.eq(selection))
    } finally {
      dispose()
    }
  }
})

test('retained mark spans write the intended source for a span or the whole note', () => {
  for (const [source, anchor, head, id, expected] of [
    ['__take__ rest', 2, 13, 'italic', '***take** rest*'],
    ['**take** rest', 2, 13, 'italic', '***take** rest*'],
    ['__take__', 0, 8, 'italic', '__*take*__'],
    ['_take_', 0, 6, 'bold', '_**take**_'],
    ['__take__ rest', 0, 13, 'italic', '***take** rest*'],
  ]) {
    const { target, bridge, session, dispose } = sessionTyping(source, anchor)
    target.dispatch({ selection: { anchor, head } })
    try {
      assert.equal(target.formatting.run(id), true)
      assert.equal(target.state.doc.toString(), expected)
      const selection = target.state.selection
      assert.ok(selection.main.anchor < selection.main.head)
      assert.equal(session.snapshot().version, 1)
      assert.equal(bridge.undo(), true)
      assert.equal(target.state.doc.toString(), source)
      assert.equal(bridge.redo(), true)
      assert.equal(target.state.doc.toString(), expected)
      assert.ok(target.state.selection.eq(selection))
    } finally {
      dispose()
    }
  }
})

test('formatted link candidates retain source and history', () => {
  for (const [source, expected] of [
    ['__take__ and __keep__', '[**take**](https://example.com) and __keep__'],
    ['_take_ and _keep_', '[*take*](https://example.com) and _keep_'],
  ]) {
    const start = source.indexOf('take')
    const { target, bridge, session, dispose } = sessionTyping(source, start)
    target.dispatch({ selection: { anchor: start, head: start + 4 } })
    try {
      assert.equal(
        target.formatting.run('link', { url: 'https://example.com', alt: '' }),
        true,
      )
      assert.equal(target.state.doc.toString(), expected)
      const selection = target.state.selection
      assert.equal(session.snapshot().version, 1)
      assert.equal(bridge.undo(), true)
      assert.equal(target.state.doc.toString(), source)
      assert.equal(bridge.redo(), true)
      assert.equal(target.state.doc.toString(), expected)
      assert.ok(target.state.selection.eq(selection))
    } finally {
      dispose()
    }
  }
})

test('replacing a formatted inline range retains its first marks, source and history', () => {
  for (const [source, all] of [
    ['**take** rest', false],
    ['__take__ rest', true],
    ['> **take** rest', false],
    ['- **take** rest', false],
    ['**α😀** rest\r\n\r\nuntouched __tail__', false],
  ])
    for (const reverse of all ? [false] : [false, true]) {
      const word = source.includes('α😀') ? 'α😀' : 'take',
        start = source.indexOf(word),
        end = source.indexOf('rest') + 4
      const { target, bridge, session, dispose } = sessionTyping(source, start)
      target.dispatch({
        selection: {
          anchor: all ? 0 : reverse ? end : start,
          head: reverse ? start : end,
        },
      })
      try {
        assert.equal(target.formatting.run('italic'), true)
        const actionSource = session.snapshot().materialize(),
          actionSelection = target.state.selection
        assert.equal(session.snapshot().version, 1)
        const prefix = source.startsWith('> ')
            ? '> '
            : source.startsWith('- ')
              ? '- '
              : '',
          suffix = source.slice(end)
        for (const text of ['Z', 'Q']) {
          target.type(text)
          const typed =
            prefix + (text === 'Z' ? '***Z***' : '***ZQ***') + suffix
          assert.equal(session.snapshot().materialize(), typed)
          assert.equal(
            target.state.doc.toString(),
            typed.replace(/\r\n/g, '\n'),
          )
          const { head, empty } = target.state.selection.main
          assert.equal(empty, true)
          assert.equal(
            target.state.sliceDoc(head - (text === 'Z' ? 1 : 2), head),
            text === 'Z' ? 'Z' : 'ZQ',
          )
        }
        const typed = session.snapshot().materialize()
        assert.equal(session.snapshot().version, 3)
        assert.equal(bridge.undo(), true)
        assert.equal(session.snapshot().materialize(), actionSource)
        assert.equal(bridge.redo(), true)
        assert.equal(session.snapshot().materialize(), typed)
        assert.equal(bridge.undo(), true)
        assert.equal(bridge.undo(), true)
        assert.equal(session.snapshot().materialize(), source)
        assert.equal(bridge.redo(), true)
        assert.equal(session.snapshot().materialize(), actionSource)
        assert.ok(target.state.selection.eq(actionSelection))
      } finally {
        dispose()
      }
    }
})

test('table range typing keeps its metadata and one source-history group through padding changes', () => {
  const input = '| a | b |\n| --- | --- |\n| **long** rest | tail |'
  const source = rich({ kind: 'markdown', input }),
    from = source.indexOf('long'),
    to = source.indexOf('rest') + 4
  const { target, bridge, session, dispose } = sessionTyping(source, from)
  target.dispatch({ selection: { anchor: from, head: to } })
  const originalSelection = target.state.selection,
    events = [],
    update = target.update
  target.update = (transactions) => {
    for (const transaction of transactions)
      if (transaction.docChanged)
        events.push(transaction.isUserEvent('input.type'))
    update(transactions)
  }
  try {
    target.type('Z')
    const first = session.snapshot().materialize()
    const header = (markdown) =>
      markdown.split('\n').find((line) => line.startsWith('|'))
    assert.ok(header(source))
    assert.notEqual(header(first), header(source))
    // The rich editor's source after Z replaced the same range.
    assert.equal(
      first,
      rich({
        kind: 'range typing',
        input,
        from: ['long', 0],
        to: ['rest', 4],
        text: 'Z',
      }),
    )
    assert.deepEqual(events, [true])
    target.type('Q')
    const typed = first.replace('**Z**', '**ZQ**'),
      caret = target.state.selection
    assert.equal(session.snapshot().materialize(), typed)
    assert.equal(session.snapshot().version, 2)
    assert.deepEqual(events, [true, true])
    assert.equal(bridge.undo(), true)
    assert.equal(session.snapshot().materialize(), source)
    assert.ok(target.state.selection.eq(originalSelection))
    assert.equal(bridge.redo(), true)
    assert.equal(session.snapshot().materialize(), typed)
    assert.ok(target.state.selection.eq(caret))
  } finally {
    dispose()
  }
})

test('inline range input leaves composition, structural input and plain text on their existing paths', () => {
  for (const kind of [
    'readonly',
    'composing',
    'starting composition',
    'multiline',
    'blocks',
  ]) {
    const target = typing(
      kind === 'blocks' ? '**one**\n\n**two**' : '**one** rest',
      2,
    )
    target.dispatch({ selection: { anchor: 2, head: target.state.doc.length } })
    if (kind === 'readonly')
      target.dispatch({
        effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)),
      })
    target.composing = kind === 'composing'
    target.compositionStarted = kind === 'starting composition'
    const before = target.state,
      { from, to } = before.selection.main
    assert.equal(
      before
        .facet(EditorView.inputHandler)
        .some((handler) =>
          handler(
            target,
            from,
            to,
            kind === 'multiline' ? 'Z\nQ' : 'Z',
            () => null,
          ),
        ),
      false,
      kind,
    )
    assert.equal(target.state, before, kind)
  }
  const work = (words) => {
    const target = view(
      'plain ' + 'rest '.repeat(words) + '**bold**',
      'plain',
      5,
    )
    target.state = target.state.update({
      effects: StateEffect.appendConfig.of(storedMarkInput),
    }).state
    return counted(() =>
      assert.equal(
        target.state
          .facet(EditorView.inputHandler)
          .some((handler) => handler(target, 0, 5, 'Z', () => null)),
        false,
      ),
    )
  }
  assert.deepEqual(work(200), work(2))
})

test('ranges ending in a table format every selected block when no cell editor owns them', () => {
  const input = 'plain\n\n| aa | bb |\n| --- | --- |\n| cell | tail |'
  for (const [first, offset, last, end] of [
    ['plain', 0, 'cell', 2],
    ['aa', 1, 'tail', 2],
  ]) {
    const source = rich({ kind: 'markdown', input })
    const target = view(source, first, 0)
    target.dispatch = target.dispatch.bind(target)
    target.state = target.state.update({
      selection: {
        anchor: source.indexOf(first) + offset,
        head: source.indexOf(last) + end,
      },
      effects: StateEffect.appendConfig.of([
        history(),
        tableActions.of({ active: () => true, run: () => false }),
      ]),
    }).state
    assert.equal(sourceFormatting(target).run('bold'), true)
    // The rich editor's source after bold over the same text.
    assert.equal(
      target.state.doc.toString(),
      rich({
        kind: 'table bold',
        input,
        from: [first, offset],
        to: [last, end],
      }),
    )
    assert.equal(undo(target), true)
    assert.equal(target.state.doc.toString(), source)
  }
})

test('inline actions keep existing link destinations and reference syntax', () => {
  for (const source of [
    'plain [label](https://example.com "title") end',
    'plain [label][ref] end\n\n[ref]: https://example.com "title"',
    'plain [label](https://example.com/a\\(b\\)) end',
  ]) {
    const target = view(source, 'plain', 5)
    assert.equal(sourceFormatting(target).run('bold'), true)
    assert.equal(target.state.doc.toString(), `**plain**${source.slice(5)}`)
    const label = view(source, 'label', 5)
    assert.equal(sourceFormatting(label).run('bold'), true)
    assert.equal(
      label.state.doc.toString(),
      source.replace('[label]', '[**label**]'),
    )
  }
})

const extras = parser.configure([GFM, subscriptSyntax])

/** A formatted view of `doc`, with stored marks, that types like CodeMirror's input. */
function typing(doc, anchor) {
  const target = {
    composing: false,
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [
        formattedTree.of((state) => extras.parse(state.doc.toString())),
        storedMarkInput,
      ],
    }),
    dispatch(spec) {
      this.state = this.state.update(spec).state
    },
    focus() {},
    type(text) {
      for (const character of text) {
        const { from, to } = this.state.selection.main
        const insert = () =>
          this.state.update(this.state.replaceSelection(character))
        if (
          !this.state
            .facet(EditorView.inputHandler)
            .some((handler) => handler(this, from, to, character, insert))
        )
          this.dispatch({
            ...this.state.replaceSelection(character),
            userEvent: 'input.type',
          })
      }
      return this.state.doc.toString()
    },
  }
  target.formatting = sourceFormatting(target)
  target.pressed = (id) => target.formatting.inspect().state(id).pressed
  return target
}

test('a formatted caret action stores its mark for the text typed next', () => {
  const view = typing('plain end', 9)
  assert.equal(view.formatting.run('bold'), true)
  assert.equal(view.state.doc.toString(), 'plain end')
  assert.equal(view.pressed('bold'), true)
  assert.equal(view.type(' typed'), 'plain end **typed**')
  assert.equal(view.pressed('bold'), true)
  assert.equal(view.type(' more'), 'plain end **typed more**')

  const off = typing('a **bold** b', 6)
  off.formatting.run('bold')
  assert.equal(off.pressed('bold'), false)
  assert.equal(off.type('X'), 'a **bo**X**ld** b')
  assert.equal(off.pressed('bold'), false)
  const end = typing('a **bold** b', 8)
  end.formatting.run('bold')
  assert.equal(end.type('X'), 'a **bold**X b')

  // After bold text the caret is in bold, as in the rich editor, so the action turns it off.
  const after = typing('a **bold** b', 10)
  assert.equal(after.pressed('bold'), true)
  after.formatting.run('bold')
  assert.equal(after.pressed('bold'), false)
  assert.equal(after.type('er'), 'a **bold**er b')
  // Typing next to the same formatting joins it: subscript ends at its text.
  const joined = typing('a ~sub~ b', 7)
  assert.equal(joined.pressed('subscript'), false)
  joined.formatting.run('subscript')
  assert.equal(joined.type('X'), 'a ~subX~ b')
  assert.equal(joined.pressed('subscript'), false)
  assert.equal(joined.type('Q'), 'a ~subX~Q b')
  // Two marks open together, and a gap line between blocks becomes a paragraph.
  const gap = typing('a\n\nb', 2)
  gap.formatting.run('bold')
  gap.formatting.run('italic')
  assert.equal(gap.pressed('italic'), true)
  assert.equal(gap.type('x'), 'a\n\n***x***\n\nb')
  assert.equal(gap.type('y'), 'a\n\n***xy***\n\nb')
  // Code takes no other marks, and code blocks take none.
  assert.equal(typing('```\nx\n```', 5).formatting.run('bold'), false)
  const code = typing('a ', 2)
  code.formatting.run('inline-code')
  assert.equal(code.pressed('bold'), false)
  assert.equal(code.formatting.inspect().state('bold').disabled, true)
  assert.equal(code.type('x'), 'a `x`')
})

test('formatting a table caret or a neighboring block reads no other table rows', () => {
  const work = (rows, cell) => {
    const doc = `plain **bold**\n\n| head |\n| --- |\n${'| cell |\n'.repeat(rows)}`
    const target = view(doc, cell ? 'c' : 'plain', cell ? undefined : 5)
    const nested = typing('cell', 1)
    target.state = target.state.update({
      effects: StateEffect.appendConfig.of(
        tableActions.of({
          active: () => cell,
          run: (_view, id, values) => nested.formatting.run(id, values),
          state: (_view, id) => nested.formatting.state(id),
        }),
      ),
    }).state
    const formatting = sourceFormatting(target)
    const reads = counted(() => {
      formatting.run('italic')
      if (cell) nested.type('X')
    })
    assert.equal(
      cell ? nested.state.doc.toString() : target.state.sliceDoc(0, 7),
      cell ? 'c*X*ell' : '*plain*',
    )
    return reads
  }
  for (const cell of [false, true])
    assert.deepEqual(work(200, cell), work(2, cell))
})

function selectedAtom(source) {
  const tree = (state) => markdown.parse(state.doc.toString())
  const target = {
    state: EditorState.create({
      doc: source,
      extensions: [
        formattedTree.of(tree),
        openSelection({ tree, replaced: () => true }),
      ],
    }),
    dom: { isConnected: true },
    dispatch(spec) {
      this.state = this.state.update(spec).state
    },
    focus() {},
  }
  openAtEnd(target)
  return target
}

test('a selected atom exposes its list actions and keeps its block through conversion', () => {
  for (const [action, expected] of [
    ['checklist', '- [ ] item\n\n  ---\n'],
    ['numbered-list', '1. item\n\n   ---\n'],
  ]) {
    const target = selectedAtom('- item\n\n  ---\n')
    assert.deepEqual(
      states(target, ['bullet-list', 'numbered-list', 'checklist', 'outdent']),
      {
        'bullet-list': 'pressed ',
        'numbered-list': '',
        checklist: '',
        outdent: '',
      },
    )
    assert.ok(sourceFormatting(target).run(action))
    assert.equal(target.state.doc.toString(), expected)
    const { from, to } = target.state.selection.main
    assert.equal(target.state.sliceDoc(from, to), '---')
  }
})

test('list conversion keeps a selected preview separate when an image replaces it', () => {
  const target = selectedAtom('- item\n\n  ```mermaid\n  graph TD\n  ```\n')
  assert.ok(sourceFormatting(target).run('numbered-list'))
  assert.equal(
    target.state.doc.toString(),
    '1. item\n\n   ```mermaid\n   graph TD\n   ```\n',
  )
  assert.ok(
    sourceFormatting(target).capture().insertMarkdown('![new](new.png)'),
  )
  assert.equal(target.state.doc.toString(), '1. item\n\n   ![new](new.png)\n')
  const block = selectedBlock(target.state)
  assert.ok(block)
  assert.equal(target.state.sliceDoc(block.from, block.to), '![new](new.png)')
})

test('a captured image replacement keeps a selected atom selected', () => {
  for (const source of [
    'plain\n\n---\n',
    '- item\n\n  ---\n',
    '> quoted\n>\n> ---\n',
  ]) {
    const target = selectedAtom(source)
    const before = target.state.selection.main
    const image = '![new](new.png)'
    assert.equal(source.slice(before.from, before.to), '---')
    assert.ok(sourceFormatting(target).capture().insertMarkdown(image))
    const range = target.state.selection.main
    assert.equal(target.state.sliceDoc(range.from, range.to), image)
    assert.equal(sourceFormatting(target).state('bold').disabled, true)
  }
})

test('image history restores the selected block and its toolbar state', (t) => {
  const source = '> quoted\n>\n> ---\n'
  const target = selectedAtom(source)
  const session = new DocumentSession(
    source,
    { tabId: 'atom', revision: 0 },
    0,
    {
      enqueue() {},
      onError(error) {
        throw error
      },
    },
  )
  const bridge = createSourceSession(session, 'formatted')
  target.update = (transactions) => {
    for (const transaction of transactions) target.state = transaction.state
  }
  target.dispatch = (spec) =>
    bridge.dispatch([target.state.update(spec)], target)
  const detach = bridge.attach(target)
  t.after(() => {
    detach()
    session.dispose()
  })
  openAtEnd(target)
  const formatting = sourceFormatting(target)
  assert.ok(formatting.capture().insertMarkdown('![new](new.png)'))
  const after = target.state.doc.toString()
  for (const redo of [false, true]) {
    assert.ok(redo ? session.redo() : session.undo())
    assert.equal(target.state.doc.toString(), redo ? after : source)
    const block = selectedBlock(target.state)
    assert.ok(block)
    assert.equal(
      target.state.sliceDoc(block.from, block.to),
      redo ? '![new](new.png)' : '---',
    )
    assert.equal(formatting.state('bold').disabled, true)
  }
})

test('stored marks drop when the caret moves or the text has lines', () => {
  const moved = typing('plain end', 9)
  moved.formatting.run('bold')
  moved.dispatch({ selection: { anchor: 3 } })
  moved.dispatch({ selection: { anchor: 9 } })
  assert.equal(moved.pressed('bold'), false)
  assert.equal(moved.type('x'), 'plain endx')
  // Like the rich editor, multi-line input does not take the caret's stored marks.
  const lines = typing('', 0)
  lines.formatting.run('bold')
  const { from, to } = lines.state.selection.main
  assert.equal(
    lines.state
      .facet(EditorView.inputHandler)
      .some((handler) => handler(lines, from, to, 'alpha\nbeta', () => null)),
    false,
  )
})
