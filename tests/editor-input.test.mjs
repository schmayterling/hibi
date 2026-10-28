import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { decodeHTML } from 'entities'
import { marked } from 'marked'
import {
  launchBenchmarkApp,
  switchToSource,
  waitForEditor,
} from '../scripts/benchmark-flows.mjs'
import {
  electron,
  showTestWindows,
  waitForDocumentEditor,
} from './electron.mjs'
import {
  testFormattedEngines as it,
  selectFormattedEngine,
} from './formatted-engine.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { APP_STATE_TIMEOUT, waitForAsync } from './poll.mjs'

const inputFixtureCapture = process.env.HIBI_CAPTURE_TIPTAP_INPUT === '1'

// Frozen user outcomes: CM never launches the old engine to derive an expectation.
// Reviewed 51/51 records: .engine-focus-scale-port-input-fixtures-capture-r2.log.
const frozenToolbarSource =
  '# Title\n\nplain **bold** *italic* ~~strike~~ `code` [link](https://example.com) end\n\n- one\n- two\n  - nested\n\n1. first\n2. second\n\n- [ ] task\n- [x] done\n\n> quote\n\n```js\nconst x = 1\n```\n\n\n| a    | b   |\n| ---- | --- |\n| cell | 2   |\n\n\n'
const frozenToolbarState = {
  undo: {
    pressed: null,
    disabled: true,
  },
  redo: {
    pressed: null,
    disabled: true,
  },
  bold: {
    pressed: 'false',
    disabled: false,
  },
  italic: {
    pressed: 'false',
    disabled: false,
  },
  strike: {
    pressed: 'false',
    disabled: false,
  },
  'inline-code': {
    pressed: 'false',
    disabled: false,
  },
  subscript: {
    pressed: 'false',
    disabled: false,
  },
  subtext: {
    pressed: 'false',
    disabled: false,
  },
  paragraph: {
    pressed: 'true',
    disabled: true,
  },
  'heading-1': {
    pressed: 'false',
    disabled: false,
  },
  'heading-2': {
    pressed: 'false',
    disabled: false,
  },
  'heading-3': {
    pressed: 'false',
    disabled: false,
  },
  'heading-4': {
    pressed: 'false',
    disabled: false,
  },
  'heading-5': {
    pressed: 'false',
    disabled: false,
  },
  'heading-6': {
    pressed: 'false',
    disabled: false,
  },
  'bullet-list': {
    pressed: 'false',
    disabled: false,
  },
  'numbered-list': {
    pressed: 'false',
    disabled: false,
  },
  checklist: {
    pressed: 'false',
    disabled: false,
  },
  indent: {
    pressed: null,
    disabled: true,
  },
  outdent: {
    pressed: null,
    disabled: true,
  },
  quote: {
    pressed: 'false',
    disabled: false,
  },
  'code-block': {
    pressed: 'false',
    disabled: false,
  },
  divider: {
    pressed: null,
    disabled: false,
  },
  'hard-break': {
    pressed: null,
    disabled: false,
  },
  link: {
    pressed: 'false',
    disabled: false,
  },
  unlink: {
    pressed: null,
    disabled: false,
  },
  image: {
    pressed: null,
    disabled: false,
  },
  table: {
    pressed: null,
    disabled: false,
  },
}

const frozenInputFixtures = {
  multiline: {
    markdown: {
      source: '',
      from: 0,
      to: 0,
      result: {
        markdown:
          'words \\*\\*bold\\*\\* \\_em\\_ \\`code\\` \\[l\\](https://e.test) &lt;b&gt;h&lt;/b&gt;\n\n\\# no\n\n\\- item\n\n&gt; quote\n\n1\\. one\n\n\n\nend',
        caret: ['end', ''],
      },
    },
    paragraph: {
      source: 'startEND',
      from: 5,
      to: 5,
      result: {
        markdown: 'starta\n\n\n\nb\n\ncEND',
        caret: ['c', 'END'],
      },
    },
    'heading middle': {
      source: '## start',
      from: 5,
      to: 5,
      result: {
        markdown: '## st1\n\n\n\n## 2art',
        caret: ['2', 'art'],
      },
    },
    'heading end': {
      source: '## start\n\nz',
      from: 8,
      to: 8,
      result: {
        markdown: '## starta\n\nb\n\n\n\nz',
        caret: ['', ''],
      },
    },
    list: {
      source: '- startEND',
      from: 7,
      to: 7,
      result: {
        markdown: '- starta\n- \n- bEND',
        caret: ['b', 'END'],
      },
    },
    'list end': {
      source: '1. one\n2. two',
      from: 6,
      to: 6,
      result: {
        markdown: '1. onea\n\nb\n\n\n\nc\n\n1. two',
        caret: ['c', ''],
      },
    },
    'item paragraphs': {
      source: '- first\n\n  second',
      from: 4,
      to: 4,
      result: {
        markdown: '- fia\n\n  second\n- brst',
        caret: ['b', 'rst'],
      },
    },
    'ordered end': {
      source: '7. ab\n8. tail',
      from: 5,
      to: 5,
      result: {
        markdown: '7. aba\n\nb\n\n7. tail',
        caret: ['b', ''],
      },
    },
    'nested list': {
      source: '- x\n  - y',
      from: 9,
      to: 9,
      result: {
        markdown: '- x\n  - ya\n  - b',
        caret: ['b', ''],
      },
    },
    quote: {
      source: '> start',
      from: 7,
      to: 7,
      result: {
        markdown: '> starta\n>\n>\n>\n> b',
        caret: ['b', ''],
      },
    },
    code: {
      source: '```\nse\n```',
      from: 5,
      to: 5,
      result: {
        markdown: '```\ns**l**\n\t b\nc\ne\n```',
        caret: ['s**l**\n\t b\nc\n', 'e'],
      },
    },
    cell: {
      source: '\n|     |     |\n| --- | --- |\n| a   | b   |\n| c   | d   |\n',
      from: 32,
      to: 32,
      result: {
        markdown:
          '\n|                 |     |\n| --------------- | --- |\n| aone<br><br>two | b   |\n| c               | d   |\n',
        caret: ['two', ''],
      },
    },
    selection: {
      source: 'before MIDDLE after',
      from: 7,
      to: 13,
      result: {
        markdown: 'before one\n\ntwo after',
        caret: ['two', ' after'],
      },
    },
    bold: {
      source: '**ab**',
      from: 3,
      to: 3,
      result: {
        markdown: '**aX**\n\n**Yb**',
        caret: ['Y', 'b'],
      },
    },
    'link end': {
      source: 'x[ab](https://e.test)z',
      from: 4,
      to: 4,
      result: {
        markdown: 'x[ab](https://e.test)X\n\nYz',
        caret: ['Y', 'z'],
      },
    },
    'code end': {
      source: 'x`ab`',
      from: 4,
      to: 4,
      result: {
        markdown: 'x`abX`\n\nY',
        caret: ['Y', ''],
      },
    },
    'stored mark': {
      source: '',
      from: 0,
      to: 0,
      result: {
        markdown: 'alpha\n\nbeta',
        caret: ['beta', ''],
      },
    },
    cells: {
      source: '\n|     |     |\n| --- | --- |\n| a   | b   |\n| c   | d   |\n',
      from: 31,
      to: 52,
      result: {
        markdown:
          '\n|     |            |\n| --- | ---------- |\n| a   | b          |\n| c   | one<br>two |\n',
        caret: ['tw', 'o'],
      },
    },
    blocks: {
      source: 'abc\n\ndef',
      from: 2,
      to: 6,
      result: {
        markdown: 'abX\n\nYef',
        caret: ['Y', 'ef'],
      },
    },
    'blocks into a list': {
      source: 'ab\n\n- cd\n\n  more\n- x',
      from: 1,
      to: 7,
      result: {
        markdown: 'aX\n\n\n\nY\n\nd\n\n- more\n- x',
        caret: ['', 'd'],
      },
    },
    items: {
      source: '- ab\n- cd\n- x',
      from: 3,
      to: 8,
      result: {
        markdown: '- aX\n- \n- Y\n- d\n- x',
        caret: ['', 'd'],
      },
    },
    all: {
      source: '# Title\n\nreplace me',
      from: 0,
      to: 19,
      result: {
        markdown: '# X\n\n\n\nY\n\n',
        caret: ['', ''],
      },
    },
    'all from a list': {
      source: '7. a\n\nb',
      from: 0,
      to: 7,
      result: {
        markdown: '7. X\n\nY\n\n',
        caret: ['', ''],
      },
    },
    'line breaks only': {
      source: '7. ab\n8. tail',
      from: 5,
      to: 5,
      result: {
        markdown: '7. ab\n8. \n9. tail',
        caret: ['', ''],
      },
    },
    'block kinds': {
      source: 'ab\n\n## cd',
      from: 1,
      to: 8,
      result: {
        markdown: 'aX\n\n**Yd**',
        caret: ['', 'Yd'],
      },
    },
    'into a table': {
      source: 'ab\n\n\n|     |\n| --- |\n| cd  |\n',
      from: 1,
      to: 24,
      result: {
        markdown: 'aX\n\nY\n\n\n|     |\n| --- |\n| d   |\n',
        caret: ['', 'Y'],
      },
    },
    task: {
      source: '- [x] ',
      from: 6,
      to: 6,
      result: {
        markdown: '- [x] \n- [ ] b',
        caret: ['', 'b'],
      },
    },
    'nested list end': {
      source: '- x\n  - y',
      from: 9,
      to: 9,
      result: {
        markdown: '- x\n- ya\n- b',
        caret: ['b', ''],
      },
    },
    'item start': {
      source: '- x\n  - y',
      from: 2,
      to: 2,
      result: {
        markdown: '- \n- bx\n  - y',
        caret: ['b', 'x'],
      },
    },
    'single line': {
      source: 'a',
      from: 1,
      to: 1,
      result: {
        markdown: 'aone line',
        caret: ['aone line', ''],
      },
    },
  },
  special: {
    'empty-list-exit': {
      source: '- \n\nz',
      from: 2,
      to: 2,
      result: {
        markdown: 'b\n\nz',
        caret: ['b', ''],
      },
    },
  },
  linear: {
    'empty:500': {
      source: '',
      from: 0,
      to: 0,
      result: {
        lineCount: 500,
        firstHeading: false,
      },
    },
    'empty:1000': {
      source: '',
      from: 0,
      to: 0,
      result: {
        lineCount: 1000,
        firstHeading: false,
      },
    },
    'all:500': {
      source: '# Title\n\nreplace me',
      from: 0,
      to: 19,
      result: {
        lineCount: 500,
        firstHeading: true,
      },
    },
    'all:1000': {
      source: '# Title\n\nreplace me',
      from: 0,
      to: 19,
      result: {
        lineCount: 1000,
        firstHeading: true,
      },
    },
  },
  toolbar: {
    heading: {
      source: frozenToolbarSource,
      from: 3,
      to: 3,
      expected: {
        ...frozenToolbarState,
        paragraph: { pressed: 'false', disabled: false },
        'heading-1': { pressed: 'true', disabled: false },
        'bullet-list': { pressed: 'false', disabled: true },
        'numbered-list': { pressed: 'false', disabled: true },
        checklist: { pressed: 'false', disabled: true },
      },
    },
    'plain text': {
      source: frozenToolbarSource,
      from: 10,
      to: 10,
      expected: { ...frozenToolbarState },
    },
    'bold text': {
      source: frozenToolbarSource,
      from: 18,
      to: 18,
      expected: {
        ...frozenToolbarState,
        bold: { pressed: 'true', disabled: false },
      },
    },
    'italic selection': {
      source: frozenToolbarSource,
      from: 25,
      to: 31,
      expected: {
        ...frozenToolbarState,
        italic: { pressed: 'true', disabled: false },
      },
    },
    'mixed selection': {
      source: frozenToolbarSource,
      from: 9,
      to: 28,
      expected: { ...frozenToolbarState },
    },
    'inline code': {
      source: frozenToolbarSource,
      from: 46,
      to: 46,
      expected: {
        ...frozenToolbarState,
        bold: { pressed: 'false', disabled: true },
        italic: { pressed: 'false', disabled: true },
        strike: { pressed: 'false', disabled: true },
        'inline-code': { pressed: 'true', disabled: false },
        subscript: { pressed: 'false', disabled: true },
        link: { pressed: 'false', disabled: true },
      },
    },
    link: {
      source: frozenToolbarSource,
      from: 53,
      to: 53,
      expected: {
        ...frozenToolbarState,
        link: { pressed: 'true', disabled: false },
      },
    },
    'first list item': {
      source: frozenToolbarSource,
      from: 87,
      to: 87,
      expected: {
        ...frozenToolbarState,
        subtext: { pressed: 'false', disabled: true },
        'heading-1': { pressed: 'false', disabled: true },
        'heading-2': { pressed: 'false', disabled: true },
        'heading-3': { pressed: 'false', disabled: true },
        'heading-4': { pressed: 'false', disabled: true },
        'heading-5': { pressed: 'false', disabled: true },
        'heading-6': { pressed: 'false', disabled: true },
        'bullet-list': { pressed: 'true', disabled: false },
        outdent: { pressed: null, disabled: false },
        quote: { pressed: 'false', disabled: true },
        'code-block': { pressed: 'false', disabled: true },
      },
    },
    'second list item': {
      source: frozenToolbarSource,
      from: 93,
      to: 93,
      expected: {
        ...frozenToolbarState,
        subtext: { pressed: 'false', disabled: true },
        'heading-1': { pressed: 'false', disabled: true },
        'heading-2': { pressed: 'false', disabled: true },
        'heading-3': { pressed: 'false', disabled: true },
        'heading-4': { pressed: 'false', disabled: true },
        'heading-5': { pressed: 'false', disabled: true },
        'heading-6': { pressed: 'false', disabled: true },
        'bullet-list': { pressed: 'true', disabled: false },
        indent: { pressed: null, disabled: false },
        outdent: { pressed: null, disabled: false },
        quote: { pressed: 'false', disabled: true },
        'code-block': { pressed: 'false', disabled: true },
      },
    },
    'nested list item': {
      source: frozenToolbarSource,
      from: 101,
      to: 101,
      expected: {
        ...frozenToolbarState,
        subtext: { pressed: 'false', disabled: true },
        'heading-1': { pressed: 'false', disabled: true },
        'heading-2': { pressed: 'false', disabled: true },
        'heading-3': { pressed: 'false', disabled: true },
        'heading-4': { pressed: 'false', disabled: true },
        'heading-5': { pressed: 'false', disabled: true },
        'heading-6': { pressed: 'false', disabled: true },
        'bullet-list': { pressed: 'true', disabled: false },
        outdent: { pressed: null, disabled: false },
        quote: { pressed: 'false', disabled: true },
        'code-block': { pressed: 'false', disabled: true },
      },
    },
    'numbered list': {
      source: frozenToolbarSource,
      from: 121,
      to: 121,
      expected: {
        ...frozenToolbarState,
        subtext: { pressed: 'false', disabled: true },
        'heading-1': { pressed: 'false', disabled: true },
        'heading-2': { pressed: 'false', disabled: true },
        'heading-3': { pressed: 'false', disabled: true },
        'heading-4': { pressed: 'false', disabled: true },
        'heading-5': { pressed: 'false', disabled: true },
        'heading-6': { pressed: 'false', disabled: true },
        'numbered-list': { pressed: 'true', disabled: false },
        indent: { pressed: null, disabled: false },
        outdent: { pressed: null, disabled: false },
        quote: { pressed: 'false', disabled: true },
        'code-block': { pressed: 'false', disabled: true },
      },
    },
    checklist: {
      source: frozenToolbarSource,
      from: 135,
      to: 135,
      expected: {
        ...frozenToolbarState,
        subtext: { pressed: 'false', disabled: true },
        'heading-1': { pressed: 'false', disabled: true },
        'heading-2': { pressed: 'false', disabled: true },
        'heading-3': { pressed: 'false', disabled: true },
        'heading-4': { pressed: 'false', disabled: true },
        'heading-5': { pressed: 'false', disabled: true },
        'heading-6': { pressed: 'false', disabled: true },
        checklist: { pressed: 'true', disabled: false },
        outdent: { pressed: null, disabled: false },
        quote: { pressed: 'false', disabled: true },
        'code-block': { pressed: 'false', disabled: true },
      },
    },
    quote: {
      source: frozenToolbarSource,
      from: 154,
      to: 154,
      expected: {
        ...frozenToolbarState,
        quote: { pressed: 'true', disabled: false },
      },
    },
    'code block': {
      source: frozenToolbarSource,
      from: 167,
      to: 167,
      expected: {
        ...frozenToolbarState,
        bold: { pressed: 'false', disabled: true },
        italic: { pressed: 'false', disabled: true },
        strike: { pressed: 'false', disabled: true },
        'inline-code': { pressed: 'false', disabled: true },
        subscript: { pressed: 'false', disabled: true },
        paragraph: { pressed: 'false', disabled: false },
        'bullet-list': { pressed: 'false', disabled: true },
        'numbered-list': { pressed: 'false', disabled: true },
        checklist: { pressed: 'false', disabled: true },
        'code-block': { pressed: 'true', disabled: false },
        link: { pressed: 'false', disabled: true },
      },
    },
    'table cell': {
      source: frozenToolbarSource,
      from: 217,
      to: 217,
      expected: {
        ...frozenToolbarState,
        'row-before': { pressed: null, disabled: false },
        'row-after': { pressed: null, disabled: false },
        'row-delete': { pressed: null, disabled: false },
        'column-before': { pressed: null, disabled: false },
        'column-after': { pressed: null, disabled: false },
        'column-delete': { pressed: null, disabled: false },
        'table-delete': { pressed: null, disabled: false },
      },
    },
    'whole document': {
      source: frozenToolbarSource,
      from: 0,
      to: 231,
      expected: {
        ...frozenToolbarState,
        paragraph: { pressed: 'false', disabled: false },
        'bullet-list': { pressed: 'false', disabled: true },
        'numbered-list': { pressed: 'false', disabled: true },
        checklist: { pressed: 'false', disabled: true },
      },
    },
  },
}

