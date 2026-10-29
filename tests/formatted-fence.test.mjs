import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { TreeFragment } from '@lezer/common'
import { GFM, parser } from '@lezer/markdown'
import { Marked } from 'marked'
import {
  fenceBodyChanges,
  fencedView,
  fenceWork,
  markedFenceText,
  RenderedBlocks,
  readFence,
} from '../src/addons/_shared/formatted-fence.ts'
import { typstBlock, typstTokens } from '../src/addons/typst/syntax.ts'
import { ChunkedMarkdownParser } from '../src/renderer/src/chunked-markdown.ts'
import { blockMarkdown } from '../src/shared/marked-blocks.ts'

const markdown = parser.configure(GFM)

/** Closed fences of `language`, with the body each view reads. */
function fences(source, language, text) {
  const doc = EditorState.create({ doc: source }).doc
  const found = []
  markdown.parse(source).iterate({
    enter(node) {
      if (node.name !== 'FencedCode') return
      const fence = readFence(doc, node.node)
      if (fence && fence.info.trim().toLowerCase() === language)
        found.push({ from: node.from, to: node.to, text: text(fence) })
      return false
    },
  })
  return found
}

/** The rich view's mermaid diagrams: Marked code tokens of that language. */
function markedDiagrams(source) {
  const marked = new Marked(blockMarkdown)
  const found = []
  marked.walkTokens(marked.lexer(source), (token) => {
    if (token.type === 'code' && token.lang?.toLowerCase() === 'mermaid')
      found.push(token.text)
  })
  return found
}

/** The rich view's Typst blocks: closed native code tokens of that language. */
function markedTypst(source) {
  const marked = new Marked(blockMarkdown, typstTokens)
  const found = []
  marked.walkTokens(marked.lexer(source), (token) => {
    if (token.type === 'code' && typstBlock(token.raw)) found.push(token.text)
  })
  return found
}

const bodies = [
  'graph TD\n  A-->B',
  '',
  '\nleading blank',
  'trailing blank\n',
  'a\n\nb',
  '  indented\n    more',
  'x ` y',
]
const wrappers = [
  (lang, body) => `\`\`\`${lang}\n${body}\n\`\`\``,
  (lang, body) => `~~~${lang}\n${body}\n~~~`,
  (lang, body) =>
    ` \`\`\`${lang}\n${body
      .split('\n')
      .map((line) => (line ? ` ${line}` : line))
      .join('\n')}\n \`\`\``,
  (lang, body) =>
    `   \`\`\`${lang}\n${body
      .split('\n')
      .map((line) => (line ? `  ${line}` : line))
      .join('\n')}\n   \`\`\``,
  (lang, body) =>
    `  ~~~${lang}\n${body
      .split('\n')
      .map((line) => (line ? `  ${line}` : line))
      .join('\n')}\n  ~~~`,
  (lang, body) =>
    `> \`\`\`${lang}\n${body
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')}\n> \`\`\``,
  (lang, body) =>
    `- item\n\n  \`\`\`${lang}\n${body
      .split('\n')
      .map((line) => (line ? `  ${line}` : line))
      .join('\n')}\n  \`\`\``,
  (lang, body) =>
    `- \`\`\`${lang}\n${body
      .split('\n')
      .map((line) => (line ? `  ${line}` : line))
      .join('\n')}\n  \`\`\``,
  (lang, body) =>
    `> - \`\`\`${lang}\n${body
      .split('\n')
      .map((line) => `>   ${line}`)
      .join('\n')}\n>   \`\`\``,
]

test('formatted fences read diagram and typst bodies as the rich view does', () => {
  for (const wrap of wrappers)
    for (const body of bodies)
      for (const ending of ['', '\n\nafter']) {
        const diagram = `intro\n\n${wrap('mermaid', body)}${ending}`
        assert.deepEqual(
          fences(diagram, 'mermaid', markedFenceText).map(({ text }) => text),
          markedDiagrams(diagram),
          JSON.stringify(diagram),
        )
        const typst = `intro\n\n${wrap('typst', body)}${ending}`
        assert.deepEqual(
          fences(typst, 'typst', markedFenceText).map(({ text }) => text),
          markedTypst(typst),
          JSON.stringify(typst),
        )
      }
  // Unclosed fences stay code blocks in both views.
  assert.deepEqual(
    fences('```mermaid\ngraph TD', 'mermaid', markedFenceText),
    [],
  )
  assert.deepEqual(markedTypst('```typst\n$ x $'), [])
})

