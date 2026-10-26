import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { TreeFragment } from '@lezer/common'
import { GFM, parser, Table } from '@lezer/markdown'
import { ChunkedMarkdownParser } from '../src/renderer/src/chunked-markdown.ts'
import {
  contributionExtension,
  formattedContributions,
  formattedLiteral,
  formattedOpaque,
  formattedPrefix,
  formattedSyntaxTree,
  formattedTree,
  formattedViews,
} from '../src/renderer/src/formatted-contributions.ts'
import { formattedRegistry } from '../src/renderer/src/formatted-registry.ts'
import { formattedSyntax } from '../src/renderer/src/formatted-syntax.ts'
import { markdownSyntax } from '../src/renderer/src/markdown-syntax.ts'
import { boundarySyntaxIds } from '../src/shared/markdown-boundary-syntax.ts'

// Feature modules import their styles; these tests need only the code.
registerHooks({
  load: (url, context, next) =>
    url.endsWith('.css')
      ? { format: 'module', source: '', shortCircuit: true }
      : next(url, context),
})

/** `==text==` as a `Highlight` node, standing in for a contributed syntax. */
const highlightDelimiter = { resolve: 'Highlight', mark: 'HighlightMark' }
const highlight = {
  defineNodes: ['Highlight', 'HighlightMark'],
  parseInline: [
    {
      name: 'Highlight',
      parse(cx, next, pos) {
        if (next !== 61 || cx.char(pos + 1) !== 61) return -1
        return cx.addDelimiter(highlightDelimiter, pos, pos + 2, true, true)
      },
    },
  ],
}

const names = (tree, from = 0, to = tree.length) => {
  const out = []
  tree.iterate({
    from,
    to,
    enter(node) {
      if (node.name !== 'Document') out.push(node.name)
    },
  })
  return out
}

const stateWith = (doc, extensions) => {
  const syntax = formattedSyntax({ slice: 1000 })
  const state = EditorState.create({
    doc,
    extensions: [extensions, syntax.extension],
  })
  return { state, syntax }
}

test('contributions add syntax to the formatted language and follow their syntax setting', () => {
  const removeFeature = markdownSyntax.register('test', {
    id: 'highlight',
    label: 'Highlight',
    group: 'Test',
    level: 'inline',
    matches: () => false,
  })
  const remove = formattedRegistry.register({
    id: 'test.highlight',
    load: () => ({
      id: 'test.highlight',
      feature: 'test.highlight',
      syntax: highlight,
      views: [{ nodes: ['Highlight'], decorate: () => undefined }],
    }),
  })
  try {
    const on = stateWith('a ==b== c', formattedContributions.extension())
    assert.ok(names(on.syntax.tree(on.state)).includes('Highlight'))
    assert.equal(on.state.facet(formattedViews).length >= 1, true)
    // Off: not parsed, so the text shows as written.
    markdownSyntax.setEnabled('test.highlight', false)
    const off = stateWith('a ==b== c', formattedContributions.extension())
    assert.ok(!names(off.syntax.tree(off.state)).includes('Highlight'))
    assert.ok(
      !off.state
        .facet(formattedViews)
        .some((view) => view.nodes.includes('Highlight')),
    )
    // A reconfiguration that adds syntax parses the document again with it.
    const next = off.state.update({
      effects: [],
    }).state
    assert.ok(!names(off.syntax.tree(next)).includes('Highlight'))
  } finally {
    markdownSyntax.setEnabled('test.highlight', true)
    remove()
    removeFeature()
  }
})

test('contributions apply only to documents with their flavor, and core syntax that is off renders as written', () => {
  const contribution = { id: 'test.flavored', flavor: 'test.flavor' }
  const remove = formattedRegistry.register({
    id: 'test.flavored',
    load: () => ({ ...contribution, opaque: ['Flavored'] }),
  })
  try {
    const opaque = (flavors) =>
      EditorState.create({
        extensions: formattedContributions.extension(flavors),
      }).facet(formattedOpaque)
    assert.ok(opaque(['test.flavor']).includes('Flavored'))
    assert.ok(!opaque(['other.flavor']).includes('Flavored'))
    assert.ok(opaque(undefined).includes('Flavored'))
  } finally {
    remove()
  }
  markdownSyntax.setEnabled('core.bold', false)
  try {
    const literal = EditorState.create({
      extensions: formattedContributions.extension(),
    }).facet(formattedLiteral)
    assert.ok(literal.includes('StrongEmphasis'))
    assert.ok(!literal.includes('Emphasis'))
  } finally {
    markdownSyntax.setEnabled('core.bold', true)
  }
})