function inputFixture(kind, name) {
  const fixture = frozenInputFixtures[kind][name]
  assert.ok(fixture, 'port pending: frozen ' + kind + ' fixture ' + name)
  return fixture
}

function emitInputFixture(t, kind, name, value) {
  if (inputFixtureCapture)
    t.diagnostic(
      'tiptap-input-freeze ' +
        JSON.stringify({ schema: 1, kind, name, ...value }),
    )
}

const table =
  '<table><tbody><tr><td><p>a|</p></td><td><p>b</p></td></tr><tr><td><p>c</p></td><td><p>d</p></td></tr></tbody></table>'
// [case, document, input, selection], then whether the editor handles it.
const multilineInputCases = [
  [
    'markdown',
    '<p>|</p>',
    'words **bold** _em_ `code` [l](https://e.test) <b>h</b>\n# no\n- item\n> quote\n1. one\n\nend',
  ],
  ['paragraph', '<p>start|END</p>', 'a\r\n\nb\rc'],
  ['heading middle', '<h2>st|art</h2>', '1\n\n2'],
  ['heading end', '<h2>start|</h2><p>z</p>', 'a\nb\n'],
  ['list', '<ul><li><p>start|END</p></li></ul>', 'a\n\nb'],
  [
    'list end',
    '<ol><li><p>one|</p></li><li><p>two</p></li></ol>',
    'a\n\nb\n\nc',
  ],
  ['item paragraphs', '<ul><li><p>fi|rst</p><p>second</p></li></ul>', 'a\nb'],
  [
    'ordered end',
    '<ol start="7"><li><p>ab|</p></li><li><p>tail</p></li></ol>',
    'a\n\nb',
  ],
  [
    'nested list',
    '<ul><li><p>x</p><ul><li><p>y|</p></li></ul></li></ul>',
    'a\nb',
  ],
  ['quote', '<blockquote><p>start|</p></blockquote>', 'a\n\nb'],
  ['code', '<pre><code>s|e</code></pre>', '**l**\r\n\t b\rc\n'],
  ['cell', table, 'one\n\ntwo'],
  ['selection', '<p>before [MIDDLE] after</p>', 'one\ntwo'],
  ['bold', '<p><strong>a|b</strong></p>', 'X\nY'],
  ['link end', '<p>x<a href="https://e.test">ab|</a>z</p>', 'X\nY'],
  ['code end', '<p>x<code>ab|</code></p>', 'X\nY'],
  ['stored mark', '<p>|</p>', 'alpha\nbeta', 'bold'],
  ['cells', table, 'one\ntwo', 'cells', false],
  ['blocks', '<p>ab[c</p><p>d]ef</p>', 'X\nY'],
  [
    'blocks into a list',
    '<p>a[b</p><ul><li><p>c]d</p><p>more</p></li><li><p>x</p></li></ul>',
    'X\n\nY\n',
  ],
  [
    'items',
    '<ul><li><p>a[b</p></li><li><p>c]d</p></li><li><p>x</p></li></ul>',
    'X\n\nY\n',
  ],
  ['all', '<h1>Title</h1><p>replace me</p>', 'X\n\nY\n', 'all'],
  [
    'all from a list',
    '<ol start="7"><li><p>a</p></li></ol><p>b</p>',
    'X\n\nY\n',
    'all',
  ],
  [
    'line breaks only',
    '<ol start="7"><li><p>ab|</p></li><li><p>tail</p></li></ol>',
    '\n\n',
    undefined,
    false,
  ],
  ['block kinds', '<p>a[b</p><h2>c]d</h2>', 'X\nY', undefined, false],
  [
    'into a table',
    '<p>a[b</p><table><tbody><tr><td><p>c]d</p></td></tr></tbody></table>',
    'X\nY',
    undefined,
    false,
  ],
  [
    'task',
    '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>|</p></li></ul>',
    '\nb',
    undefined,
    false,
  ],
  [
    'nested list end',
    '<ul><li><p>x</p><ul><li><p>y|</p></li></ul></li></ul>',
    'a\n\nb',
    undefined,
    false,
  ],
  [
    'item start',
    '<ul><li><p>|x</p><ul><li><p>y</p></li></ul></li></ul>',
    '\nb',
    undefined,
    false,
  ],
  ['single line', '<p>a|</p>', 'one line', undefined, false],
]

async function installTiptapMultilineProbe(page) {
  await page.evaluate(() => {
    const editor = document.querySelector('.tiptap').editor
    const handlers = editor.options.editorProps.handleDOMEvents
    const probe = { prevented: [], inputs: [], steps: [] }
    window.addEventListener('beforeinput', (event) =>
      probe.prevented.push(event.defaultPrevented),
    )
    window.addEventListener('input', (event) => probe.inputs.push(event.data))
    editor.on('transaction', ({ transaction }) => {
      if (transaction.docChanged) probe.steps.push(transaction.steps.length)
    })
    // `|` marks the caret and `[` `]` a selection. `browser` leaves every
    // input to the browser, as the editor did before.
    window.richLines = (html, select, browser) => {
      editor.setOptions({
        editorProps: {
          ...editor.options.editorProps,
          handleDOMEvents: {
            ...handlers,
            beforeinput: browser ? () => false : handlers.beforeinput,
          },
        },
      })
      editor.commands.setContent(html, { contentType: 'html' })
      const marks = []
      editor.state.doc.descendants((node, pos) => {
        for (const match of node.text?.matchAll(/[|[\]]/g) ?? [])
          marks.push(pos + match.index)
      })
      const tr = editor.state.tr
      for (const pos of [...marks].reverse()) tr.delete(pos, pos + 1)
      editor.view.dispatch(tr)
      const [from, to = from] = marks.map((pos, index) => pos - index)
      if (select === 'cells') {
        const cells = []
        editor.state.doc.descendants((node, pos) => {
          if (node.type.name === 'tableCell') cells.push(pos)
        })
        editor.commands.setCellSelection({
          anchorCell: cells[0],
          headCell: cells.at(-1),
        })
      } else if (select === 'all') editor.commands.selectAll()
      else editor.commands.setTextSelection({ from, to })
      if (select === 'bold') editor.commands.setMark('bold')
      Object.assign(probe, { prevented: [], inputs: [], steps: [] })
      const { $to } = editor.state.selection
      return $to.parent.textBetween($to.parentOffset, $to.parent.content.size)
    }
    window.richLinesResult = () => {
      const { $head } = editor.state.selection
      return {
        ...probe,
        doc: editor.getJSON(),
        markdown: editor.getMarkdown(),
        caret: [
          $head.parent.textBetween(0, $head.parentOffset),
          $head.parent.textBetween(
            $head.parentOffset,
            $head.parent.content.size,
          ),
        ],
      }
    }
  })
}

test('typing coalesces formatting checks without delaying document changes or undo', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-input-'))
  const app = await launchBenchmarkApp(profile)
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await selectFormattedEngine(app, page, 'tiptap')
  await waitForEditor(page)
  const result = await page.evaluate(async () => {
    const editor = document.querySelector('.tiptap').editor
    await new Promise(requestAnimationFrame)
    const visibleActions = document.querySelectorAll(
      '.editor-toolbar [data-toolbar-id^="format."]',
    ).length
    let checks = 0
    const can = editor.can.bind(editor)
    editor.can = (...args) => {
      checks++
      return can(...args)
    }
    for (const letter of 'hello') editor.commands.insertContent(letter)
    const immediate = { checks, text: editor.getText() }
    await new Promise(requestAnimationFrame)
    const inFrame = checks
    while (!checks) await new Promise(requestAnimationFrame)
    await new Promise(requestAnimationFrame)
    const afterFrame = checks
    const persisted = (await window.hibi.getDocument()).markdown
    editor.commands.undo()
    const undone = editor.getText()
    editor.commands.redo()
    return {
      immediate,
      inFrame,
      afterFrame,
      visibleActions,
      persisted,
      undone,
      redone: editor.getText(),
    }
  })
  assert.deepEqual(result.immediate, { checks: 0, text: 'hello' })
  assert.ok(result.visibleActions > 0)
  // One refresh for all five transactions, after the frame that showed them.
  assert.equal(result.inFrame, 0)
  assert.equal(result.afterFrame, result.visibleActions)
  assert.equal(result.persisted, 'hello')
  assert.equal(result.undone, '')
  assert.equal(result.redone, 'hello')
})

