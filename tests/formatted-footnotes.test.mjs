import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { GFM, parser } from '@lezer/markdown'
import { ChunkedMarkdownParser } from '../src/renderer/src/chunked-markdown.ts'

// Feature modules import their styles; these tests need only the code.
registerHooks({
  load: (url, context, next) =>
    url.endsWith('.css')
      ? { format: 'module', source: '', shortCircuit: true }
      : next(url, context),
})
const {
  contribution,
  footnoteDefinitions,
  Footnotes,
  footnoteScan,
  readDefinitions,
} = await import('../src/renderer/src/formatted/footnotes.ts')

const markdown = parser.configure([GFM, Footnotes])
const shape = (doc, names) => {
  const out = []
  markdown.parse(doc).iterate({
    enter(node) {
      if (names.includes(node.name))
        out.push(
          `${node.name}:${JSON.stringify(doc.slice(node.from, node.to))}`,
        )
    },
  })
  return out
}
const footnoteNodes = [
  'FootnoteDefinition',
  'FootnoteReference',
  'FootnoteLabel',
  'Paragraph',
  'Link',
  'LinkReference',
  'CodeBlock',
]

test('references and definitions parse like marked-github-footnote', () => {
  assert.deepEqual(shape('a[^1] b [^note].', footnoteNodes), [
    'Paragraph:"a[^1] b [^note]."',
    'FootnoteReference:"[^1]"',
    'FootnoteLabel:"1"',
    'FootnoteReference:"[^note]"',
    'FootnoteLabel:"note"',
  ])
  // A one-word note is not a link reference definition.
  assert.deepEqual(shape('[^1]: note', footnoteNodes), [
    'FootnoteDefinition:"[^1]: note"',
    'FootnoteLabel:"1"',
    'Paragraph:"note"',
  ])
  // Indented lines continue the note, also after a blank line; lazy lines continue its paragraph.
  assert.deepEqual(
    shape(
      '[^a]: first\n    second\n\n    next paragraph\nlazy\n\nafter',
      footnoteNodes,
    ),
    [
      'FootnoteDefinition:"[^a]: first\\n    second\\n\\n    next paragraph\\nlazy"',
      'FootnoteLabel:"a"',
      'Paragraph:"first\\n    second"',
      'Paragraph:"next paragraph\\nlazy"',
      'Paragraph:"after"',
    ],
  )
  for (const text of ['[^ x]', '[^]', '[^a b]: no', '    [^1]: code'])
    assert.equal(
      shape(text, ['FootnoteDefinition', 'FootnoteReference']).length,
      0,
      text,
    )
})

test('chunked parses keep footnote nodes where whole-document parses put them', () => {
  const units = [
    'text with a note[^1] here',
    '[^1]: the note\n    continued',
    '[^long-label]: one\n\n    two\n\n    - list in note',
    '- item[^2]',
    '> quoted [^3]',
    'plain paragraph',
  ]
  const chunked = new ChunkedMarkdownParser(markdown, markdown, {
    chunkSize: 16,
    groupSize: 3,
  })
  const names = (tree) => {
    const out = []
    tree.iterate({
      enter(node) {
        if (node.type.name) out.push(`${node.name}:${node.from}-${node.to}`)
      },
    })
    return out
  }
  for (let seed = 0; seed < 40; seed++) {
    const text = Array.from(
      { length: 30 },
      (_, i) => units[(i * 5 + seed) % units.length],
    ).join(seed % 3 ? '\n\n' : '\n')
    assert.deepEqual(
      names(chunked.parse(text)),
      names(markdown.parse(text)),
      `seed ${seed}`,
    )
  }
})