test('editing a fence writes its body as one change and keeps the fence around it', () => {
  const sources = [
    'graph LR\n  X-->Y',
    '',
    'one',
    'a\n\nb',
    'has\n```\nfence',
    'has\n````\nlonger fence',
    '~~~\ntilde',
  ]
  for (const [language, read, indented] of [
    ['mermaid', markedDiagrams, () => true],
    ['typst', markedTypst, () => true],
  ])
    for (const wrap of wrappers)
      for (const source of sources) {
        const before = `intro\n\n${wrap(language, 'old\nbody')}\n\nafter`
        const doc = EditorState.create({ doc: before }).doc
        let node
        markdown.parse(before).iterate({
          enter(ref) {
            if (ref.name === 'FencedCode') node ??= ref.node
          },
        })
        const fence = readFence(doc, node)
        const text = EditorState.create({ doc: before })
          .update({
            changes: fenceBodyChanges(doc, node, source, {
              indent: fence.indent,
              indented: indented(fence),
            }),
          })
          .state.doc.toString()
        // Both the rich view's reading and the formatted view's read the new source.
        assert.deepEqual(read(text), [source], JSON.stringify({ before, text }))
        assert.deepEqual(
          fences(text, language, markedFenceText).map(({ text }) => text),
          [source],
          JSON.stringify({ before, text }),
        )
        assert.ok(text.startsWith('intro\n\n') && text.endsWith('\n\nafter'))
      }
})

test('fences after tabs, in quotes indented differently and after lazy lines keep every character through an edit', () => {
  for (const block of [
    '-\t```mermaid\n\tgraph TD\n\t  A-->B\n\t```',
    '1.\t```mermaid\n\tgraph TD\n\t  A-->B\n\t```',
    '- a\n\t```mermaid\n\tgraph TD\n\t  A-->B\n\t```',
    '   > - ```mermaid\n>   graph TD\n>     A-->B\n>   ```',
    '> - ```mermaid\n   >   graph TD\n   >     A-->B\n   >   ```',
    '- item\nlazy line\n  ```mermaid\n  graph TD\n    A-->B\n  ```',
    '> intro\nlazy line\n> ```mermaid\n> graph TD\n>   A-->B\n> ```',
  ]) {
    const before = `intro\n\n${block}\n\nafter\n`
    // The formatted view reads what the rich view reads.
    assert.deepEqual(markedDiagrams(before), ['graph TD\n  A-->B'], block)
    const [found] = fences(before, 'mermaid', markedFenceText)
    assert.equal(found?.text, 'graph TD\n  A-->B', block)
    // Applying the dialog with a line added keeps the others and undoes exactly.
    const state = EditorState.create({ doc: before })
    let node
    markdown.parse(before).iterate({
      enter(ref) {
        if (ref.name === 'FencedCode') node ??= ref.node
      },
    })
    const fence = readFence(state.doc, node)
    const source = 'graph TD\n  A-->B\n  B-->C'
    const edited = state.update({
      changes: fenceBodyChanges(state.doc, node, source, {
        indent: fence.indent,
        indented: true,
      }),
    })
    const text = edited.state.doc.toString()
    assert.deepEqual(markedDiagrams(text), [source], text)
    assert.deepEqual(
      fences(text, 'mermaid', markedFenceText).map(({ text }) => text),
      [source],
      text,
    )
    assert.equal(
      edited.changes.invert(state.doc).apply(edited.state.doc).toString(),
      before,
    )
  }
})