test('multi-line text input in the visual editor makes the browser edit in one step', {
  timeout: 120000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-rich-lines-'))
  const app = await launchBenchmarkApp(profile)
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await selectFormattedEngine(app, page, 'tiptap')
  await waitForEditor(page)
  const rich = page.getByRole('textbox', {
    name: 'Document editor',
    exact: true,
  })
  await installTiptapMultilineProbe(page)
  const cases = multilineInputCases
  for (const [what, html, text, select, handled = true] of cases) {
    const capture = inputFixtureCapture
      ? await captureTiptapInputRange(page, html, select)
      : null
    const results = []
    for (const browser of [true, false]) {
      await rich.focus()
      const rest = await page.evaluate(
        (args) => window.richLines(...args),
        [html, select, browser],
      )
      await page.keyboard.insertText(text)
      results.push({
        rest,
        ...(await page.evaluate(() => window.richLinesResult())),
      })
    }
    const [browser, typed] = results
    assert.deepEqual(
      [typed.doc, typed.markdown],
      [browser.doc, browser.markdown],
      what,
    )
    assert.deepEqual(typed.prevented, [handled], what)
    if (inputFixtureCapture)
      emitInputFixture(t, 'multiline', what, {
        ...capture,
        input: text,
        select: select ?? null,
        handled,
        result: { markdown: typed.markdown, caret: typed.caret },
      })
    if (!handled) continue
    // One step and the input signal, with the caret after the input (the
    // browser's own edit can leave it a line early).
    assert.deepEqual([typed.steps, typed.inputs], [[1], [text]], what)
    const line = text.split(/\r\n?|\n/).at(-1)
    assert.equal(typed.caret[1], typed.rest, what)
    assert.ok(
      what === 'code' ? typed.caret[0].endsWith(line) : typed.caret[0] === line,
      `${what}: ${typed.caret}`,
    )
  }
  const undone = []
  for (const browser of [true, false]) {
    await rich.focus()
    await page.evaluate(
      (browser) => window.richLines('<p>|</p>', undefined, browser),
      browser,
    )
    await page.keyboard.insertText('hello')
    await page.keyboard.insertText('one\ntwo')
    undone.push(
      await page.evaluate(() => {
        const editor = document.querySelector('.tiptap').editor
        editor.commands.undo()
        return editor.getJSON()
      }),
    )
  }
  assert.deepEqual(undone[1], undone[0])
  // Ending a list at its only item keeps the text, which the browser's own
  // edit drops.
  const captureEnd = inputFixtureCapture
    ? await captureTiptapInputRange(page, '<ul><li><p>|</p></li></ul><p>z</p>')
    : null
  await rich.focus()
  await page.evaluate(() =>
    window.richLines('<ul><li><p>|</p></li></ul><p>z</p>', undefined, false),
  )
  await page.keyboard.insertText('\nb')
  const ended = await page.evaluate(() => window.richLinesResult())
  assert.deepEqual(
    [ended.prevented, ended.markdown, ended.caret],
    [[true], 'b\n\nz', ['b', '']],
  )
  if (inputFixtureCapture)
    emitInputFixture(t, 'special', 'empty-list-exit', {
      ...captureEnd,
      input: '\nb',
      select: null,
      result: { markdown: ended.markdown, caret: ended.caret },
    })
})

test('multi-line text input work in the visual editor stays linear in the lines', {
  timeout: 60000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-rich-lines-work-'))
  const app = await launchBenchmarkApp(profile)
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await selectFormattedEngine(app, page, 'tiptap')
  await waitForEditor(page)
  const rich = page.getByRole('textbox', {
    name: 'Document editor',
    exact: true,
  })
  await page.evaluate(() => {
    const editor = document.querySelector('.tiptap').editor
    const mapping = Object.getPrototypeOf(editor.state.tr.mapping),
      map = mapping.map
    const work = { prevented: [] }
    window.richLinesWork = work
    window.addEventListener('beforeinput', (event) =>
      work.prevented.push(event.defaultPrevented),
    )
    editor.on('transaction', ({ transaction }) => {
      if (!transaction.docChanged) return
      work.transactions++
      work.steps += transaction.steps.length
    })
    mapping.map = function (...args) {
      work.maps++
      work.mapped += this.to - this.from
      return map.apply(this, args)
    }
  })
  const counts = []
  // Into an empty paragraph, and over everything after select all.
  for (const all of [false, true])
    for (const lines of [500, 1000]) {
      await rich.focus()
      await page.evaluate((all) => {
        const editor = document.querySelector('.tiptap').editor
        editor.commands.setContent(
          all ? '<h1>Title</h1><p>replace me</p>' : '<p></p>',
          { contentType: 'html' },
        )
        editor.commands.setTextSelection(1)
      }, all)
      if (all) await rich.press('ControlOrMeta+a')
      const captureWork = inputFixtureCapture
        ? await rich.evaluate((element, all) => {
            const source = element.editor.getMarkdown()
            return { source, from: 0, to: all ? source.length : 0 }
          }, all)
        : null
      await page.evaluate(() =>
        Object.assign(window.richLinesWork, {
          prevented: [],
          transactions: 0,
          steps: 0,
          maps: 0,
          mapped: 0,
        }),
      )
      // Lines with markdown syntax, which paste rules would format.
      await page.keyboard.insertText(
        Array.from(
          { length: lines },
          (_, index) => `line **${index}** _${index}_ \`${index}\``,
        ).join('\n'),
      )
      counts.push({
        all,
        lines,
        ...(await page.evaluate(() => ({
          ...window.richLinesWork,
          blocks: document.querySelector('.tiptap').editor.state.doc.childCount,
        }))),
      })
      if (inputFixtureCapture)
        emitInputFixture(t, 'linear', (all ? 'all' : 'empty') + ':' + lines, {
          ...captureWork,
          all,
          lines,
          result: {
            markdown: await rich.evaluate((element) =>
              element.editor.getMarkdown(),
            ),
          },
        })
    }
  for (const result of counts)
    assert.deepEqual(
      [result.prevented, result.transactions, result.steps, result.blocks],
      [[true], 1, 1, result.lines],
      JSON.stringify(result),
    )
  // Twice the lines, at most twice the position mapping work.
  for (const [small, large] of [counts.slice(0, 2), counts.slice(2)])
    assert.ok(
      large.maps <= 2 * small.maps + 8 && large.mapped <= 2 * small.mapped + 8,
      JSON.stringify(counts),
    )
})

test('visual typing after a source visit defers the hidden source and toolbar checks', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-hidden-source-'))
  const app = await launchBenchmarkApp(profile)
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await selectFormattedEngine(app, page, 'tiptap')
  await waitForEditor(page)
  await switchToSource(app, page)
  await pressShortcut(
    app,
    `${process.platform === 'darwin' ? 'Meta' : 'Control'}+Shift+[`,
  )
  await page.waitForFunction(
    () =>
      document.querySelector('.editor-panes.mode-normal') &&
      document.querySelector('.source-pane .cm-content')?.closest('[inert]'),
  )
  await waitForEditor(page)
  const result = await page.evaluate(async () => {
    const editor = document.querySelector('.tiptap').editor
    const source = document.querySelector('.cm-content').cmTile.root.view
    editor.commands.focus('end')
    await new Promise(requestAnimationFrame)
    const visibleActions = document.querySelectorAll(
      '.editor-toolbar [data-toolbar-id^="format."]',
    ).length
    let updates = 0,
      checks = 0
    const update = source.update.bind(source)
    // Echoes change the document; focus and parser updates of the hidden view do not.
    source.update = (transactions) => {
      if (transactions.some((transaction) => transaction.docChanged)) updates++
      return update(transactions)
    }
    const can = editor.can.bind(editor)
    editor.can = (...args) => {
      checks++
      return can(...args)
    }
    for (const letter of 'hello') editor.commands.insertContent(letter)
    const immediate = { updates, checks, text: editor.getText() }
    while (!checks) await new Promise(requestAnimationFrame)
    await new Promise(requestAnimationFrame)
    return { immediate, afterFrame: { updates, checks }, visibleActions }
  })
  // One toolbar refresh after paint; the hidden source waits until shown.
  assert.deepEqual(result.immediate, { updates: 0, checks: 0, text: 'hello' })
  assert.deepEqual(result.afterFrame, {
    updates: 0,
    checks: result.visibleActions,
  })
  await switchToSource(app, page)
  const shown = await page.evaluate(async () => {
    const source = document.querySelector('.cm-content').cmTile.root.view
    return {
      text: source.state.doc.toString(),
      persisted: (await window.hibi.getDocument()).markdown,
    }
  })
  assert.deepEqual(shown, { text: 'hello', persisted: 'hello' })
})

it('multi-line text input reaches source view in one edit, without native paragraph steps', {
  timeout: 60000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-source-lines-'))
  const app = await launchBenchmarkApp(profile)
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await selectFormattedEngine(app, page, t.formattedEngine)
  await waitForEditor(page)
  await switchToSource(app, page)
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  await page.evaluate(() => {
    const probe = { added: 0, prevented: [], inputs: [] }
    window.sourceLineInput = probe
    new MutationObserver((records) => {
      for (const record of records) probe.added += record.addedNodes.length
    }).observe(document.querySelector('.source-pane .cm-content'), {
      childList: true,
      subtree: true,
    })
    window.addEventListener('beforeinput', (event) =>
      probe.prevented.push(event.defaultPrevented),
    )
    window.addEventListener('input', (event) =>
      probe.inputs.push(event.inputType),
    )
  })
  const insert = async (text) => {
    await source.press('ControlOrMeta+a')
    await page.evaluate(() => {
      window.sourceLineInput.added = 0
      window.sourceLineInput.prevented = []
      window.sourceLineInput.inputs = []
    })
    await page.keyboard.insertText(text)
    await waitForAsync(
      page,
      async (text) => (await window.hibi.getDocument()).markdown === text,
      text,
    )
    return page.evaluate(async () => {
      await new Promise(requestAnimationFrame)
      const view = document.querySelector('.source-pane .cm-content').cmTile
        .root.view
      return {
        ...window.sourceLineInput,
        text: view.state.doc.toString(),
        head: view.state.selection.main.head,
      }
    })
  }
  const paragraphs = (count) =>
    Array.from({ length: count }, (_, index) => `line ${index}`).join('\n\n')
  const small = await insert(paragraphs(100))
  const large = await insert(paragraphs(1000))
  const added = JSON.stringify({ small: small.added, large: large.added })
  for (const [result, text] of [
    [small, paragraphs(100)],
    [large, paragraphs(1000)],
  ]) {
    assert.deepEqual(result.prevented, [true], added)
    // The typing signal still arrives, as it would from the browser.
    assert.deepEqual(result.inputs, ['insertText'])
    assert.equal(result.text, text)
    assert.equal(result.head, text.length)
  }
  // The editor renders its viewport once instead of the browser adding a
  // block per line break, so the work no longer grows with the paragraphs.
  assert.ok(large.added < 1000 && large.added < small.added * 2, added)
  const plain = await insert('one line')
  assert.deepEqual([plain.prevented, plain.text], [[false], 'one line'])
})

it('source input handlers see multi-line text input with normalized line breaks', {
  timeout: 60000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-source-line-handler-'))
  const addon = join(profile, 'installed-addons', 'upper-input')
  await mkdir(addon, { recursive: true })
  await writeFile(
    join(addon, 'hibi-addon.json'),
    JSON.stringify({
      id: 'upper-input',
      name: 'Upper input',
      description: 'Consuming source input handler fixture',
      kind: 'extension',
      apiVersion: 2,
      version: '1.0.0',
      authors: [{ displayName: 'Test' }],
      capabilities: ['source'],
      entry: 'index.js',
    }),
  )
  await writeFile(
    join(addon, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['hibi-addon.json', 'index.js'],
      source: 'local',
    }),
  )
  await writeFile(
    join(addon, 'index.js'),
    `export default sdk => ({ start(context) {
      window.upperInput = []
      window.upperHandler = (view, from, to, text) => {
        if (!/[\\r\\n]/.test(text)) return false
        window.upperInput.push(text)
        view.dispatch({ changes: { from, to, insert: text.toUpperCase() },
          selection: { anchor: from + text.length } })
        return true
      }
      context.editor.registerSource({ id: 'upper', create: () =>
        sdk.codeMirror.view.EditorView.inputHandler.of(window.upperHandler) })
    }})`,
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'upper-input': true }),
  )
  const app = await launchBenchmarkApp(profile)
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await selectFormattedEngine(app, page, t.formattedEngine)
  await waitForEditor(page)
  await switchToSource(app, page)
  await page.waitForFunction(() => {
    const view = document.querySelector('.source-pane .cm-content')?.cmTile.root
      .view
    return (
      view?.contentDOM.isContentEditable &&
      view.state
        .facet(view.constructor.inputHandler)
        .includes(window.upperHandler)
    )
  })
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  for (const [input, expected] of [
    ['a\r\nb', 'A\nB'],
    ['c\rd', 'C\nD'],
  ]) {
    await source.press('ControlOrMeta+a')
    await page.keyboard.insertText(input)
    await waitForAsync(
      page,
      async (expected) =>
        (await window.hibi.getDocument()).markdown === expected,
      expected,
    )
    const view = await page.evaluate(() => {
      const view = document.querySelector('.source-pane .cm-content').cmTile
        .root.view
      return {
        text: view.state.doc.toString(),
        head: view.state.selection.main.head,
        seen: window.upperInput.at(-1),
      }
    })
    assert.deepEqual(view, {
      text: expected,
      head: 3,
      seen: expected.toLowerCase(),
    })
  }
})

