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
const { contribution, Footnotes } = await import(
  '../src/renderer/src/formatted/footnotes.ts'
)
const { definitionsRead, footnoteDefinitions, footnoteScan, readDefinitions } =
  await import('../src/renderer/src/formatted/footnote-definitions.ts')
const { contributionExtension } = await import(
  '../src/renderer/src/formatted-contributions.ts'
)
/** A state with the footnote contribution installed, as in a formatted view. */
const create = (doc) =>
  EditorState.create({ doc, extensions: contributionExtension(contribution) })
/** Read the rest of the note, as idle slices do. */
function settle(state) {
  for (let slices = 0; !definitionsRead(state); slices++) {
    assert.ok(slices < 10000, 'reading converges')
    state = state.update({
      effects: readDefinitions.of(footnoteScan.slice),
    }).state
  }
  return state
}
/** The labels and counts the index holds. */
function indexed(state) {
  const counts = {}
  const walk = (node) => {
    if (Array.isArray(node)) node.forEach(walk)
    else if (node)
      // A leaf, or the sorted chunks of labels whose hashes are equal.
      for (const [label, count] of node.chunks?.flat() ?? node) {
        assert.ok(count > 0, label)
        assert.equal(counts[label], undefined, label)
        counts[label] = count
      }
  }
  walk(state.field(footnoteDefinitions).labels)
  return counts
}
/** The labels a whole-note parse defines. */
function parsed(doc) {
  const counts = {}
  parser
    .configure([Footnotes])
    .parse(doc)
    .iterate({
      enter(node) {
        if (node.name !== 'FootnoteDefinition') return
        const label = node.node.getChild('FootnoteLabel')
        const key = doc.slice(label.from, label.to).toLowerCase()
        counts[key] = (counts[key] ?? 0) + 1
      },
    })
  return counts
}

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
  const state = settle(create(doc))
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
  const state = settle(
    create(
      'missing[^unknown], real[^1] and [^Note].\n\n[^1]: one\n\n> [^note]: quoted',
    ),
  )
  assert.deepEqual(rendered(state), ['[^1]', '[^Note]'])
})

test('definitions count where the formatted view parses them: not in code, html or paragraphs', () => {
  const doc = [
    'read[^demo], [^item], [^quote], [^lazy], [^html], [^tilde], [^indent].',
    '```md\n[^demo]: inside a fenced example\n```',
    '- [^item]: a note in a list item',
    '> - [^quote]: in a quoted list',
    'paragraph text\n[^lazy]: continues the paragraph',
    '<div>\n[^html]: inside html\n</div>',
    '~~~\n[^tilde]: in a tilde fence\n~~~',
    '    [^indent]: indented code',
  ].join('\n\n')
  const state = settle(create(doc))
  assert.deepEqual(indexed(state), parsed(doc))
  assert.deepEqual(indexed(state), { item: 1, quote: 1 })
  assert.deepEqual(rendered(state), ['[^item]', '[^quote]'])
})

test('opening a fence above a definition removes it; closing the fence brings it back', () => {
  const body = Array.from({ length: 400 }, (_, i) => `paragraph ${i}`).join(
    '\n\n',
  )
  let state = settle(create(`see[^far]\n\n${body}\n\n[^far]: the end`))
  assert.deepEqual(rendered(state), ['[^far]'])
  const at = state.doc.toString().indexOf('paragraph 10')
  state = settle(state.update({ changes: { from: at, insert: '```\n' } }).state)
  assert.deepEqual(indexed(state), {})
  assert.deepEqual(rendered(state), [])
  state = settle(
    state.update({ changes: { from: state.doc.length, insert: '\n```' } })
      .state,
  )
  assert.deepEqual(rendered(state), [])
  state = settle(state.update({ changes: { from: at, to: at + 4 } }).state)
  assert.deepEqual(indexed(state), { far: 1 })
  assert.deepEqual(rendered(state), ['[^far]'])
})