test('a fence longer than the giant block size reads and edits its whole body', () => {
  // The formatted view's parser gives such a block inner nodes only near the viewport.
  const body = Array.from(
    { length: 3500 },
    (_, index) => `  %% preserve line ${index} ${'x'.repeat(16)}`,
  )
  // At the top level, and inside list items and quotes whose prefixes each line repeats.
  for (const [open, prefix] of [
    ['', ''],
    ['- ', '  '],
    ['> ', '> '],
    ['1. ', '   '],
    ['> - ', '>   '],
  ]) {
    const block = ['```mermaid', 'graph TD', ...body, '```']
      .map((line, index) => (index ? prefix : open) + line)
      .join('\n')
    const source = `Intro.\n\n${block}\n\nvisible text at end\n`
    assert.ok(source.length > 64 * 1024)
    const chunked = new ChunkedMarkdownParser(markdown, markdown)
    const input = {
      length: source.length,
      chunk: (from) => source.slice(from),
      read: (from, to) => source.slice(from, to),
      lineChunks: false,
    }
    const run = (demand, fragments = []) => {
      const parse = chunked.startChunkedParse(input, fragments, demand)
      for (;;) {
        const tree = parse.advance()
        if (tree) return tree
      }
    }
    // Visiting the end finds where the fence closes; back at the top of a
    // top-level fence, only the opening lines, a window there and the closing
    // line have inner nodes.
    let tree = run({ from: source.length - 2000, to: source.length })
    if (!open) tree = run({ from: 0, to: 2000 }, TreeFragment.addTree(tree))
    let node
    tree.iterate({
      enter(ref) {
        if (ref.name === 'FencedCode') node ??= ref.node
      },
    })
    const texts = node.getChildren('CodeText').length
    assert.ok(texts < 3500, `${texts} code texts: the tree is sparse`)
    const doc = EditorState.create({ doc: source }).doc
    const fence = readFence(doc, node)
    assert.equal(markedFenceText(fence), `graph TD\n${body.join('\n')}`)
    // Appending a line through the edit changes nothing else, and undo restores the bytes.
    const state = EditorState.create({ doc: source })
    const changes = fenceBodyChanges(
      doc,
      node,
      `${markedFenceText(fence)}\n%% added`,
      { indent: fence.indent, indented: true },
    )
    const edited = state.update({ changes })
    assert.equal(
      edited.state.doc.toString(),
      source.replace(
        `\n${prefix}\`\`\`\n\nvisible`,
        `\n${prefix}%% added\n${prefix}\`\`\`\n\nvisible`,
      ),
    )
    assert.equal(
      edited.changes.invert(state.doc).apply(edited.state.doc).toString(),
      source,
    )
  }
})

test('fences of other languages are not read', () => {
  const lines = Array.from(
    { length: 50000 },
    (_, index) => `let v${index} = ${index}`,
  )
  const source = `\`\`\`javascript\n${lines.join('\n')}\n\`\`\`\n`
  const state = EditorState.create({ doc: source })
  const view = fencedView({
    id: 'mermaid',
    className: 'mermaid-block',
    matches: (info) => info.toLowerCase() === 'mermaid',
    source: markedFenceText,
    indented: () => true,
    mount: () => ({ update() {}, dispose() {} }),
    settled: () => true,
    ask: async () => null,
    blocks: new RenderedBlocks(1),
  })
  let node
  markdown.parse(source).iterate({
    enter(ref) {
      if (ref.name === 'FencedCode') node ??= ref
    },
  })
  const sink = {
    replace() {
      throw new Error('replaced an unmatched fence')
    },
    widget() {
      throw new Error('rendered an unmatched fence')
    },
    syntax() {},
    mark() {},
    line() {},
  }
  fenceWork.lines = 0
  for (const revealed of [false, true]) {
    assert.equal(
      view.layout(node, sink, { state, revealed, visible: null }),
      undefined,
    )
    view.decorate(node, sink, {
      state,
      revealed,
      visible: { from: 0, to: 100 },
    })
  }
  assert.equal(fenceWork.lines, 0)
})

test('an edit dialog follows a cached fence when its source visibility changes', async () => {
  for (const [revealed, changed] of [
    [false, false],
    [true, false],
    [false, true],
  ]) {
    const source = '```typst\nold\n```\n\ntail'
    let state = EditorState.create({ doc: source })
    const node = markdown.parse(source).topNode.firstChild
    let answer
    const renderer = fencedView({
      id: 'typst',
      className: 'typst-block',
      matches: (info) => info === 'typst',
      source: markedFenceText,
      indented: ({ marker }) => marker.startsWith('`'),
      mount: () => ({ update() {}, dispose() {} }),
      settled: () => true,
      ask: () =>
        new Promise((resolve) => {
          answer = resolve
        }),
      blocks: new RenderedBlocks(1),
    })
    const widget = (shown) => {
      let result
      renderer.layout(
        { node, from: node.from, to: node.to },
        {
          replace: (_from, _to, value) => {
            result = value
          },
          widget: (_at, value) => {
            result = value
          },
        },
        { state, revealed: shown },
      )
      return result
    }
    let at = revealed ? node.to : node.from
    const view = {
      get state() {
        return state
      },
      posAtDOM: () => at,
      dispatch: (spec) => {
        state = state.update(spec).state
      },
      focus() {},
    }
    const original = widget(revealed)
    const entry = {
      owner: { view, widget: original },
      dom: { isConnected: true },
    }
    const editing = original.edit(entry)
    entry.owner.widget = widget(!revealed)
    at = revealed ? node.from : node.to
    if (changed) {
      const from = source.indexOf('old')
      state = state.update({
        changes: { from, to: from + 3, insert: 'own' },
      }).state
    }
    answer('new')
    await editing
    assert.equal(
      state.doc.toString(),
      source.replace('old', changed ? 'own' : 'new'),
    )
  }
})