test('formatting toolbar states match each action check across selections, typing and history', {
  timeout: 60000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-toolbar-states-'))
  const file = join(profile, 'states.md')
  await writeFile(
    file,
    [
      '# Title',
      'plain **bold** *italic* ~~strike~~ `code` [link](https://example.com) end',
      '- one\n- two\n  - nested',
      '1. first\n2. second',
      '- [ ] task\n- [x] done',
      '> quote',
      '```js\nconst x = 1\n```',
      '| a | b |\n| - | - |\n| cell | 2 |',
      '',
    ].join('\n\n'),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`, file],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await selectFormattedEngine(app, page, 'tiptap')
  await waitForDocumentEditor(app, page)
  await installTiptapToolbarProbe(page)
  const states = () => page.evaluate(() => window.__toolbarStates())
  const settled = async (label) => {
    try {
      await page.waitForFunction(
        () => {
          const { expected, actual } = window.__toolbarStates()
          return (
            Object.keys(actual).length === Object.keys(expected).length &&
            Object.entries(expected).every(
              ([id, state]) =>
                actual[id]?.pressed === state.pressed &&
                actual[id]?.disabled === state.disabled,
            )
          )
        },
        undefined,
        { timeout: APP_STATE_TIMEOUT },
      )
    } catch {
      const { expected, actual } = await states()
      assert.deepEqual(actual, expected, label)
    }
    return (await states()).actual
  }
  const select = (text, offset = 1, length = 0) =>
    page.evaluate(
      ({ text, offset, length }) => {
        const editor = document.querySelector('.tiptap').editor
        let from = null
        editor.state.doc.descendants((node, position) => {
          if (from === null && node.isText && node.text.includes(text))
            from = position + node.text.indexOf(text) + offset
          return from === null
        })
        editor.commands.setTextSelection({ from, to: from + length })
      },
      { text, offset, length },
    )
  const cases = {}
  for (const [label, text, offset, length] of toolbarSelectionCases) {
    await select(text, offset, length)
    cases[label] = await settled(label)
    if (inputFixtureCapture)
      emitInputFixture(
        t,
        'toolbar',
        label,
        await captureTiptapToolbarRange(page, text, offset, length),
      )
  }
  await page.evaluate(() =>
    document.querySelector('.tiptap').editor.commands.selectAll(),
  )
  cases['whole document'] = await settled('whole document')
  if (inputFixtureCapture)
    emitInputFixture(
      t,
      'toolbar',
      'whole document',
      await captureTiptapToolbarRange(page, null),
    )
  assert.equal(cases.heading['heading-1'].pressed, 'true')
  assert.equal(cases['bold text'].bold.pressed, 'true')
  assert.equal(cases['plain text'].bold.pressed, 'false')
  assert.equal(cases['code block']['code-block'].pressed, 'true')
  assert.equal(cases['code block'].bold.disabled, true)
  assert.equal(cases['first list item'].indent.disabled, true)
  assert.equal(cases['second list item'].indent.disabled, false)
  assert.equal(cases['nested list item'].outdent.disabled, false)
  assert.equal(cases['table cell']['row-after'].disabled, false)
  assert.equal(cases['plain text']['row-after'], undefined)

  await select('end', 3)
  await page.evaluate(() =>
    document.querySelector('.tiptap').editor.commands.toggleBold(),
  )
  assert.equal((await settled('stored bold mark')).bold.pressed, 'true')
  await page.evaluate(() => document.querySelector('.tiptap').focus())
  await page.keyboard.type(' typed')
  const typed = await settled('after typing')
  assert.equal(typed.undo.disabled, false)
  assert.equal(typed.bold.pressed, 'true')
  await page.evaluate(() =>
    document.querySelector('.tiptap').editor.commands.undo(),
  )
  assert.equal((await settled('after undo')).redo.disabled, false)
  await page.evaluate(() =>
    document.querySelector('.tiptap').editor.commands.redo(),
  )
  assert.equal((await settled('after redo')).redo.disabled, true)

  await select('plain')
  assert.equal((await settled('before toolbar click')).bold.pressed, 'false')
  // A click before the toolbar refreshes still formats the live selection.
  const shown = await page.evaluate(() => {
    const editor = document.querySelector('.tiptap').editor
    let from = null
    editor.state.doc.descendants((node, position) => {
      if (from === null && node.isText && node.text === 'bold') from = position
      return from === null
    })
    editor.commands.setTextSelection({ from, to: from + 4 })
    const button = document.querySelector(
      '.editor-toolbar [data-toolbar-id="format.bold"]',
    )
    const pressed = button.getAttribute('aria-pressed')
    button.click()
    return pressed
  })
  assert.equal(shown, 'false')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('plain bold *italic*'),
  )
  assert.equal((await settled('after toolbar click')).bold.pressed, 'false')
})

test('blank paragraphs and typed spaces survive tab switches without nonbreaking spaces', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-space-input-'))
  const file = join(profile, 'spaces.md')
  await writeFile(file, '')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`, file],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await selectFormattedEngine(app, page, 'tiptap')
  await waitForDocumentEditor(app, page)
  await page.waitForFunction(
    () => document.querySelector('.tiptap')?.isContentEditable,
  )
  const rich = page.getByRole('textbox', { name: 'Document editor' })
  await rich.click()
  await page.keyboard.type('first')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('second')
  await page.keyboard.press('Space')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.endsWith('second '),
  )
  const typed = await page.evaluate(() => window.hibi.getDocument())
  assert.equal(typed.markdown, 'first\n\n\n\nsecond ')
  assert.doesNotMatch(typed.markdown, /&nbsp;|\u00a0/)
  await clickMenu(app, 'New')
  await page.waitForFunction(
    () => document.querySelector('.tiptap')?.textContent === '',
  )
  await page.getByRole('tab', { name: 'spaces.md', exact: true }).click()
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId === id,
    typed.tabId,
  )
  await page.waitForFunction(
    () => document.querySelector('.tiptap')?.textContent === 'firstsecond ',
  )
  const restored = await page.evaluate(() => window.hibi.getDocument())
  assert.equal(restored.tabId, typed.tabId)
  assert.equal(restored.markdown, typed.markdown)
  assert.doesNotMatch(restored.markdown, /&nbsp;|\u00a0/)
  await page.evaluate(() => window.hibi.saveDocument(false))
  assert.equal(await readFile(file, 'utf8'), typed.markdown)
})

for (const spaces of [1, 2]) {
  test(`typing a letter after ${spaces} trailing spaces keeps regular spaces`, {
    timeout: 30000,
  }, async (t) => {
    const profile = await mkdtemp(join(tmpdir(), 'hibi-trailing-space-'))
    const app = await launchBenchmarkApp(profile)
    t.after(async () => {
      await app.close()
      await rm(profile, { recursive: true, force: true })
    })
    const page = await app.firstWindow()
    const whitespaceWarnings = []
    page.on('console', (message) => {
      if (/white-space/.test(message.text()))
        whitespaceWarnings.push(message.text())
    })
    await selectFormattedEngine(app, page, 'tiptap')
    await waitForEditor(page)
    const rich = page.getByRole('textbox', { name: 'Document editor' })
    assert.equal(
      await rich.evaluate((element) => getComputedStyle(element).whiteSpace),
      'pre-wrap',
    )
    await rich.click()
    await page.keyboard.type('hi')
    for (let index = 0; index < spaces; index++)
      await page.keyboard.press('Space')
    await page.keyboard.type('x')
    const expected = `hi${' '.repeat(spaces)}x`
    await waitForAsync(
      page,
      async (text) => (await window.hibi.getDocument()).markdown === text,
      expected,
    )
    const { markdown } = await page.evaluate(() => window.hibi.getDocument())
    assert.equal(markdown, expected)
    assert.doesNotMatch(markdown, /&nbsp;|\u00a0/)
    assert.equal(await rich.textContent(), expected)
    assert.deepEqual(whitespaceWarnings, [])
    await rich.evaluate((element) => element.editor.commands.undo())
    await waitForAsync(
      page,
      async () => (await window.hibi.getDocument()).markdown === '',
    )
  })
}