test('lazy entries load when a formatted view asks for them and report their arrival', async () => {
  let resolve
  const arrived = new Promise((done) => {
    resolve = done
  })
  const unsubscribe = formattedContributions.subscribe(() => resolve())
  const remove = formattedRegistry.register({
    id: 'test.lazy',
    load: async () => ({ id: 'test.lazy', opaque: ['Lazy'] }),
  })
  try {
    const opaque = () =>
      EditorState.create({
        extensions: formattedContributions.extension(),
      }).facet(formattedOpaque)
    assert.ok(!opaque().includes('Lazy'))
    await arrived
    assert.ok(opaque().includes('Lazy'))
  } finally {
    unsubscribe()
    remove()
  }
})

test('an unparsed document prefix becomes one Frontmatter node and the rest parses from it', () => {
  const prefix = '---\ntitle: x\n---\n'
  const doc = `${prefix}# Heading\n\ntext\n`
  const syntax = formattedSyntax({ slice: 1000 })
  const state = EditorState.create({
    doc,
    extensions: [
      formattedPrefix.of(() => prefix.length),
      contributionExtension({ id: 'test.none' }),
      syntax.extension,
    ],
  })
  const tree = syntax.tree(state)
  const top = []
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling)
    top.push(`${node.name}:${node.from}`)
  assert.deepEqual(top.slice(0, 2), [
    'Frontmatter:0',
    `ATXHeading1:${prefix.length}`,
  ])
})

test('giant blocks of opaque nodes get inner nodes only for their opening and last lines', () => {
  const base = parser.configure(GFM)
  const rows = Array.from({ length: 4000 }, (_, i) => `| ${i} | cell |`)
  const text = `# t\n\n| a | b |\n| - | - |\n${rows.join('\n')}\n\nend\n`
  const input = {
    length: text.length,
    chunk: (from) => text.slice(from),
    read: (from, to) => text.slice(from, to),
    lineChunks: false,
  }
  const counts = () => ({
    parsedChunks: 0,
    parsedUnits: 0,
    scannedUnits: 0,
    reusedNodes: 0,
    builtGroups: 0,
  })
  const parse = (probe, opaque, fragments = [], demand) => {
    const chunked = new ChunkedMarkdownParser(base, base, {
      probe,
      opaque: new Set(opaque),
      giantBlock: 4096,
      chunkSize: 512,
    })
    const run = chunked.startChunkedParse(input, fragments, demand)
    for (;;) {
      const tree = run.advance()
      if (tree) return tree
    }
  }
  const middle = text.indexOf('| 2000 |')
  const demand = { from: middle, to: middle + 2000 }
  const windowed = counts()
  parse(windowed, [], [], demand)
  const opaque = counts()
  const tree = parse(opaque, ['Table'], [], demand)
  // The table keeps its exact extent with its head and last row parsed.
  let table = tree.resolveInner(middle, 1)
  while (table.name !== 'Table') table = table.parent
  assert.equal(table.to, text.indexOf('\n\nend'))
  assert.ok(names(tree, table.from, table.from + 30).includes('TableHeader'))
  assert.ok(!names(tree, middle, middle + 2000).includes('TableRow'))
  assert.ok(
    opaque.parsedUnits < windowed.parsedUnits / 2,
    JSON.stringify({ opaque, windowed }),
  )
  // Typing inside it parses its head again, not the rows around the edit.
  const at = middle + 4
  const edited = `${text.slice(0, at)}x${text.slice(at)}`
  const again = counts()
  const chunked = new ChunkedMarkdownParser(base, base, {
    probe: again,
    opaque: new Set(['Table']),
    giantBlock: 4096,
    chunkSize: 512,
  })
  const run = chunked.startChunkedParse(
    {
      length: edited.length,
      chunk: (from) => edited.slice(from),
      read: (from, to) => edited.slice(from, to),
      lineChunks: false,
    },
    TreeFragment.applyChanges(TreeFragment.addTree(tree), [
      { fromA: at, toA: at, fromB: at, toB: at + 1 },
    ]),
    demand,
  )
  for (;;) if (run.advance()) break
  assert.ok(again.parsedUnits < 1000, JSON.stringify(again))
  // A table shorter than the giant size but longer than two chunks gets the
  // same window, so typing in it does not parse all its rows again.
  const medium = `# t\n\n| a | b |\n| - | - |\n${rows.slice(0, 200).join('\n')}\n\nend\n`
  const mediumInput = (value) => ({
    length: value.length,
    chunk: (from) => value.slice(from),
    read: (from, to) => value.slice(from, to),
    lineChunks: false,
  })
  const mediumParse = (probe, value, fragments) => {
    const parse = new ChunkedMarkdownParser(base, base, {
      probe,
      opaque: new Set(['Table']),
      giantBlock: 4096,
      chunkSize: 512,
    }).startChunkedParse(mediumInput(value), fragments, {
      from: 0,
      to: value.length,
    })
    for (;;) {
      const tree = parse.advance()
      if (tree) return tree
    }
  }
  assert.ok(medium.length > 1024 && medium.length < 4096, `${medium.length}`)
  const first = mediumParse(counts(), medium, [])
  const typedAt = medium.indexOf('| 100 |') + 4
  const typed = counts()
  mediumParse(
    typed,
    `${medium.slice(0, typedAt)}x${medium.slice(typedAt)}`,
    TreeFragment.applyChanges(TreeFragment.addTree(first), [
      { fromA: typedAt, toA: typedAt, fromB: typedAt, toB: typedAt + 1 },
    ]),
  )
  assert.ok(typed.parsedUnits < medium.length / 2, JSON.stringify(typed))
  void Table
})