/** Seeded random numbers. */
function random(seed) {
  let value = seed >>> 0
  return () => {
    value = (value + 0x6d2b79f5) >>> 0
    let t = value
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

test('the index equals a whole-note parse after random edits, read in small slices', () => {
  const snippets = [
    '[^a]: a note',
    '[^B]: another',
    '- [^c]: in a list',
    '> [^d]: quoted',
    '```md\n[^e]: fenced\n```',
    '~~~\n[^f]: tilde',
    '<div>\n[^g]: html\n</div>',
    'text\n[^h]: lazy',
    '    [^i]: indented',
    '- item\n\n  [^j]: after a blank line in an item',
    '```',
    'plain paragraph with [^a] and [^b]',
    '# heading',
    '1. [^k]: ordered',
    '[^l]: first\n    continued\n\n    second paragraph',
    '> quote\n[^m]: lazy in quote',
    '<!-- c\n[^n]: in comment\n-->',
    'Title\n---\n[^o]: after setext',
    '> - a\n>   [^p]: nested item cont',
    '  [^q]: two spaces',
    '\t[^r]: tab',
    '- a\n  - b\n\n    [^s]: deep',
    '</div>',
    '<pre>\n[^t]: pre\n',
    '~~~~',
    '>',
    '- item\n\n\n\n    [^z]: after blank lines in an item',
    '1. item\n\n\n     [^y]: in an ordered item after blank lines',
  ]
  const { slice, window } = footnoteScan
  try {
    for (let seed = 1; seed <= 400; seed++) {
      const r = random(seed * 7919)
      // Tiny windows and slices make every edit read across several windows.
      footnoteScan.window = [16, 48, 256, 4096][seed % 4]
      footnoteScan.slice = [100, 300, 2000, 1 << 20][(seed >> 2) % 4]
      const pick = () => snippets[Math.floor(r() * snippets.length)]
      let doc = Array.from({ length: 80 }, pick).join(r() < 0.5 ? '\n\n' : '\n')
      let state = settle(create(doc))
      assert.deepEqual(indexed(state), parsed(doc), `seed ${seed} start`)
      for (let round = 0; round < 25; round++) {
        // One or two changes, the second after the first.
        const changes = []
        for (let lo = 0, n = r() < 0.2 ? 2 : 1; n-- && lo <= doc.length; ) {
          const from = lo + Math.floor(r() * (doc.length - lo + 1))
          const to =
            r() < 0.5 ? from : Math.min(doc.length, from + Math.floor(r() * 60))
          const insert =
            r() < 0.5
              ? `\n\n${pick()}\n\n`
              : ['`', '\n', 'x', '>', '- ', '', '    ', '~~~', '```\n'][
                  Math.floor(r() * 9)
                ]
          changes.push({ from, to, insert })
          lo = to + 1
        }
        state = state.update({ changes }).state
        // Some rounds read again before the next edit, some don't.
        if (r() < 0.5) state = settle(state)
        doc = state.doc.toString()
      }
      state = settle(state)
      assert.deepEqual(indexed(state), parsed(doc), `seed ${seed}`)
    }
  } finally {
    footnoteScan.slice = slice
    footnoteScan.window = window
  }
})

test('label counts copied stay with the labels changed: none when typing in a definition, a few per new label', () => {
  const doc = Array.from(
    { length: 10000 },
    (_, i) => `[^n${i}]: note number ${i}`,
  ).join('\n\n')
  const slice = footnoteScan.slice
  footnoteScan.slice = 8192
  let state
  try {
    footnoteScan.copied = 0
    state = create(`see[^n5000]\n\n${doc}`)
    // Each idle slice copies counts for the labels it reads, not the ones before.
    let slices = 0
    while (!definitionsRead(state)) {
      const labels = Object.keys(indexed(state)).length
      const copied = footnoteScan.copied
      state = state.update({
        effects: readDefinitions.of(footnoteScan.slice),
      }).state
      const read = Object.keys(indexed(state)).length - labels
      assert.ok(
        footnoteScan.copied - copied <= 16 * read,
        `slice ${slices}: ${footnoteScan.copied - copied} copied for ${read}`,
      )
      slices++
    }
    assert.ok(slices > 20, `${slices}`)
    // Under 4 per label over the whole read; copying every bucket a slice touched took over 10.
    assert.ok(footnoteScan.copied < 4 * 10000, `${footnoteScan.copied}`)
  } finally {
    footnoteScan.slice = slice
  }
  assert.equal(Object.keys(indexed(state)).length, 10000)
  const body = state.doc.toString().indexOf('note number 5000')
  footnoteScan.copied = 0
  footnoteScan.parsed = 0
  for (let key = 0; key < 50; key++)
    state = state.update({ changes: { from: body + 5, insert: 'z' } }).state
  assert.equal(footnoteScan.copied, 0)
  // Each keystroke reads the stretch around it, not the note.
  assert.ok(footnoteScan.parsed < 50 * 4 * 4096, `${footnoteScan.parsed}`)
  assert.ok(definitionsRead(state))
  // Adding and removing a label copies one leaf of at most 16 counts.
  footnoteScan.copied = 0
  const end = state.doc.length
  state = state.update({
    changes: { from: end, insert: '\n\n[^fresh]: new' },
  }).state
  assert.equal(indexed(state).fresh, 1)
  state = state.update({ changes: { from: end, to: state.doc.length } }).state
  assert.equal(indexed(state).fresh, undefined)
  assert.ok(footnoteScan.copied <= 2 * 16, `${footnoteScan.copied}`)
})

test('labels whose hashes are equal copy one chunk of counts per change', () => {
  // `an` and `c0` hash alike, so all 1,024 labels of ten of them collide.
  const labels = Array.from({ length: 1024 }, (_, n) =>
    Array.from({ length: 10 }, (_, bit) => ((n >> bit) & 1 ? 'c0' : 'an')).join(
      '',
    ),
  )
  const [last] = labels.splice(700, 1)
  let state = settle(
    create(labels.map((label) => `[^${label}]: note`).join('\n\n')),
  )
  assert.equal(Object.keys(indexed(state)).length, 1023)
  // A chunk of at most 16 counts, and its halves when it splits.
  footnoteScan.copied = 0
  const end = state.doc.length
  state = state.update({
    changes: { from: end, insert: `\n\n[^${last}]: note` },
  }).state
  assert.ok(footnoteScan.copied <= 16 + 17, `${footnoteScan.copied}`)
  assert.equal(indexed(state)[last], 1)
  footnoteScan.copied = 0
  const first = state.doc.toString().indexOf('\n\n') + 2
  state = state.update({ changes: { from: 0, to: first } }).state
  state = state.update({
    changes: { from: end - first, to: state.doc.length },
  }).state
  assert.ok(footnoteScan.copied <= 2 * 16, `${footnoteScan.copied}`)
  assert.deepEqual(indexed(state), parsed(state.doc.toString()))
  // They share one hash, so all of them sit in sorted chunks.
  const chunks = []
  const walk = (node) =>
    Array.isArray(node)
      ? node.forEach(walk)
      : chunks.push(...(node?.chunks ?? []))
  walk(state.field(footnoteDefinitions).labels)
  assert.equal(chunks.flat().length, 1022)
})

test('a run of blank lines inside a list item ends no stretch, also after edits beside it', () => {
  const { window } = footnoteScan
  try {
    for (const size of [16, 48, 256])
      for (let blanks = 1; blanks <= 6; blanks++)
        for (let pad = 0; pad < 30; pad += 7) {
          footnoteScan.window = size
          let state = settle(
            create(
              `${'x'.repeat(pad)}\n\n- item\n${'\n'.repeat(blanks)}    [^real]: note\n\nafter\n`,
            ),
          )
          const label = `window ${size}, ${blanks} blank lines, ${pad} before`
          // Before, a cut inside the blank run read the definition as code.
          assert.deepEqual(indexed(state), { real: 1 }, label)
          const run = state.doc.toString().indexOf('- item') + 7
          for (const changes of [
            { from: run, insert: '\n' },
            { from: run, to: run + 1 },
            { from: 0, insert: 'y' },
          ]) {
            state = settle(state.update({ changes }).state)
            assert.deepEqual(
              indexed(state),
              parsed(state.doc.toString()),
              `${label}, ${JSON.stringify(changes)}`,
            )
          }
        }
  } finally {
    footnoteScan.window = window
  }
})

test('blank lookahead yields between bounded reads without losing nested definitions', () => {
  for (const [width, lines, budget] of [
    [4, 400000, 4096],
    [1023, 51200, 65536],
  ]) {
    const source =
      'read[^real]\n\n- first\n' +
      `${' '.repeat(width)}\n`.repeat(lines) +
      '    [^real]: real\n\nend'
    let state = create(source)
    let slices = 0
    while (!definitionsRead(state)) {
      const parsed = footnoteScan.parsed
      const scanned = footnoteScan.scanned ?? 0
      state = state.update({ effects: readDefinitions.of(budget) }).state
      const work =
        footnoteScan.parsed - parsed + (footnoteScan.scanned ?? 0) - scanned
      assert.ok(
        work <= budget + 3 * footnoteScan.window,
        `slice ${slices}: ${work}`,
      )
      assert.ok(++slices < 1000, 'reading converges')
    }
    assert.ok(slices > 100, 'blank lines are read over several slices')
    assert.deepEqual(indexed(state), { real: 1 })
    const at = source.lastIndexOf('[^real]:')
    state = settle(
      state.update({ changes: { from: at, to: at + 7, insert: '[^new]:' } })
        .state,
    )
    assert.deepEqual(indexed(state), { new: 1 })
  }
})

test('a delayed first window advances within a continuing list', () => {
  const source =
    '- item\n' +
    '    \n'.repeat(4000) +
    '  alpha\n  beta\n  gamma\n  delta\n\n[^end]: note'
  let state = create(source)
  for (let slices = 0; !definitionsRead(state); slices++) {
    assert.ok(slices < 20, 'reading advances past the first list line')
    state = state.update({ effects: readDefinitions.of(4096) }).state
  }
  assert.deepEqual(indexed(state), { end: 1 })
})

test('edits during blank lookahead discard stale positions and keep quote context', () => {
  for (const prefix of ['', '> ', '> > ']) {
    const body =
      '- first\n' + '    \n'.repeat(4000) + '    [^real]: real\n\nend'
    const source =
      'read[^real]\n\n' +
      body
        .split('\n')
        .map((line) => prefix + line)
        .join('\n')
    for (const from of [0, 5000, source.length - 2]) {
      let state = create(source)
      state = state.update({ effects: readDefinitions.of(1) }).state
      assert.equal(definitionsRead(state), false)
      state = settle(
        state.update({ changes: { from, insert: '\n😀\n' } }).state,
      )
      assert.deepEqual(
        indexed(state),
        parsed(state.doc.toString()),
        `${prefix}: ${from}`,
      )
    }
  }
})

test('a long line is parsed once, and a long block in reads near the budget from where the last stopped', () => {
  for (const [kind, body] of [
    ['line', 'x'.repeat(1 << 20)],
    ['fence', `~~~\n${'code line words\n'.repeat(70000)}~~~`],
    [
      'list',
      Array.from(
        { length: 30000 },
        (_, i) => `- item ${i}\n\n  [^d${i}]: note`,
      ).join('\n'),
    ],
  ]) {
    let state = create(`read[^far]\n\n${body}\n\n[^far]: defined`)
    footnoteScan.parsed = 0
    const reads = []
    while (!definitionsRead(state)) {
      const parsed = footnoteScan.parsed
      state = state.update({ effects: readDefinitions.of(4096) }).state
      reads.push(footnoteScan.parsed - parsed)
    }
    // Before, a window that one block filled doubled and parsed it again
    // from its start: twelve parses of the line, reads of up to the fence.
    assert.ok(
      footnoteScan.parsed <= state.doc.length * 1.05,
      `${kind}: ${footnoteScan.parsed} of ${state.doc.length}`,
    )
    if (kind !== 'line')
      for (const read of reads)
        assert.ok(read <= 4096 + 3 * footnoteScan.window, `${kind}: ${read}`)
    assert.deepEqual(indexed(state), parsed(state.doc.toString()), kind)
  }
})

test('opening a note reads none of it; idle slices read the rest', () => {
  const slice = footnoteScan.slice
  footnoteScan.slice = 4096
  try {
    const body = Array.from({ length: 20000 }, (_, i) => `line ${i}`).join(
      '\n\n',
    )
    footnoteScan.parsed = 0
    let state = create(
      `see[^far] and [^near]\n\n[^near]: close\n\n${body}\n\n[^far]: at the end`,
    )
    assert.equal(footnoteScan.parsed, 0)
    assert.deepEqual(rendered(state), [])
    state = state.update({ effects: readDefinitions.of(4096) }).state
    assert.deepEqual(rendered(state), ['[^near]'])
    let slices = 0
    while (!definitionsRead(state)) {
      state = state.update({
        effects: readDefinitions.of(footnoteScan.slice),
      }).state
      slices++
    }
    assert.ok(slices > 10, `${slices}`)
    assert.deepEqual(rendered(state), ['[^far]', '[^near]'])
  } finally {
    footnoteScan.slice = slice
  }
})