test('long documents with HTML and reference syntax stay visually editable through save and undo', {
  timeout: 60000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-unrestricted-rich-'))
  const file = join(profile, 'long.md')
  const original = [
    '# Editable document',
    '<div>HTML content</div>',
    '[reference][target]\n\n[target]: https://example.com',
    ...Array(40).fill('alpha beta '.repeat(500)),
  ].join('\n\n')
  // Keep visual coverage below the current source-first opening threshold.
  assert.ok(original.length > 200000)
  assert.ok(original.length <= 256 * 1024)
  await writeFile(file, original)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`, file],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await selectFormattedEngine(app, page, 'tiptap')
  page.setDefaultTimeout(15000)
  const editable = () =>
    page.waitForFunction(
      () => document.querySelector('.tiptap')?.isContentEditable,
    )
  await editable()
  const opened = (await page.evaluate(() => window.hibi.getDocument())).markdown
  assert.match(opened, /^# Editable document/)
  assert.match(opened, /HTML content/)
  assert.match(opened, /reference/)
  assert.ok(opened.length > 200000)
  await page
    .waitForFunction(() => {
      const editor = document.querySelector('.tiptap')
      const panel = editor?.closest('.editor-page')
      return (
        editor?.isContentEditable &&
        editor.textContent?.startsWith('Editable document') &&
        panel?.getAttribute('aria-busy') === 'false' &&
        !panel.hasAttribute('inert')
      )
    })
    .catch(async (error) => {
      const state = await page.evaluate(() => {
        const editor = document.querySelector('.tiptap')
        const panel = editor?.closest('.editor-page')
        return {
          text: editor?.textContent?.slice(0, 80),
          editable: editor?.isContentEditable,
          busy: panel?.getAttribute('aria-busy'),
          inert: panel?.hasAttribute('inert'),
        }
      })
      assert.fail(
        `long document never became editable: ${error.message}\n${JSON.stringify(state)}`,
      )
    })
  if (showTestWindows)
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setFocusable(true)
      window.show()
      window.focus()
    })
  await page.locator('.tiptap').evaluate((element) => {
    element.editor.commands.setTextSelection(1)
    element.editor.view.focus()
  })
  await page
    .waitForFunction(
      (needsWindowFocus) =>
        (!needsWindowFocus || document.hasFocus()) &&
        document.activeElement?.classList.contains('tiptap'),
      showTestWindows,
      { timeout: 5000 },
    )
    .catch(async (error) => {
      const state = await page.evaluate(() => ({
        focused: document.hasFocus(),
        active: document.activeElement?.outerHTML.slice(0, 160),
      }))
      assert.fail(
        `long document editor never received focus: ${error.message}\n${JSON.stringify(state)}`,
      )
    })
  await page.keyboard.insertText('edited ')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.startsWith(
      '# edited Editable document',
    ),
  )
  const edited = (await page.evaluate(() => window.hibi.getDocument())).markdown
  assert.ok(edited.includes('alpha beta'))
  await page.locator('.tiptap').evaluate((element) => {
    element.editor.commands.undo()
  })
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    opened,
  )
  await editable()
  await page.locator('.tiptap').evaluate((element) => {
    element.editor.commands.redo()
  })
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    edited,
  )
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await page
    .getByRole('textbox', { name: 'Markdown editor', exact: true })
    .waitFor()
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await editable()
  await page.evaluate(() => window.hibi.saveDocument(false))
  assert.equal(await readFile(file, 'utf8'), edited)
  await page.reload()
  await editable()
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    edited,
  )
})

const toolbarSelectionCases = [
  ['heading', 'Title'],
  ['plain text', 'plain'],
  ['bold text', 'bold'],
  ['italic selection', 'italic', 0, 6],
  ['mixed selection', 'plain', 0, 14],
  ['inline code', 'code'],
  ['link', 'link'],
  ['first list item', 'one'],
  ['second list item', 'two'],
  ['nested list item', 'nested'],
  ['numbered list', 'second'],
  ['checklist', 'task'],
  ['quote', 'quote'],
  ['code block', 'const'],
  ['table cell', 'cell'],
]

async function installTiptapToolbarProbe(page) {
  await page.evaluate(() => {
    // The same capability and active checks FormattingToolbar runs for each rich action.
    const list = (editor) =>
      editor.isActive('taskList') ? 'taskItem' : 'listItem'
    const actions = [
      ['undo', (c) => c.undo()],
      ['redo', (c) => c.redo()],
      ['bold', (c) => c.toggleBold(), 'bold'],
      ['italic', (c) => c.toggleItalic(), 'italic'],
      ['strike', (c) => c.toggleStrike(), 'strike'],
      ['inline-code', (c) => c.toggleCode(), 'code'],
      ['subscript', (c) => c.toggleMark('subscript'), 'subscript'],
      ['subtext', (c) => c.setNode('subtext'), 'subtext'],
      ['paragraph', (c) => c.setParagraph(), 'paragraph'],
      ...[1, 2, 3, 4, 5, 6].map((level) => [
        `heading-${level}`,
        (c) => c.toggleHeading({ level }),
        'heading',
        { level },
      ]),
      ['bullet-list', (c) => c.toggleBulletList(), 'bulletList'],
      ['numbered-list', (c) => c.toggleOrderedList(), 'orderedList'],
      ['checklist', (c) => c.toggleTaskList(), 'taskList'],
      ['indent', (c, editor) => c.sinkListItem(list(editor))],
      ['outdent', (c, editor) => c.liftListItem(list(editor))],
      ['quote', (c) => c.toggleBlockquote(), 'blockquote'],
      ['code-block', (c) => c.toggleCodeBlock(), 'codeBlock'],
      ['divider', (c) => c.setHorizontalRule()],
      ['hard-break', (c) => c.setHardBreak()],
      ['link', (c) => c.setLink({ href: 'https://example.com' }), 'link'],
      ['unlink', (c) => c.unsetLink()],
      ['image', (c) => c.setImage({ src: 'image.png' })],
      [
        'table',
        (c) => c.insertTable({ rows: 3, cols: 2, withHeaderRow: true }),
      ],
      ...[
        ['row-before', (c) => c.addRowBefore()],
        ['row-after', (c) => c.addRowAfter()],
        ['row-delete', (c) => c.deleteRow()],
        ['column-before', (c) => c.addColumnBefore()],
        ['column-after', (c) => c.addColumnAfter()],
        ['column-delete', (c) => c.deleteColumn()],
        ['table-delete', (c) => c.deleteTable()],
      ].map(([id, rich]) => [id, rich, undefined, undefined, true]),
    ]
    window.__toolbarStates = () => {
      const editor = document.querySelector('.tiptap').editor
      const inTable = editor.isActive('table')
      const expected = {}
      for (const [id, rich, active, attrs, table] of actions) {
        if (table && !inTable) continue
        let allowed
        try {
          allowed = rich(editor.can().chain(), editor).run()
        } catch {
          allowed = false
        }
        expected[id] = {
          pressed: active ? String(editor.isActive(active, attrs)) : null,
          disabled: !editor.isEditable || !allowed,
        }
      }
      const actual = {}
      for (const button of document.querySelectorAll(
        '.editor-toolbar [data-toolbar-id^="format."]',
      ))
        actual[button.dataset.toolbarId.slice('format.'.length)] = {
          pressed:
            button.getAttribute('aria-pressed') ??
            button.getAttribute('aria-checked'),
          disabled: button.disabled,
        }
      return { expected, actual }
    }
  })
}

async function launchInputFixture(
  t,
  source,
  engine = 'codemirror',
  counted = false,
) {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-input-parity-'))
  const file = join(profile, counted ? 'input.countmd' : 'input.md')
  await writeFile(file, source)
  if (counted) {
    const folder = join(profile, 'installed-addons', 'counted-format')
    await mkdir(folder, { recursive: true })
    await writeFile(
      join(folder, 'hibi-addon.json'),
      JSON.stringify({
        id: 'counted-format',
        name: 'Counted format',
        description: 'Count toolbar inspections',
        kind: 'extension',
        apiVersion: 2,
        version: '1.0.0',
        capabilities: ['source'],
        authors: [{ displayName: 'Test' }],
        fileExtensions: ['countmd'],
        entry: 'index.js',
      }),
    )
    await writeFile(
      join(folder, '.hibi-install.json'),
      JSON.stringify({
        hash: 'a'.repeat(64),
        files: ['hibi-addon.json', 'index.js'],
        source: 'local',
      }),
    )
    await writeFile(
      join(folder, 'index.js'),
      'export default () => ({ start(context) {' +
        'window.countedFormatChecks = [];' +
        'context.editor.registerDocumentFormat({' +
        'id:"counted",name:"Counted Markdown",extensions:["countmd"],editing:"markdown",' +
        'views:["normal","side-by-side","markdown"],Preview(){return null},formatting:{' +
        'actions:["bold","italic","strike","inline-code","subscript","subtext","paragraph",' +
        '"heading-1","heading-2","heading-3","heading-4","heading-5","heading-6",' +
        '"bullet-list","numbered-list","checklist","quote","code-block","divider","hard-break","link","unlink","image","table"],' +
        'apply(){return null},isActive(id){window.countedFormatChecks.push(id);return false}' +
        '}}); }});',
    )
    await writeFile(
      join(profile, 'addons.json'),
      JSON.stringify({ 'counted-format': true }),
    )
  }
  const app = await electron.launch({
    args: [resolve('.'), '--user-data-dir=' + profile],
  })
  let cdp
  let closed = false
  const close = async () => {
    if (!closed) {
      closed = true
      await cdp?.detach()
      await app.close()
    }
  }
  t.after(async () => {
    await close()
    await rm(profile, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }, file) => {
    dialog.showMessageBox = async () => ({ response: 1 })
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  await selectFormattedEngine(app, page, engine)
  if (engine === 'codemirror') {
    cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  }
  await clickMenu(app, 'Open…')
  await waitForAsync(
    page,
    async (name) => (await window.hibi.getDocument()).name === name,
    counted ? 'input.countmd' : 'input.md',
  )
  await waitForDocumentEditor(app, page)
  const rich = page.getByRole('textbox', {
    name: 'Document editor',
    exact: true,
  })
  return { app, page, rich, file, close }
}

async function captureTiptapInputRange(page, html, select) {
  const rich = page.getByRole('textbox', {
    name: 'Document editor',
    exact: true,
  })
  const marked = await rich.evaluate((element, html) => {
    const marked = html
      .replaceAll('|', 'HIBIPORTCARET871')
      .replaceAll('[', 'HIBIPORTSTART871')
      .replaceAll(']', 'HIBIPORTEND871')
    element.editor.commands.setContent(marked, { contentType: 'html' })
    return element.editor.getMarkdown()
  }, html)
  let source = marked
    .replace('HIBIPORTCARET871', '')
    .replace('HIBIPORTSTART871', '')
    .replace('HIBIPORTEND871', '')
  let from = marked.includes('HIBIPORTCARET871')
    ? marked.indexOf('HIBIPORTCARET871')
    : marked.indexOf('HIBIPORTSTART871')
  let to = marked.includes('HIBIPORTEND871')
    ? marked.indexOf('HIBIPORTEND871') - 'HIBIPORTSTART871'.length
    : from
  if (select === 'all') {
    from = 0
    to = source.length
  }
  if (select === 'cells') {
    from = source.indexOf('a')
    to = source.lastIndexOf('d') + 1
  }
  await rich.focus()
  await page.evaluate(
    ({ html, select }) => window.richLines(html, select, false),
    { html, select },
  )
  const canonical = await rich.evaluate((element) =>
    element.editor.getMarkdown(),
  )
  if (html.includes('<table>')) {
    // A sentinel changes table column widths. Locate the original cell text instead.
    source = canonical
    if (select === 'cells') {
      from = source.indexOf('a')
      to = source.lastIndexOf('d') + 1
    } else if (html.startsWith('<p>a[b')) {
      from = source.indexOf('ab') + 1
      to = source.indexOf('cd') + 1
    } else {
      from = to = source.indexOf('a') + 1
    }
    assert.ok(from >= 0 && to >= from && to <= source.length)
  } else if (canonical !== source) {
    // Empty list/task markers can lose separator whitespace when the sentinel is removed.
    let prefix = 0,
      suffix = 0
    while (
      prefix < source.length &&
      prefix < canonical.length &&
      source[prefix] === canonical[prefix]
    )
      prefix++
    while (
      suffix < source.length - prefix &&
      suffix < canonical.length - prefix &&
      source.at(-1 - suffix) === canonical.at(-1 - suffix)
    )
      suffix++
    assert.match(
      source.slice(prefix, source.length - suffix) +
        canonical.slice(prefix, canonical.length - suffix),
      /^\s*$/,
    )
    const position = (value) =>
      value <= prefix
        ? value
        : value >= source.length - suffix
          ? canonical.length - (source.length - value)
          : prefix
    from = position(from)
    to = position(to)
    source = canonical
    if (select === 'all') {
      from = 0
      to = source.length
    }
    if (select === 'cells') {
      from = source.indexOf('a')
      to = source.lastIndexOf('d') + 1
    }
  }
  return { source, from, to }
}

// Compare rendered Markdown meaning, not table padding or escape/entity spelling.
// Empty paragraphs, block kinds, list starts/nesting/checks, marks and destinations remain observable.
function inputOutcome(source) {
  const inline = (tokens, inCell = false) => {
    const result = []
    for (const token of tokens) {
      let value
      if (inCell && token.type === 'html' && /^<br\s*\/?>$/i.test(token.text))
        value = ['break']
      else if (['text', 'escape', 'html'].includes(token.type)) {
        if (token.tokens) {
          for (const part of inline(token.tokens, inCell)) {
            if (part[0] === 'text' && result.at(-1)?.[0] === 'text')
              result.at(-1)[1] += part[1]
            else result.push(part)
          }
          continue
        }
        // Prose soft breaks flow as spaces; raw HTML stays literal.
        value = [
          'text',
          decodeHTML(
            token.type === 'text' && !inCell
              ? token.raw.replace(/\n/g, ' ')
              : token.text,
          ),
        ]
      } else if (token.type === 'codespan') value = ['code', token.text]
      else if (token.type === 'br') value = ['break']
      else if (['strong', 'em', 'del'].includes(token.type))
        value = [token.type, inline(token.tokens, inCell)]
      else if (token.type === 'link' || token.type === 'image')
        value = [
          token.type,
          token.href,
          token.title ?? '',
          inline(token.tokens, inCell),
        ]
      else assert.fail('unhandled input outcome token: ' + token.type)
      if (value[0] === 'text' && result.at(-1)?.[0] === 'text')
        result.at(-1)[1] += value[1]
      else result.push(value)
    }
    return result
  }
  const blocks = (tokens) =>
    tokens.flatMap((token) => {
      // Marked 18 emits this child too; the list item below retains exact checked state.
      if (token.type === 'checkbox') return []
      if (token.type === 'space') {
        // Three or four source LFs both display one empty paragraph; exact source cases stay exact below.
        return Array.from(
          {
            length: Math.max(
              0,
              Math.floor((token.raw.split('\n').length - 2) / 2),
            ),
          },
          () => ['paragraph', []],
        )
      }
      if (token.type === 'paragraph' || token.type === 'text')
        return [['paragraph', inline(token.tokens ?? [token])]]
      if (token.type === 'heading')
        return [['heading', token.depth, inline(token.tokens)]]
      if (token.type === 'code')
        return [['code-block', token.lang ?? '', token.text]]
      if (token.type === 'blockquote') return [['quote', blocks(token.tokens)]]
      if (token.type === 'list')
        return [
          [
            'list',
            token.ordered ? token.start : null,
            token.items.map((item) => [
              item.task ? Boolean(item.checked) : null,
              blocks(item.tokens),
            ]),
          ],
        ]
      if (token.type === 'table')
        return [
          [
            'table',
            token.align,
            token.header.map((cell) => inline(cell.tokens, true)),
            token.rows.map((row) =>
              row.map((cell) => inline(cell.tokens, true)),
            ),
          ],
        ]
      if (token.type === 'html')
        return [['paragraph', [['text', token.text.trimEnd()]]]]
      if (token.type === 'hr') return [['divider']]
      return assert.fail('unhandled input outcome block: ' + token.type)
    })
  return blocks(marked.lexer(source, { gfm: true }))
}

test('cm outcome projection keeps task state, prose breaks and literal text', () => {
  assert.deepEqual(inputOutcome('one\ntwo'), inputOutcome('one two'))
  assert.deepEqual(inputOutcome('one&#10;\ntwo'), [
    ['paragraph', [['text', 'one\n two']]],
  ])
  assert.notDeepEqual(inputOutcome('one\ntwo'), inputOutcome('one\n\ntwo'))
  assert.notDeepEqual(
    inputOutcome('one\n\ntwo'),
    inputOutcome('one\n\n\n\ntwo'),
  )
  assert.deepEqual(inputOutcome('~~~\none\ntwo\n~~~'), [
    ['code-block', '', 'one\ntwo'],
  ])
  for (const literal of [
    '<div>\none\ntwo\n</div>',
    'before <span title="one\ntwo">text</span>',
  ])
    assert.deepEqual(inputOutcome(literal), [
      ['paragraph', [['text', literal]]],
    ])
  assert.deepEqual(inputOutcome('one  \ntwo'), [
    ['paragraph', [['text', 'one'], ['break'], ['text', 'two']]],
  ])
  assert.deepEqual(
    inputOutcome('| h |\n| --- |\n| one<br><BR />two |')[0][3][0][0],
    [['text', 'one'], ['break'], ['break'], ['text', 'two']],
  )
  for (const [state, checked] of [
    [' ', false],
    ['x', true],
  ])
    assert.deepEqual(inputOutcome('- [' + state + '] item')[0][2][0], [
      checked,
      [['paragraph', [['text', 'item']]]],
    ])
})

async function inputWorkProbe(rich) {
  await rich.evaluate((element) => {
    const view = element.cmTile.root.view
    window.cmInputWork = {
      changes: 0,
      inserted: 0,
      removed: 0,
      added: 0,
      maps: 0,
      mapped: 0,
      prevented: [],
      beforeinput: [],
      inputs: [],
    }
    const mapping = Object.getPrototypeOf(
      Object.getPrototypeOf(view.state.changes([])),
    )
    const map = mapping.mapPos
    mapping.mapPos = function (...args) {
      window.cmInputWork.maps++
      this.iterChangedRanges(() => window.cmInputWork.mapped++, true)
      this.iterGaps(() => window.cmInputWork.mapped++)
      return map.apply(this, args)
    }
    const update = view.update.bind(view)
    view.update = (transactions) => {
      for (const transaction of transactions)
        if (transaction.docChanged) {
          window.cmInputWork.changes++
          transaction.changes.iterChanges(
            (from, to, _fromB, _toB, inserted) => {
              window.cmInputWork.inserted += inserted.length
              window.cmInputWork.removed += to - from
            },
          )
        }
      return update(transactions)
    }
    element.addEventListener('beforeinput', (event) => {
      window.cmInputWork.prevented.push(event.defaultPrevented)
      window.cmInputWork.beforeinput.push({
        owner: event.target.closest('.cm-content')?.getAttribute('aria-label'),
        type: event.inputType,
        data: event.data,
      })
    })
    element.addEventListener('input', (event) =>
      window.cmInputWork.inputs.push({
        type: event.inputType,
        data: event.data,
      }),
    )
    window.cmInputObserver = new MutationObserver((records) => {
      for (const record of records)
        window.cmInputWork.added += record.addedNodes.length
    })
    window.cmInputObserver.observe(element, { childList: true, subtree: true })
  })
}

const acceptedInput = (page) =>
  page.evaluate(async () => {
    await window.hibi.flushDocumentChanges()
    return window.hibi.getDocument()
  })

const cmCaretText = (rich) =>
  rich.evaluate((element) => {
    const selection = getSelection()
    if (!selection?.rangeCount || !element.contains(selection.focusNode))
      return null
    const node =
      selection.focusNode.nodeType === Node.ELEMENT_NODE
        ? selection.focusNode
        : selection.focusNode.parentElement
    const line = node.closest('.cm-line')
    if (!line) return null
    const inCell = !!line.closest('.hibi-lp-cell-editor')
    const plain = (range) => {
      const fragment = range.cloneContents()
      if (inCell)
        for (const br of fragment.querySelectorAll('br')) br.replaceWith('\n')
      for (const marker of fragment.querySelectorAll(
        '.hibi-lp-marker, .cm-placeholder, [aria-hidden="true"]',
      ))
        marker.remove()
      return fragment.textContent
    }
    const before = document.createRange(),
      after = document.createRange()
    before.selectNodeContents(line)
    before.setEnd(selection.focusNode, selection.focusOffset)
    after.selectNodeContents(line)
    after.setStart(selection.focusNode, selection.focusOffset)
    const text = [plain(before), plain(after)]
    // A cell's one physical source line displays <br> widgets as separate visual lines.
    return inCell ? [text[0].split('\n').at(-1), text[1].split('\n')[0]] : text
  })

const multilineInputGaps = {
  markdown: {
    structure:
      'formatted gap input-001: native multiline markdown preserves literal text and block structure',
  },
  paragraph: {
    structure:
      'formatted gap input-002: native multiline paragraph preserves literal text and block structure',
    caret:
      'formatted gap input-003: native multiline paragraph keeps inserted caret and following text',
  },
  'heading middle': {
    structure:
      'formatted gap input-004: native multiline heading middle preserves literal text and block structure',
  },
  list: {
    structure:
      'formatted gap input-005: native multiline list preserves literal text and block structure',
  },
  'list end': {
    structure:
      'formatted gap input-006: native multiline list end preserves literal text and block structure',
    caret:
      'formatted gap input-007: native multiline list end keeps inserted caret and following text',
  },
  'item paragraphs': {
    structure:
      'formatted gap input-008: native multiline item paragraphs preserves literal text and block structure',
    caret:
      'formatted gap input-009: native multiline item paragraphs keeps inserted caret and following text',
  },
  'ordered end': {
    structure:
      'formatted gap input-010: native multiline ordered end preserves literal text and block structure',
    caret:
      'formatted gap input-011: native multiline ordered end keeps inserted caret and following text',
  },
  'nested list': {
    structure:
      'formatted gap input-012: native multiline nested list preserves literal text and block structure',
    caret:
      'formatted gap input-013: native multiline nested list keeps inserted caret and following text',
  },
  quote: {
    structure:
      'formatted gap input-014: native multiline quote preserves literal text and block structure',
  },
  cell: {
    input:
      'formatted gap input-015: native table cell input emits one signal with inserted text',
  },
  selection: {
    structure:
      'formatted gap input-016: native multiline selection preserves literal text and block structure',
    caret:
      'formatted gap input-017: native multiline selection keeps inserted caret and following text',
  },
  bold: {
    structure:
      'formatted gap input-018: native multiline bold preserves literal text and block structure',
    caret:
      'formatted gap input-019: native multiline bold keeps inserted caret and following text',
  },
  'link end': {
    structure:
      'formatted gap input-020: native multiline link end preserves literal text and block structure',
    caret:
      'formatted gap input-021: native multiline link end keeps inserted caret and following text',
  },
  'code end': {
    structure:
      'formatted gap input-022: native multiline code end preserves literal text and block structure',
    caret:
      'formatted gap input-023: native multiline code end keeps inserted caret and following text',
  },
  'stored mark': {
    structure:
      'formatted gap input-024: native multiline stored mark preserves literal text and block structure',
    caret:
      'formatted gap input-025: native multiline stored mark keeps inserted caret and following text',
  },
  cells: {
    selection:
      'formatted gap input-026: native table cells selection preserves both source endpoints',
    structure:
      'formatted gap input-027: native multiline cells preserves literal text and block structure',
    cells:
      'formatted gap input-028: native table cells input preserves rendered cells',
    input:
      'formatted gap input-029: native table cells input emits one signal with inserted text',
    version:
      'formatted gap input-030: native table cells input advances source version once',
    caret:
      'formatted gap input-031: native multiline cells keeps inserted caret and following text',
  },
  blocks: {
    structure:
      'formatted gap input-032: native multiline blocks preserves literal text and block structure',
    caret:
      'formatted gap input-033: native multiline blocks keeps inserted caret and following text',
  },
  'blocks into a list': {
    structure:
      'formatted gap input-034: native multiline blocks into a list preserves literal text and block structure',
    caret:
      'formatted gap input-035: native multiline blocks into a list keeps inserted caret and following text',
  },
  items: {
    structure:
      'formatted gap input-036: native multiline items preserves literal text and block structure',
    caret:
      'formatted gap input-037: native multiline items keeps inserted caret and following text',
  },
  all: {
    structure:
      'formatted gap input-038: native multiline all preserves literal text and block structure',
  },
  'all from a list': {
    structure:
      'formatted gap input-039: native multiline all from a list preserves literal text and block structure',
  },
  'line breaks only': {
    structure:
      'formatted gap input-040: native multiline line breaks only preserves literal text and block structure',
  },
  'block kinds': {
    structure:
      'formatted gap input-041: native multiline block kinds preserves literal text and block structure',
    caret:
      'formatted gap input-042: native multiline block kinds keeps inserted caret and following text',
  },
  'into a table': {
    selection:
      'formatted gap input-043: native table into a table selection preserves both source endpoints',
    structure:
      'formatted gap input-044: native multiline into a table preserves literal text and block structure',
    cells:
      'formatted gap input-045: native table into a table input preserves rendered cells',
    caret:
      'formatted gap input-046: native multiline into a table keeps inserted caret and following text',
  },
  task: {
    structure:
      'formatted gap input-047: native multiline task preserves literal text and block structure',
    caret:
      'formatted gap input-048: native multiline task keeps inserted caret and following text',
  },
  'nested list end': {
    structure:
      'formatted gap input-049: native multiline nested list end preserves literal text and block structure',
  },
  'item start': {
    structure:
      'formatted gap input-050: native multiline item start preserves literal text and block structure',
  },
}

const linearInputGaps = {
  empty: {
    500: 'formatted gap input-052: native 500 line input into empty paragraph preserves literal blocks',
    1000: 'formatted gap input-053: native 1000 line input into empty paragraph preserves literal blocks',
  },
  all: {
    500: 'formatted gap input-054: native 500 line input into select all preserves literal blocks',
    1000: 'formatted gap input-055: native 1000 line input into select all preserves literal blocks',
  },
}

const toolbarInputGaps = {
  heading:
    'formatted gap input-057: toolbar states match live heading selection',
  'plain text':
    'formatted gap input-058: toolbar states match live plain text selection',
  'bold text':
    'formatted gap input-059: toolbar states match live bold text selection',
  'italic selection':
    'formatted gap input-060: toolbar states match live italic selection selection',
  'mixed selection':
    'formatted gap input-061: toolbar states match live mixed selection selection',
  'inline code':
    'formatted gap input-062: toolbar states match live inline code selection',
  link: 'formatted gap input-063: toolbar states match live link selection',
  'first list item':
    'formatted gap input-064: toolbar states match live first list item selection',
  'second list item':
    'formatted gap input-065: toolbar states match live second list item selection',
  'nested list item':
    'formatted gap input-066: toolbar states match live nested list item selection',
  'numbered list':
    'formatted gap input-067: toolbar states match live numbered list selection',
  checklist:
    'formatted gap input-068: toolbar states match live checklist selection',
  quote: 'formatted gap input-069: toolbar states match live quote selection',
  'code block':
    'formatted gap input-070: toolbar states match live code block selection',
  'table cell':
    'formatted gap input-071: toolbar states match live table cell selection',
  'whole document':
    'formatted gap input-072: toolbar states match live whole document selection',
}

async function selectNativeInputTable(t, page, rich, what, oracle) {
  // The shipped table widget owns a real cell editor. Let its normal selection bridge focus it.
  await rich.evaluate(
    (element, head) =>
      element.cmTile.root.view.dispatch({
        selection: { anchor: head },
        scrollIntoView: true,
      }),
    what === 'cell' ? oracle.from : oracle.to,
  )
  await page.getByRole('textbox', { name: 'Table cell', exact: true }).waitFor()
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute('aria-label') === 'Table cell' &&
      document.activeElement.isContentEditable,
  )
  if (what === 'cell') return

  // Native browser selection crosses the rendered cells, or the paragraph and active cell.
  // Do not replace it with a raw Markdown splice when this selection is unsupported.
  const rendered = await rich.evaluate((element, what) => {
    const cell = element.querySelector('.hibi-lp-cell-editor .cm-content')
    const find = (root, word, inCell) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        const node = walker.currentNode
        if (
          node.data.trim() === word &&
          Boolean(node.parentElement.closest('td, th')) === inCell
        )
          return { node, offset: node.data.indexOf(word) }
      }
      return null
    }
    const anchor = find(
      element,
      what === 'cells' ? 'a' : 'ab',
      what === 'cells',
    )
    const head = cell && find(cell, what === 'cells' ? 'd' : 'cd', true)
    if (!anchor || !head) return false
    getSelection().setBaseAndExtent(
      anchor.node,
      anchor.offset + (what === 'cells' ? 0 : 1),
      head.node,
      head.offset + 1,
    )
    return true
  }, what)
  await t.test(
    'native table selection retains both historical source endpoints',
    { todo: multilineInputGaps[what]?.selection },
    async () => {
      assert.equal(
        rendered,
        true,
        'rendered paragraph/cell endpoints must exist',
      )
      const expected = {
        from: oracle.from,
        to: oracle.to,
        text: what === 'cells' ? 'abcd' : 'bc',
        anchorInCell: what === 'cells',
        focusInCell: true,
      }
      const snapshot = (element) => {
        const { from, to } = element.cmTile.root.view.state.selection.main
        const selection = getSelection()
        const inCell = (node) =>
          !!(
            node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement
          )?.closest('td, th')
        return {
          from,
          to,
          text: selection?.toString().replace(/\s/g, '') ?? '',
          anchorInCell: inCell(selection?.anchorNode),
          focusInCell: inCell(selection?.focusNode),
        }
      }
      try {
        await page.waitForFunction((expected) => {
          const element = document.querySelector(
            '.rich-pane [aria-label="Document editor"]',
          )
          const { from, to } = element.cmTile.root.view.state.selection.main
          return (
            from === expected.from &&
            to === expected.to &&
            getSelection()?.toString().replace(/\s/g, '') === expected.text
          )
        }, expected)
      } catch {
        assert.deepEqual(await rich.evaluate(snapshot), expected)
      }
      assert.deepEqual(await rich.evaluate(snapshot), expected)
    },
  )
}

test('the CM multiline corpus retains all thirty historical fixture names', () => {
  assert.equal(multilineInputCases.length, 30)
  assert.equal(new Set(multilineInputCases.map(([name]) => name)).size, 30)
})

for (const [what, , text, select] of multilineInputCases) {
  test('codemirror: native multiline ' +
    what +
    ' retains the historical user outcome and one-edit history', {
    timeout: 60000,
  }, async (t) => {
    // PM schema/step equality stays in the original test; this frozen record contains only its user outcome.
    const oracle = inputFixture('multiline', what)
    const tableInput = ['cell', 'cells', 'into a table'].includes(what)
    const { app, page, rich } = await launchInputFixture(t, oracle.source)
    const { from, to } = oracle
    await rich.focus()
    if (tableInput) await selectNativeInputTable(t, page, rich, what, oracle)
    else if (select === 'all') await rich.press('ControlOrMeta+a')
    else
      await rich.evaluate(
        (element, { from, to }) =>
          element.cmTile.root.view.dispatch({
            selection: { anchor: from, head: to },
            scrollIntoView: true,
          }),
        { from, to },
      )
    if (select === 'bold') {
      await page
        .locator('.editor-toolbar [data-toolbar-id="format.bold"]')
        .click()
      await rich.focus()
    }
    const before = await acceptedInput(page)
    await inputWorkProbe(rich)
    const inputOwner = await page.evaluate(() =>
      document.activeElement?.getAttribute('aria-label'),
    )
    await page.keyboard.insertText(text)
    const actual = await acceptedInput(page)
    const work = await page.evaluate(() => window.cmInputWork)
    const normalized = text.replace(/\r\n?|\n/g, '\n')
    const expected = oracle.result.markdown
    await t.test(
      'formatted structure and marks preserve the historical browser outcome',
      { todo: multilineInputGaps[what]?.structure },
      () => {
        assert.deepEqual(inputOutcome(actual.markdown), inputOutcome(expected))
      },
    )
    if (tableInput) {
      await t.test(
        'native table input preserves the historical rendered cells',
        { todo: multilineInputGaps[what]?.cells },
        async () => {
          const expectedCells = {
            cell: [
              ['', ''],
              ['aone\n\ntwo', 'b'],
              ['c', 'd'],
            ],
            cells: [
              ['', ''],
              ['a', 'b'],
              ['c', 'one\ntwo'],
            ],
            'into a table': [[''], ['d']],
          }[what]
          const cells = await rich.evaluate((element) =>
            [...(element.querySelector('table')?.rows ?? [])]
              .filter((row) => row.getAttribute('aria-hidden') !== 'true')
              .map((row) =>
                [...row.cells].map((cell) => {
                  const visible = cell.firstElementChild.cloneNode(true)
                  for (const br of visible.querySelectorAll('br'))
                    br.replaceWith('\n')
                  for (const marker of visible.querySelectorAll(
                    '.hibi-lp-marker, .cm-placeholder, .cm-widgetBuffer, [aria-hidden="true"]',
                  ))
                    marker.remove()
                  return visible.textContent.replace(/\n+$/, '')
                }),
              ),
          )
          assert.deepEqual(cells, expectedCells)
        },
      )
    }
    await t.test(
      'accepted canonical source equals the native document',
      async () => {
        assert.equal(actual.tabId, before.tabId)
        assert.equal(
          actual.markdown,
          await rich.evaluate((element) =>
            element.cmTile.root.view.state.doc.toString(),
          ),
        )
      },
    )
    await t.test(
      'one beforeinput receipt identifies its native editing owner',
      () => {
        assert.ok(['Document editor', 'Table cell'].includes(inputOwner))
        assert.deepEqual(work.beforeinput, [
          { owner: inputOwner, type: 'insertText', data: text },
        ])
      },
    )
    // The nested cell owns native input; only the main editor uses SourceEditor's newline interception.
    if (inputOwner === 'Document editor')
      await t.test(
        'the main editor retains its native cancellation contract',
        () => {
          assert.deepEqual(work.prevented, [/[\r\n]/.test(text)])
        },
      )
    await t.test(
      'one native input signal retains the inserted text',
      { todo: multilineInputGaps[what]?.input },
      () => {
        assert.deepEqual(work.inputs, [{ type: 'insertText', data: text }])
      },
    )
    await t.test(
      'one accepted source edit advances the content version once',
      { todo: multilineInputGaps[what]?.version },
      () => {
        assert.equal(work.changes, 1)
        assert.equal(actual.contentVersion, before.contentVersion + 1)
      },
    )
    await t.test(
      'the native caret follows the inserted text and keeps its tail',
      { todo: multilineInputGaps[what]?.caret },
      async () => {
        const caret = await cmCaretText(rich)
        assert.ok(caret)
        assert.equal(caret[1], oracle.result.caret[1])
        const last = normalized.split('\n').at(-1)
        assert.ok(
          what === 'code'
            ? caret[0].endsWith(last)
            : caret[0] === oracle.result.caret[0],
          JSON.stringify(caret),
        )
      },
    )
    await t.test(
      'native undo and redo restore the accepted source exactly',
      async () => {
        await pressShortcut(
          app,
          process.platform === 'darwin' ? 'Meta+z' : 'Control+z',
        )
        assert.equal((await acceptedInput(page)).markdown, before.markdown)
        await pressShortcut(
          app,
          process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y',
        )
        assert.equal((await acceptedInput(page)).markdown, actual.markdown)
      },
    )
  })
}

test('codemirror: native multiline input at the only empty list item retains the following paragraph', {
  timeout: 60000,
}, async (t) => {
  const oracle = inputFixture('special', 'empty-list-exit')
  const { app, page, rich } = await launchInputFixture(t, oracle.source)
  await rich.focus()
  await rich.evaluate(
    (element, from) =>
      element.cmTile.root.view.dispatch({ selection: { anchor: from } }),
    oracle.from,
  )
  await page.keyboard.insertText('\nb')
  const actual = await acceptedInput(page)
  await t.test(
    'native input exits the empty list',
    {
      todo: 'formatted gap input-051: native multiline input exits empty list and preserves following paragraph',
    },
    () => {
      assert.equal(actual.markdown, 'b\n\nz')
    },
  )
  await t.test('the native caret follows the inserted text', async () => {
    assert.deepEqual(await cmCaretText(rich), ['b', ''])
  })
  await t.test('native undo restores the original source', async () => {
    await pressShortcut(
      app,
      process.platform === 'darwin' ? 'Meta+z' : 'Control+z',
    )
    assert.equal((await acceptedInput(page)).markdown, oracle.source)
  })
})

for (const hiddenSource of [false, true]) {
  test('codemirror: native typing defers and coalesces toolbar inspections' +
    (hiddenSource ? ' after a source visit' : ''), {
    timeout: 60000,
  }, async (t) => {
    const { app, page, rich } = await launchInputFixture(
      t,
      '',
      'codemirror',
      true,
    )
    await page.waitForFunction(() => Array.isArray(window.countedFormatChecks))
    if (hiddenSource) {
      await page
        .getByRole('button', { name: 'Source view', exact: true })
        .click()
      await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
      await page.getByRole('button', { name: 'normal', exact: true }).click()
      await waitForDocumentEditor(app, page)
    }
    await rich.focus()
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    )
    await inputWorkProbe(rich)
    const expectedChecks = await page.evaluate((hiddenSource) => {
      window.countedFormatChecks = []
      window.hiddenInputUpdates = 0
      // Each toolbar refresh inspects every action in one task. A refresh
      // after an update that changes no text, such as completion results that
      // arrive once typing pauses, is that update's, not the typing's.
      window.formatRounds = []
      let round = null,
        other = false
      const checks = window.countedFormatChecks
      checks.push = (...ids) => {
        if (!round) {
          round = { ids: [], other }
          other = false
          window.formatRounds.push(round)
          queueMicrotask(() => {
            round = null
          })
        }
        round.ids.push(...ids)
        return Array.prototype.push.apply(checks, ids)
      }
      for (const content of document.querySelectorAll('.cm-content')) {
        const view = content.cmTile.root.view
        const update = view.update.bind(view)
        view.update = (transactions) => {
          if (transactions.every((transaction) => !transaction.docChanged))
            other = true
          return update(transactions)
        }
      }
      if (hiddenSource) {
        const view = document.querySelector('.source-pane .cm-content').cmTile
          .root.view
        const update = view.update.bind(view)
        view.update = (transactions) => {
          if (transactions.some((transaction) => transaction.docChanged))
            window.hiddenInputUpdates++
          return update(transactions)
        }
      }
      const frames = new Map()
      let next = 0
      const request = window.requestAnimationFrame.bind(window)
      const cancel = window.cancelAnimationFrame.bind(window)
      const now = Date.now,
        typingTime = now()
      Date.now = () => typingTime
      window.requestAnimationFrame = (callback) => {
        frames.set(--next, callback)
        return next
      }
      window.cancelAnimationFrame = (id) =>
        id < 0 ? frames.delete(id) : cancel(id)
      window.releaseInputFrames = () => {
        Date.now = now
        window.requestAnimationFrame = request
        window.cancelAnimationFrame = cancel
        delete window.releaseInputFrames
        request((time) => {
          for (const callback of frames.values()) callback(time)
          window.firstInputFrameChecks = window.countedFormatChecks.length
        })
      }
      return [
        ...document.querySelectorAll(
          '.editor-toolbar [data-toolbar-id^="format."]',
        ),
      ].filter(
        (button) =>
          button.hasAttribute('aria-pressed') ||
          button.hasAttribute('aria-checked'),
      ).length
    }, hiddenSource)
    let immediate
    try {
      await page.keyboard.type('hello')
      const document = await acceptedInput(page)
      immediate = await page.evaluate(
        (document) => ({
          checks: window.countedFormatChecks.length,
          hidden: window.hiddenInputUpdates,
          text: document.markdown,
          changes: window.cmInputWork.changes,
        }),
        document,
      )
    } finally {
      await page.evaluate(() => window.releaseInputFrames())
    }
    await t.test(
      'native text and persistence do not wait for a formatting frame',
      () => {
        assert.deepEqual(immediate, {
          checks: 0,
          hidden: 0,
          text: 'hello',
          changes: 5,
        })
        assert.ok(expectedChecks > 0)
      },
    )
    await page.waitForFunction(() => window.countedFormatChecks.length > 0)
    await t.test(
      'one inspection per active action runs after paint',
      async () => {
        const result = await page.evaluate(() => ({
          inFrame: window.firstInputFrameChecks,
          rounds: window.formatRounds,
          hidden: window.hiddenInputUpdates,
        }))
        // API 2's counted Markdown format measures CM inspection work; PM can()/mapping counters remain above.
        assert.equal(result.inFrame, 0)
        const [typing, ...later] = result.rounds
        assert.equal(typing.ids.length, expectedChecks)
        assert.equal(new Set(typing.ids).size, expectedChecks)
        // The typing scheduled no other refresh.
        assert.ok(
          later.every((round) => round.other),
          JSON.stringify(later),
        )
        assert.equal(result.hidden, 0)
      },
    )
    await t.test('native history keeps the typing group intact', async () => {
      await pressShortcut(
        app,
        process.platform === 'darwin' ? 'Meta+z' : 'Control+z',
      )
      assert.equal((await acceptedInput(page)).markdown, '')
      await pressShortcut(
        app,
        process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y',
      )
      assert.equal((await acceptedInput(page)).markdown, 'hello')
    })
    if (hiddenSource) {
      await page
        .getByRole('button', { name: 'Source view', exact: true })
        .click()
      await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
      assert.equal(
        await page
          .locator('.source-pane .cm-content')
          .evaluate((element) => element.cmTile.root.view.state.doc.toString()),
        'hello',
      )
      assert.equal((await acceptedInput(page)).markdown, 'hello')
    }
  })
}

for (const all of [false, true]) {
  test('codemirror: multiline native work stays linear into ' +
    (all ? 'select-all' : 'an empty paragraph'), {
    timeout: 60000,
  }, async (t) => {
    const counts = []
    for (const lines of [500, 1000]) {
      const quote = String.fromCharCode(96)
      const text = Array.from(
        { length: lines },
        (_, i) => 'line **' + i + '** _' + i + '_ ' + quote + i + quote,
      ).join('\n')
      const oracle = inputFixture(
        'linear',
        (all ? 'all' : 'empty') + ':' + lines,
      )
      const fixture = await launchInputFixture(t, oracle.source)
      const { app, page, rich } = fixture
      await rich.focus()
      if (all) await rich.press('ControlOrMeta+a')
      else
        await rich.evaluate((element) =>
          element.cmTile.root.view.dispatch({ selection: { anchor: 0 } }),
        )
      const before = await acceptedInput(page)
      await inputWorkProbe(rich)
      await page.keyboard.insertText(text)
      const actual = await acceptedInput(page)
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      )
      const work = await page.evaluate(() => {
        for (const record of window.cmInputObserver.takeRecords())
          window.cmInputWork.added += record.addedNodes.length
        window.cmInputObserver.disconnect()
        return window.cmInputWork
      })
      counts.push({ lines, ...work })
      await t.test(
        lines + ' lines preserve the historical formatted source outcome',
        { todo: linearInputGaps[all ? 'all' : 'empty'][lines] },
        () => {
          const expected = Array.from(
            { length: oracle.result.lineCount },
            (_, i) => [
              ...(i === 0 && oracle.result.firstHeading
                ? ['heading', 1]
                : ['paragraph']),
              [['text', 'line **' + i + '** _' + i + '_ ' + quote + i + quote]],
            ],
          )
          // Fail at the first differing block before Node constructs a huge descendant diff.
          const outcome = inputOutcome(actual.markdown)
          assert.equal(
            outcome.length,
            expected.length,
            lines + ' formatted blocks',
          )
          for (const [i, block] of expected.entries())
            assert.deepEqual(outcome[i], block, 'formatted line ' + i)
          assert.deepEqual(inputOutcome(actual.markdown), expected)
        },
      )
      await t.test(
        lines + ' lines keep canonical source equal to the native document',
        async () => {
          assert.equal(actual.tabId, before.tabId)
          assert.equal(
            actual.markdown,
            await rich.evaluate((element) =>
              element.cmTile.root.view.state.doc.toString(),
            ),
          )
        },
      )
      await t.test(
        lines + ' lines use one input signal and one source change',
        () => {
          assert.deepEqual(work.prevented, [true])
          assert.deepEqual(work.inputs, [{ type: 'insertText', data: text }])
          assert.equal(work.changes, 1)
          assert.equal(actual.contentVersion, before.contentVersion + 1)
          assert.equal(work.inserted, actual.markdown.length)
          assert.equal(work.removed, before.markdown.length)
          assert.ok(work.added > 0, 'positive DOM-work control')
          assert.ok(work.maps > 0, 'positive position-mapping control')
          assert.ok(work.mapped > 0, 'positive mapped-range control')
        },
      )
      await t.test(
        lines + ' lines retain native one-step undo and redo',
        async () => {
          await pressShortcut(
            app,
            process.platform === 'darwin' ? 'Meta+z' : 'Control+z',
          )
          assert.equal((await acceptedInput(page)).markdown, before.markdown)
          await pressShortcut(
            app,
            process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y',
          )
          assert.equal((await acceptedInput(page)).markdown, actual.markdown)
        },
      )
      await fixture.close()
    }
    const [small, large] = counts
    assert.ok(
      large.maps <= 2 * small.maps + 8 &&
        large.mapped <= 2 * small.mapped + 8 &&
        large.added <= 2 * small.added + 8,
      JSON.stringify(
        counts.map(({ lines, maps, mapped, added }) => ({
          lines,
          maps,
          mapped,
          added,
        })),
      ),
    )
    assert.equal(large.changes, small.changes)
  })
}

test('codemirror: blank paragraphs and a typed trailing space survive tab switches and exact disk save', {
  timeout: 30000,
}, async (t) => {
  const { app, page, rich, file } = await launchInputFixture(t, '')
  await rich.focus()
  await page.keyboard.type('first')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('second')
  await page.keyboard.press('Space')
  const typed = await acceptedInput(page)
  await t.test(
    'native Enter retains the historical exact four-LF source',
    {
      todo: 'formatted gap input-056: native enter preserves four line feeds between paragraphs',
    },
    () => {
      assert.equal(typed.markdown, 'first\n\n\n\nsecond ')
      assert.doesNotMatch(typed.markdown, /&nbsp;|\u00a0/)
    },
  )
  await clickMenu(app, 'New')
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).markdown === '',
  )
  await page.getByRole('tab', { name: 'input.md', exact: true }).click()
  await waitForAsync(
    page,
    async (id) => (await window.hibi.getDocument()).tabId === id,
    typed.tabId,
  )
  const restored = await acceptedInput(page)
  assert.equal(restored.tabId, typed.tabId)
  assert.equal(restored.markdown, typed.markdown)
  assert.doesNotMatch(restored.markdown, /&nbsp;|\u00a0/)
  await clickMenu(app, 'Save')
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  assert.equal(await readFile(file, 'utf8'), typed.markdown)
})

for (const spaces of [1, 2]) {
  test('codemirror: typing a letter after ' +
    spaces +
    ' trailing spaces keeps regular spaces and native undo', {
    timeout: 30000,
  }, async (t) => {
    const { app, page, rich } = await launchInputFixture(t, '')
    const warnings = []
    page.on('console', (message) => {
      if (/white-space/.test(message.text())) warnings.push(message.text())
    })
    await rich.focus()
    await page.keyboard.type('hi')
    for (let i = 0; i < spaces; i++) await page.keyboard.press('Space')
    await page.keyboard.type('x')
    const expected = 'hi' + ' '.repeat(spaces) + 'x'
    assert.equal((await acceptedInput(page)).markdown, expected)
    assert.doesNotMatch((await acceptedInput(page)).markdown, /&nbsp;|\u00a0/)
    assert.equal(await rich.textContent(), expected)
    // CM uses break-spaces; preserve the historical visible-space contract independently of CSS spelling.
    const width = await rich.evaluate((element, spaces) => {
      const view = element.cmTile.root.view
      const start = view.coordsAtPos(2).left
      return {
        single: view.coordsAtPos(3).left - start,
        total: view.coordsAtPos(2 + spaces).left - start,
      }
    }, spaces)
    assert.ok(width.single > 0)
    assert.ok(
      Math.abs(width.total - spaces * width.single) < 1,
      JSON.stringify(width),
    )
    assert.deepEqual(warnings, [])
    await pressShortcut(
      app,
      process.platform === 'darwin' ? 'Meta+z' : 'Control+z',
    )
    assert.equal((await acceptedInput(page)).markdown, '')
  })
}

test('codemirror: the original 200–256 KiB HTML/reference note stays natively editable through history, source, save and reload', {
  timeout: 60000,
}, async (t) => {
  const original = [
    '# Editable document',
    '<div>HTML content</div>',
    '[reference][target]\n\n[target]: https://example.com',
    ...Array(40).fill('alpha beta '.repeat(500)),
  ].join('\n\n')
  assert.ok(original.length > 200000)
  assert.ok(original.length <= 256 * 1024)
  const { app, page, rich, file } = await launchInputFixture(t, original)
  assert.equal((await acceptedInput(page)).markdown, original)
  assert.equal(await rich.getAttribute('contenteditable'), 'true')
  await rich.focus()
  await rich.evaluate((element) =>
    element.cmTile.root.view.dispatch({
      selection: { anchor: 2 },
      scrollIntoView: true,
    }),
  )
  assert.equal(
    await rich.evaluate((element) => element === document.activeElement),
    true,
  )
  await page.keyboard.insertText('edited ')
  const edited = original.replace(
    '# Editable document',
    '# edited Editable document',
  )
  assert.equal((await acceptedInput(page)).markdown, edited)
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+z' : 'Control+z',
  )
  assert.equal((await acceptedInput(page)).markdown, original)
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y',
  )
  assert.equal((await acceptedInput(page)).markdown, edited)
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  await page.getByRole('button', { name: 'normal', exact: true }).click()
  await waitForDocumentEditor(app, page)
  await clickMenu(app, 'Save')
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  assert.equal(await readFile(file, 'utf8'), edited)
  await page.reload()
  await waitForDocumentEditor(app, page)
  assert.equal((await acceptedInput(page)).markdown, edited)
})

const toolbarSnapshot = (page) =>
  page.evaluate(() =>
    Object.fromEntries(
      [
        ...document.querySelectorAll(
          '.editor-toolbar [data-toolbar-id^="format."]',
        ),
      ].map((button) => [
        button.dataset.toolbarId.slice('format.'.length),
        {
          pressed:
            button.getAttribute('aria-pressed') ??
            button.getAttribute('aria-checked'),
          disabled: button.disabled,
        },
      ]),
    ),
  )

async function settledInputToolbar(page, id, expected) {
  try {
    await page.waitForFunction(
      ({ id, expected }) => {
        const button = document.querySelector(
          '.editor-toolbar [data-toolbar-id="format.' + id + '"]',
        )
        return (
          button &&
          Object.entries(expected).every(
            ([key, value]) =>
              (key === 'disabled'
                ? button.disabled
                : (button.getAttribute('aria-pressed') ??
                  button.getAttribute('aria-checked'))) === value,
          )
        )
      },
      { id, expected },
    )
  } catch {
    const actual = (await toolbarSnapshot(page))[id]
    for (const [key, value] of Object.entries(expected))
      assert.equal(actual?.[key], value, id + '.' + key)
  }
}

async function captureTiptapToolbarRange(page, text, offset = 1, length = 0) {
  return page
    .getByRole('textbox', { name: 'Document editor', exact: true })
    .evaluate(
      (element, { text, offset, length }) => {
        const editor = element.editor
        if (text === null) editor.commands.selectAll()
        else {
          let from = null
          editor.state.doc.descendants((node, position) => {
            if (from === null && node.isText && node.text.includes(text))
              from = position + node.text.indexOf(text) + offset
            return from === null
          })
          editor.commands.setTextSelection({ from, to: from + length })
        }
        const expected = window.__toolbarStates().expected
        const source = editor.getMarkdown()
        if (text === null)
          return { source, from: 0, to: source.length, expected }
        if (text === 'cell') {
          // Preserve the table's original padding; sentinel serialization widens its header.
          const from = source.indexOf(text) + offset
          return {
            source,
            from,
            to: from + length,
            expected,
            selectionText: '',
          }
        }
        const { from, to } = editor.state.selection
        const startMarks =
          editor.state.doc.resolve(from).nodeAfter?.marks ??
          editor.state.doc.resolve(from).marks()
        const endMarks =
          editor.state.doc.resolve(to).nodeBefore?.marks ??
          editor.state.doc.resolve(to).marks()
        const transaction = editor.state.tr
        if (from === to)
          transaction.insert(
            from,
            editor.schema.text('HIBISTATECARET871', startMarks),
          )
        else {
          transaction.insert(
            to,
            editor.schema.text('HIBISTATEEND871', endMarks),
          )
          transaction.insert(
            from,
            editor.schema.text('HIBISTATESTART871', startMarks),
          )
        }
        const marked = editor.markdown.serialize(transaction.doc.toJSON())
        const first = from === to ? 'HIBISTATECARET871' : 'HIBISTATESTART871'
        const plain = marked.replace(first, '').replace('HIBISTATEEND871', '')
        let rawFrom = marked.indexOf(first)
        let rawTo =
          from === to
            ? rawFrom
            : marked.indexOf('HIBISTATEEND871') - first.length
        if (plain !== source) {
          let prefix = 0,
            suffix = 0
          while (
            prefix < plain.length &&
            prefix < source.length &&
            plain[prefix] === source[prefix]
          )
            prefix++
          while (
            suffix < plain.length - prefix &&
            suffix < source.length - prefix &&
            plain.at(-1 - suffix) === source.at(-1 - suffix)
          )
            suffix++
          const map = (value) =>
            value <= prefix
              ? value
              : value >= plain.length - suffix
                ? source.length - (plain.length - value)
                : prefix
          rawFrom = map(rawFrom)
          rawTo = map(rawTo)
        }
        return {
          source,
          from: rawFrom,
          to: rawTo,
          expected,
          markerlessSource: plain,
          selectionText: editor.state.doc.textBetween(from, to, '\n'),
        }
      },
      { text, offset, length },
    )
}

test('the toolbar corpus retains all fifteen historical selections plus select-all', () => {
  assert.equal(toolbarSelectionCases.length, 15)
  assert.equal(new Set(toolbarSelectionCases.map(([name]) => name)).size, 15)
})

for (const [label] of [...toolbarSelectionCases, ['whole document', null]]) {
  test('codemirror: all historical toolbar action states at ' +
    label +
    ' match frozen user-outcome fixtures', {
    timeout: 60000,
  }, async (t) => {
    const oracle = inputFixture('toolbar', label)
    assert.equal(
      Object.keys(oracle.expected).length,
      label === 'table cell' ? 35 : 28,
    )
    const { page, rich } = await launchInputFixture(t, oracle.source)
    const before = await acceptedInput(page)
    await rich.focus()
    await rich.evaluate(
      (element, { from, to }) =>
        element.cmTile.root.view.dispatch({
          selection: { anchor: from, head: to },
          scrollIntoView: true,
        }),
      oracle,
    )
    await t.test(
      'all historical toolbar states settle from the selected range',
      { todo: toolbarInputGaps[label] },
      async () => {
        try {
          await page.waitForFunction((expected) => {
            const actual = Object.fromEntries(
              [
                ...document.querySelectorAll(
                  '.editor-toolbar [data-toolbar-id^="format."]',
                ),
              ].map((button) => [
                button.dataset.toolbarId.slice('format.'.length),
                {
                  pressed:
                    button.getAttribute('aria-pressed') ??
                    button.getAttribute('aria-checked'),
                  disabled: button.disabled,
                },
              ]),
            )
            return (
              Object.keys(actual).length === Object.keys(expected).length &&
              Object.entries(expected).every(
                ([id, state]) =>
                  actual[id]?.pressed === state.pressed &&
                  actual[id]?.disabled === state.disabled,
              )
            )
          }, oracle.expected)
        } catch {
          assert.deepEqual(await toolbarSnapshot(page), oracle.expected, label)
        }
        assert.deepEqual(await toolbarSnapshot(page), oracle.expected, label)
      },
    )
    await t.test(
      'selection and state inspections leave canonical source intact',
      async () => {
        const actual = await acceptedInput(page)
        assert.equal(actual.markdown, oracle.source)
        assert.equal(actual.tabId, before.tabId)
        assert.equal(actual.contentVersion, before.contentVersion)
        assert.equal(
          actual.markdown,
          await rich.evaluate((element) =>
            element.cmTile.root.view.state.doc.toString(),
          ),
        )
      },
    )
  })
}

test('codemirror: stored bold state follows native typing, undo and redo', {
  timeout: 45000,
}, async (t) => {
  const { app, page, rich } = await launchInputFixture(t, 'plain end')
  await rich.focus()
  await rich.press(
    process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End',
  )
  const bold = page.locator('.editor-toolbar [data-toolbar-id="format.bold"]')
  await bold.click()
  await t.test('a pending native bold action has a pressed state', async () => {
    await page.waitForFunction(
      () =>
        document
          .querySelector('.editor-toolbar [data-toolbar-id="format.bold"]')
          ?.getAttribute('aria-pressed') === 'true',
    )
    assert.equal(await bold.getAttribute('aria-pressed'), 'true')
  })
  await rich.focus()
  await page.keyboard.type(' typed')
  const typed = await acceptedInput(page)
  await t.test(
    'native typing retains bold pressed state',
    {
      todo: 'formatted gap input-073: native bold typing keeps bold action pressed',
    },
    async () => {
      await settledInputToolbar(page, 'bold', { pressed: 'true' })
      assert.equal(await bold.getAttribute('aria-pressed'), 'true')
    },
  )
  await t.test('native typing enables undo', async () => {
    await settledInputToolbar(page, 'undo', { disabled: false })
    assert.equal((await toolbarSnapshot(page)).undo.disabled, false)
  })
  await t.test(
    'native typing preserves bold in canonical source',
    {
      todo: 'formatted gap input-074: native bold typing renders strong text in canonical source',
    },
    () => {
      assert.equal(
        marked.parseInline(typed.markdown),
        'plain end <strong>typed</strong>',
      )
    },
  )
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+z' : 'Control+z',
  )
  await t.test('native undo enables redo', async () => {
    await settledInputToolbar(page, 'redo', { disabled: false })
    assert.equal((await toolbarSnapshot(page)).redo.disabled, false)
  })
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y',
  )
  await t.test(
    'native redo restores text and consumes its history entry',
    async () => {
      await settledInputToolbar(page, 'redo', { disabled: true })
      assert.equal((await acceptedInput(page)).markdown, typed.markdown)
      assert.equal((await toolbarSnapshot(page)).redo.disabled, true)
    },
  )
})

test('codemirror: a toolbar click before refresh formats the newly selected live source range', {
  timeout: 45000,
}, async (t) => {
  const source = 'plain **bold** *italic* end'
  const { page, rich } = await launchInputFixture(t, source)
  await rich.focus()
  await rich.evaluate((element) =>
    element.cmTile.root.view.dispatch({ selection: { anchor: 1 } }),
  )
  await page.waitForFunction(
    () =>
      document
        .querySelector('.editor-toolbar [data-toolbar-id="format.bold"]')
        ?.getAttribute('aria-pressed') === 'false',
  )
  const shown = await rich.evaluate((element) => {
    const view = element.cmTile.root.view
    const from = view.state.doc.toString().indexOf('bold')
    view.dispatch({ selection: { anchor: from, head: from + 4 } })
    const button = document.querySelector(
      '.editor-toolbar [data-toolbar-id="format.bold"]',
    )
    const pressed = button.getAttribute('aria-pressed')
    button.click()
    return pressed
  })
  assert.equal(shown, 'false')
  await waitForAsync(
    page,
    async () =>
      (await window.hibi.getDocument()).markdown === 'plain bold *italic* end',
  )
  assert.equal((await acceptedInput(page)).markdown, 'plain bold *italic* end')
  await page.waitForFunction(
    () =>
      document
        .querySelector('.editor-toolbar [data-toolbar-id="format.bold"]')
        ?.getAttribute('aria-pressed') === 'false',
  )
  assert.equal((await toolbarSnapshot(page)).bold.pressed, 'false')
})