test('commands read the formatted view tree from its state', () => {
  const syntax = formattedSyntax({ slice: 1000 })
  const state = EditorState.create({
    doc: '> intro\nlazy line',
    extensions: [syntax.extension, formattedTree.of(syntax.tree)],
  })
  assert.equal(formattedSyntaxTree(state), syntax.tree(state))
  assert.equal(
    formattedSyntaxTree(state).resolveInner(10, 1).parent.name,
    'Blockquote',
  )
  assert.equal(formattedSyntaxTree(EditorState.create({ doc: 'x' })), null)
})

// Feature modules import their styles, which Node cannot load.
registerHooks({
  load: (url, context, next) =>
    url.endsWith('.css')
      ? { format: 'module', source: '', shortCircuit: true }
      : next(url, context),
})

test('github tables are opaque in documents of that flavor', async () => {
  const { contribution } = await import(
    '../src/renderer/src/formatted/tables.ts'
  )
  const remove = formattedRegistry.register({
    id: contribution.id,
    load: () => contribution,
  })
  try {
    const opaque = (flavors) =>
      EditorState.create({
        extensions: formattedContributions.extension(flavors),
      }).facet(formattedOpaque)
    // Before, only tests set the opaque nodes, and a long table parsed its rows.
    assert.ok(opaque(['markdown.github']).includes('Table'))
    assert.ok(!opaque(['markdown.commonmark']).includes('Table'))
  } finally {
    remove()
  }
})

test('github task lists parse as tasks in documents of that flavor', async () => {
  const { contribution } = await import(
    '../src/renderer/src/formatted/tasks.ts'
  )
  const remove = formattedRegistry.register({
    id: contribution.id,
    load: () => contribution,
  })
  try {
    // Before, no contribution added task syntax once GFM left the base parser.
    const github = stateWith(
      '- [x] done\n- [ ] open\n',
      formattedContributions.extension(['markdown.github']),
    )
    assert.ok(names(github.syntax.tree(github.state)).includes('Task'))
    const plain = stateWith(
      '- [x] done\n',
      formattedContributions.extension(['markdown.commonmark']),
    )
    assert.ok(!names(plain.syntax.tree(plain.state)).includes('Task'))
  } finally {
    remove()
  }
})

test('turning off core html or images shows their nodes as written', () => {
  const literal = () =>
    EditorState.create({
      extensions: formattedContributions.extension(['markdown.github']),
    }).facet(formattedLiteral)
  assert.ok(!literal().includes('HTMLTag'))
  for (const [id, node] of [
    ['core.inline-html', 'HTMLTag'],
    ['core.html-blocks', 'HTMLBlock'],
    ['core.images', 'Image'],
  ]) {
    markdownSyntax.setEnabled(id, false)
    try {
      assert.ok(literal().includes(node), id)
    } finally {
      markdownSyntax.setEnabled(id, true)
    }
  }
})

test('default task, footnote and alert grammars share exact worker catalog identities', async () => {
  const tasks = await import('../src/renderer/src/formatted/tasks.ts')
  const footnotes = await import('../src/renderer/src/formatted/footnotes.ts')
  const alerts = await import('../src/addons/markdown/formatted.ts')
  assert.deepEqual(
    boundarySyntaxIds([
      tasks.contribution.syntax,
      footnotes.Footnotes,
      alerts.GithubAlerts,
    ]),
    ['tasks@1', 'empty-tasks@1', 'footnotes@1', 'github-alerts@1'],
  )
})