test('references hide their brackets and definitions label their first line', () => {
  const doc = 'see[^1]\n\n[^1]: the "note"\n  continued'
  const state = EditorState.create({ doc, extensions: contribution.extension })
  const out = []
  const sink = {
    mark: (from, to, attributes) =>
      out.push(['mark', doc.slice(from, to), attributes.class]),
    syntax: (from, to) => out.push(['syntax', doc.slice(from, to)]),
    line: (at, attributes) => out.push(['line', at, attributes]),
    widget() {},
    replace: (from, to) => out.push(['replace', from, to]),
  }
  const layout = []
  markdown.parse(doc).iterate({
    enter(node) {
      for (const view of contribution.views)
        if (view.nodes.includes(node.name)) {
          view.decorate?.(node, sink, { state, revealed: false })
          view.layout?.(
            node,
            {
              replace: (from, to) =>
                layout.push(JSON.stringify(doc.slice(from, to))),
              widget() {},
            },
            { state, revealed: false },
          )
        }
    },
  })
  assert.deepEqual(out, [
    ['syntax', '[^'],
    ['mark', '1', 'hibi-lp-footnote-ref'],
    ['syntax', ']'],
    [
      'line',
      9,
      {
        class: 'hibi-lp-footnote-label',
        style: 'list-style-type: "1 "',
      },
    ],
  ])
  // The continuation line's indentation is hidden; it flows after a space.
  assert.deepEqual(layout, ['"  "'])
})

/** References in `state` that render as footnotes, by their source. */
function rendered(state) {
  const doc = state.doc.toString()
  const view = contribution.views.find((view) =>
    view.nodes.includes('FootnoteReference'),
  )
  const out = []
  markdown.parse(doc).iterate({
    enter(node) {
      if (node.name !== 'FootnoteReference') return
      const marks = []
      view.decorate(
        node,
        {
          mark: () => marks.push('mark'),
          syntax: () => marks.push('syntax'),
          line() {},
          widget() {},
          replace() {},
        },
        { state, revealed: false, visible: null },
      )
      if (marks.length) out.push(doc.slice(node.from, node.to))
    },
  })
  return out
}

test('references without a definition stay text; labels match case-insensitively', () => {
  const state = EditorState.create({
    doc: 'missing[^unknown], real[^1] and [^Note].\n\n[^1]: one\n> [^note]: quoted',
    extensions: contribution.extension,
  })
  assert.deepEqual(rendered(state), ['[^1]', '[^Note]'])
})

test('definitions in other chunks resolve references, read in slices and per edited line', () => {
  const slice = footnoteScan.slice
  footnoteScan.slice = 4096
  try {
    const body = Array.from({ length: 20000 }, (_, i) => `line ${i}`).join('\n')
    const doc = `see[^far] and [^near]\n\n[^near]: close\n\n${body}\n\n[^far]: at the end`
    footnoteScan.lines = 0
    let state = EditorState.create({ doc, extensions: contribution.extension })
    // Opening reads one slice; the far definition is not read yet.
    assert.ok(footnoteScan.lines < 1000, `${footnoteScan.lines}`)
    assert.deepEqual(rendered(state), ['[^near]'])
    // Idle slices read the rest.
    let slices = 0
    while (state.field(footnoteDefinitions).read <= state.doc.length) {
      state = state.update({ effects: readDefinitions.of(null) }).state
      slices++
    }
    assert.ok(slices > 10, `${slices}`)
    assert.deepEqual(rendered(state), ['[^far]', '[^near]'])
    // Removing a definition reads only the edited lines, and its references become text.
    const far = state.doc.toString().lastIndexOf('[^far]:')
    footnoteScan.lines = 0
    state = state.update({
      changes: { from: far, to: far + 1, insert: '(' },
    }).state
    assert.ok(footnoteScan.lines <= 2, `${footnoteScan.lines}`)
    assert.deepEqual(rendered(state), ['[^near]'])
    footnoteScan.lines = 0
    state = state.update({
      changes: { from: far, to: far + 1, insert: '[' },
    }).state
    assert.ok(footnoteScan.lines <= 2, `${footnoteScan.lines}`)
    assert.deepEqual(rendered(state), ['[^far]', '[^near]'])
    // Typing elsewhere reads only the typed line.
    footnoteScan.lines = 0
    for (let key = 0; key < 100; key++)
      state = state.update({ changes: { from: 2, insert: 'e' } }).state
    assert.equal(footnoteScan.lines, 200)
  } finally {
    footnoteScan.slice = slice
  }
})
