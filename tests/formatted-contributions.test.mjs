import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { TreeFragment } from '@lezer/common'
import { GFM, parser, Table } from '@lezer/markdown'
import { ChunkedMarkdownParser } from '../src/renderer/src/chunked-markdown.ts'
import { formattedCompatibility } from '../src/renderer/src/formatted-compatibility.ts'
import {
  contributionExtension,
  formattedContributions,
  formattedLiteral,
  formattedMarkdown,
  formattedOpaque,
  formattedPrefix,
  formattedSyntaxTree,
  formattedTextFeatures,
  formattedTree,
  formattedViews,
} from '../src/renderer/src/formatted-contributions.ts'
import { formattedRegistry } from '../src/renderer/src/formatted-registry.ts'
import { formattedSyntax } from '../src/renderer/src/formatted-syntax.ts'
import { markdownSyntax } from '../src/renderer/src/markdown-syntax.ts'
import {
  BoundaryTree,
  boundaryRecords,
} from '../src/shared/chunked-markdown.ts'
import { MarkdownBoundaryIndex } from '../src/shared/markdown-boundary-index.ts'
import { boundarySyntaxIds } from '../src/shared/markdown-boundary-syntax.ts'
import { RenderedTextIndex } from '../src/shared/rendered-text.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'
import { sourceParserInput } from '../src/shared/source-parser.ts'
import {
  editorChangesFromSource,
  normalizedSource,
} from '../src/shared/source-projection.ts'
import { renderedConfig } from './rendered-config.mjs'

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

test('keys-only addon contributions keep rendered find available', () => {
  const run = () => true
  const project = (contribution) => {
    const state = EditorState.create({
      doc: 'hello **world**',
      extensions: contributionExtension(contribution),
    })
    const configs = state.facet(formattedMarkdown)
    const config = {
      ...renderedConfig,
      syntax: boundarySyntaxIds(configs),
      textSyntax: boundarySyntaxIds(configs, true),
      textFeatures: state.facet(formattedTextFeatures),
      literal: state.facet(formattedLiteral),
      opaque: state.facet(formattedOpaque),
    }
    const store = new SourceStore(state.doc.toString(), {
      tabId: 'keys-find',
      revision: 0,
    })
    const index = new RenderedTextIndex(store.snapshot(), 0, config)
    for (const _ of index.build()) {
    }
    return {
      state,
      text: [...index.range(0, index.length)]
        .map((chunk) => chunk.text)
        .join(''),
    }
  }
  for (const contribution of [
    { id: 'example.keys', keys: [{ key: 'F8', run }] },
    {
      id: 'example.empty-syntax',
      syntax: [],
      views: [],
      keys: [{ key: 'F8', run }],
    },
  ]) {
    const { state, text } = project(contribution)
    assert.equal(text, 'hello world')
    assert.equal(
      state
        .facet(keymap)
        .flat()
        .find((binding) => binding.key === 'F8')?.run,
      run,
    )
  }
  assert.throws(
    () =>
      project({
        id: 'example.renderer',
        views: [{ nodes: ['Paragraph'], decorate() {} }],
        keys: [{ key: 'F8', run }],
      }),
    /unsupported/,
  )
})

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

test('partial migration keeps only the unmigrated feature literal and refreshes within the same addon', () => {
  const removals = []
  for (const [id, node] of [
    ['one', 'StrongEmphasis'],
    ['two', 'Emphasis'],
  ]) {
    removals.push(
      markdownSyntax.register('mixed', {
        id,
        label: id,
        group: 'Mixed',
        level: 'inline',
        nodes: [node],
        matches: () => false,
      }),
    )
    removals.push(formattedCompatibility.register('mixed', 'rich', id))
  }
  const literal = () =>
    EditorState.create({
      extensions: formattedContributions.extension(),
    }).facet(formattedLiteral)
  try {
    const remove = formattedCompatibility.register('mixed', 'formatted', 'one')
    removals.push(remove)
    assert.ok(!literal().includes('StrongEmphasis'))
    assert.ok(
      literal().includes('Emphasis'),
      'the other legacy feature stays literal',
    )
    const before = formattedContributions.version()
    remove()
    assert.notEqual(
      formattedContributions.version(),
      before,
      'fallback changes even when the addon still needs an update',
    )
    assert.ok(literal().includes('StrongEmphasis'))
    assert.ok(literal().includes('Emphasis'))
  } finally {
    for (const remove of removals.reverse()) remove()
  }
})

test('renderer features follow syntax settings without removing sibling views', () => {
  const remove = markdownSyntax.register('test', {
    id: 'renderer',
    label: 'Renderer',
    group: 'Test',
    level: 'inline',
    nodes: ['Highlight'],
    matches: () => false,
  })
  try {
    const views = () =>
      EditorState.create({
        extensions: contributionExtension({
          id: 'test.renderers',
          views: [
            { nodes: ['Highlight'], feature: 'test.renderer' },
            { nodes: ['Paragraph'] },
          ],
        }),
      }).facet(formattedViews)
    assert.equal(views().length, 2)
    markdownSyntax.setEnabled('test.renderer', false)
    assert.deepEqual(
      views().map((view) => view.nodes),
      [['Paragraph']],
    )
  } finally {
    markdownSyntax.setEnabled('test.renderer', true)
    remove()
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

test('default markdown, obsidian and text-extras addons keep worker boundaries active', async () => {
  const modules = await Promise.all([
    import('../src/renderer/src/formatted/tables.ts'),
    import('../src/renderer/src/formatted/tasks.ts'),
    import('../src/renderer/src/formatted/footnotes.ts'),
    import('../src/renderer/src/formatted/strikethrough.ts'),
    import('../src/renderer/src/formatted/autolinks.ts'),
    import('../src/addons/markdown/formatted.ts'),
    import('../src/addons/markdown/formatted-obsidian.ts'),
    import('../src/addons/text-extras/formatted.ts'),
  ])
  const contributions = modules.flatMap((module) =>
    module.contributions
      ? Object.values(module.contributions)
      : [module.contribution],
  )
  const remove = contributions.map((contribution) =>
    formattedRegistry.register({
      id: contribution.id,
      load: () => contribution,
    }),
  )
  try {
    const flavors = [
      'markdown.github',
      'markdown.obsidian',
      'text-extras.text-extras',
    ]
    const state = EditorState.create({
      extensions: formattedContributions.extension(flavors),
    })
    const configs = state.facet(formattedMarkdown)
    const ids = boundarySyntaxIds(configs)
    assert.ok(
      ids,
      'default addon syntax must be eligible for worker boundaries',
    )
    assert.ok(ids.includes('subtext@1'))
    const unit = '# heading\n\n[[note]] and ~subscript~\n\n-# small text\n\n'
    const text = unit.repeat(Math.ceil((2 * 1024 * 1024) / unit.length))
    const store = new SourceStore(text, {
      tabId: 'default-addons',
      revision: 0,
    })
    const index = new MarkdownBoundaryIndex(store.snapshot(), {
      schema: 1,
      syntax: ids,
      flavors,
      literal: [],
      opaque: state.facet(formattedOpaque),
      prefix: 0,
      chunkSize: 4096,
      groupSize: 64,
      giantBlock: 65536,
    })
    while (!index.advance()) {}
    const probe = {
      parsedChunks: 0,
      parsedUnits: 0,
      scannedUnits: 0,
      reusedNodes: 0,
      builtGroups: 0,
    }
    const base = parser.configure([
      { defineNodes: [{ name: 'Frontmatter', block: true }] },
      ...configs,
    ])
    const opaque = new Set(state.facet(formattedOpaque))
    const view = new ChunkedMarkdownParser(base, base, { probe, opaque })
    const builder = new BoundaryTree(view, text.length)
    const pages = [...index.pages()]
    assert.ok(pages.length > 0)
    for (const page of pages) builder.append(page.records)
    const parse = view.startChunkedParse(
      sourceParserInput(store.snapshot()),
      TreeFragment.addTree(builder.finish()),
      { from: text.length - 8192, to: text.length },
    )
    while (!parse.advance()) {}
    assert.equal(probe.scannedUnits, 0)
    assert.ok(probe.reusedNodes > 0)

    const sizes = { chunkSize: 64, groupSize: 4, giantBlock: 1024 }
    const scanner = new ChunkedMarkdownParser(base, base, { ...sizes, opaque })
    const finish = (parse) => {
      for (;;) {
        const tree = parse.advance()
        if (tree) return tree
      }
    }
    const shape = (tree) => {
      const nodes = []
      tree.iterate({
        enter: (node) => nodes.push([node.name, node.from, node.to]),
      })
      return nodes
    }
    const input = (text) => ({
      length: text.length,
      lineChunks: false,
      chunk: (from) => text.slice(from, from + 4096),
      read: (from, to) => text.slice(from, to),
    })
    const snippets = [
      unit,
      'para line\n-# small after para\nlazy\n\n',
      '> -# quoted small\n> more\n\n',
      '- -# list small\n  continued\n\n',
      '| a | b |\n| --- | --- |\n| [[x|y]] | ~s~ |\n\n',
      '- [ ] task ~sub~\n- [x] done\n\n',
      '- [ ]\n\n',
      '> [!NOTE]\n> alert ==hl==\n\n',
      '[^n]: footnote [[link]]\n    continued\n\n',
      '~~~js\n-# not small\n[[not link]]\n\n~~~\n\n',
      'setext ~sub~\n===\n\n',
      '<div>\n[[x]]\n\n# after\n\n',
      '[ref]: /target\n\n',
      '    indented -# no\n\n',
      '==highlight\nacross lines==\n\n',
      '[[link\nacross]]\n\n',
      '%%comment%%\n\n',
      'text ~~strike~~ https://example.com\n\n',
      '1. ordered\n2. -# small in ordered\n\n',
      '-#nospace\n\n',
      ' -# one space\n\n',
      '-# \n\n',
      'a\n-# b\n-# c\n- d\n\n',
    ]
    const inserts = [
      'x',
      '\n',
      '\n\n',
      '~~~\n',
      '> ',
      '- ',
      '-# ',
      '-',
      '#',
      '|',
      '[[',
      ']]',
      '==',
      '~',
      '\n---\n',
      '<!--',
      '-->',
    ]
    for (const ending of ['\n', '\r\n', '\r']) {
      for (let seed = 1; seed <= 24; seed++) {
        let rng = seed
        const random = (size) => {
          rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0
          return rng % size
        }
        let text = Array.from(
          { length: 28 },
          () => snippets[random(snippets.length)],
        ).join('')
        const store = new SourceStore(text.replaceAll('\n', ending), {
          tabId: 'default-parity',
          revision: 0,
        })
        const worker = new MarkdownBoundaryIndex(store.snapshot(), {
          ...index.config,
          ...sizes,
        })
        let incremental = finish(scanner.startBoundaryParse(input(text), []))
        for (let step = 0; step < 6; step++) {
          while (!worker.advance()) {}
          const label = `seed ${seed} step ${step} ending ${JSON.stringify(ending)}`
          assert.deepEqual(
            [...worker.records()],
            [...boundaryRecords(incremental)],
            label,
          )
          const builder = new BoundaryTree(scanner, text.length)
          for (const page of worker.pages()) builder.append(page.records)
          const adopted = finish(
            scanner.startChunkedParse(
              input(text),
              TreeFragment.addTree(builder.finish()),
              { from: 0, to: text.length },
            ),
          )
          assert.deepEqual(shape(adopted), shape(base.parse(text)), label)
          if (step === 5) continue
          const from = random(text.length + 1)
          const to = Math.min(text.length, from + random(10))
          let insert = inserts[random(inserts.length)]
          if (text.slice(from, to) === insert) insert += 'x'
          const before = store.snapshot()
          const prepared = store.prepare({
            document: before.document,
            operationId: crypto.randomUUID(),
            baseVersion: before.version,
            contentVersion: before.version + 1,
            origin: 'source',
            historyGroup: 'test',
            changes: [
              {
                from: before.editorToRaw(from),
                to: before.editorToRaw(to),
                insert: insert.replaceAll('\n', ending),
              },
            ],
          })
          store.commit(prepared)
          worker.apply(prepared)
          let offset = 0
          const ranges = editorChangesFromSource(
            prepared.before,
            prepared.operation.changes,
          ).map((change) => {
            const range = {
              fromA: change.from,
              toA: change.to,
              fromB: change.from + offset,
              toB: change.from + offset + change.insert.length,
            }
            offset += change.insert.length - (change.to - change.from)
            return range
          })
          text = normalizedSource(store.snapshot().materialize())
          incremental = finish(
            scanner.startBoundaryParse(
              input(text),
              TreeFragment.applyChanges(
                TreeFragment.addTree(incremental),
                ranges,
              ),
            ),
          )
        }
      }
    }
  } finally {
    for (const dispose of remove.reverse()) dispose()
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

const shape = (tree) => {
  const nodes = []
  tree.iterate({
    enter(node) {
      nodes.push([node.name, node.from, node.to])
    },
  })
  return nodes
}

test('bundled inline syntax keeps skipping plain text, and inline syntax that may start anywhere turns that off', async () => {
  const { obsidianSyntax } = await import(
    '../src/addons/markdown/formatted-syntax.ts'
  )
  const { contributions: extras } = await import(
    '../src/addons/text-extras/formatted.ts'
  )
  const modules = await Promise.all(
    [
      '../src/renderer/src/formatted/autolinks.ts',
      '../src/renderer/src/formatted/footnotes.ts',
      '../src/renderer/src/formatted/strikethrough.ts',
      '../src/renderer/src/formatted/tables.ts',
      '../src/renderer/src/formatted/tasks.ts',
      '../src/addons/markdown/formatted.ts',
      '../src/addons/markdown/formatted-obsidian.ts',
    ].map((path) => import(path)),
  )
  // Bundled contributions with syntax, registered as the app registers them.
  // The math addon's module needs the bundler; the plain-text run tests
  // check its inline syntax.
  const removals = [
    ...modules.map((module) => module.contribution),
    extras.subscript,
    extras.subtext,
  ].map((contribution) =>
    formattedRegistry.register({
      id: contribution.id,
      load: () => contribution,
    }),
  )
  // The obsidian flavor's inline parsers run wherever the language does not skip text.
  let calls = 0
  const parses = obsidianSyntax.parseInline.map((inline) => inline.parse)
  for (const [index, inline] of obsidianSyntax.parseInline.entries())
    inline.parse = (...args) => {
      calls++
      return parses[index](...args)
    }
  const flavors = [
    'markdown.github',
    'markdown.obsidian',
    'text-extras.text-extras',
  ]
  /** The formatted view's tree and parser calls, and the tree of its syntax parsed without skipping text. */
  const formatted = (doc, documentFlavors = flavors) => {
    const syntax = formattedSyntax({ slice: Number.POSITIVE_INFINITY })
    calls = 0
    const state = EditorState.create({
      doc,
      extensions: [
        formattedContributions.extension(documentFlavors),
        syntax.extension,
      ],
    })
    const made = calls
    const markdown = state.facet(formattedMarkdown)
    const expected = parser.configure([
      { defineNodes: [{ name: 'Frontmatter', block: true }] },
      ...markdown,
    ])
    return {
      calls: made,
      tree: shape(syntax.tree(state)),
      expected: shape(expected.parse(doc)),
      markdown,
    }
  }
  try {
    const found = new Set()
    for (const doc of [
      'prose ==highlight== tail [[Target|label]] ![[photo.png|20]]',
      'a==b==c ===a=== ==a == \\==literal== `==code==` text == spaced ==',
      '[[a]][[b]] ![[a]]![[b.png]] [[a|b|c]] **==bold==** *[[em]]* ==a [[b]] c==',
      'plain &amp; ==&lt;tag&gt;== [[Other|&amp;]] <span>==a==</span> <!-- [[b]] -->',
      'two  \n==hard break== ==a\nb== [[a\nb]] é😀==ü== [[é]]',
      '# title ==mark==\n\n- [x] ==done== [[task]]\n- [ ]\n\n> quoted ![[c.png]]\n',
      '> [!NOTE] title ==x==\n> body [[y]]\n',
      '| a | ==b== |\n| - | - |\n| [[c]] | ![[e.png]] |\n',
      'note[^1] ~~strike~~ ~sub~ H~2~O www.example.com a_b@example.com\n\n[^1]: defined ==here== [[too]]\n',
      '-# small ==text== [[x]]\n',
    ]) {
      const { tree, expected } = formatted(doc)
      assert.deepEqual(tree, expected, JSON.stringify(doc))
      for (const [name] of tree) found.add(name)
    }
    for (const name of [
      'Highlight',
      'WikiLink',
      'WikiEmbed',
      'Task',
      'AlertTitle',
      'Table',
      'FootnoteReference',
      'FootnoteDefinition',
      'Strikethrough',
      'Subscript',
      'URL',
      'Subtext',
    ])
      assert.ok(found.has(name), name)
    // The first parse covers the whole document.
    const prose =
      `${'Plain prose words with some punctuation, numbers 123 and more text here. '.repeat(14)}\n\n`.repeat(
        7,
      )
    assert.ok(prose.length <= 8192)
    const plain = formatted(prose)
    assert.deepEqual(plain.tree, plain.expected)
    assert.ok(
      plain.calls <= prose.length / 100,
      `${plain.calls} obsidian inline parser calls for ${prose.length} characters of prose`,
    )
    // Known inline syntax keeps its worker identity for rendered projection.
    const github = boundarySyntaxIds(
      formatted('', ['markdown.github']).markdown,
    )
    assert.ok(github)
    assert.deepEqual(
      boundarySyntaxIds(
        formatted('', ['markdown.github', 'markdown.obsidian']).markdown,
      ),
      [...github, 'obsidian@1'],
    )
    // Inline syntax without declared stops may start at any character.
    const word = {
      id: 'test.word',
      syntax: {
        defineNodes: ['HibiWord'],
        parseInline: [
          {
            name: 'HibiWord',
            after: 'Escape',
            parse: (cx, next, pos) =>
              next === 104 && cx.slice(pos, pos + 4) === 'hibi'
                ? cx.addElement(cx.elt('HibiWord', pos, pos + 4))
                : -1,
          },
        ],
      },
    }
    const removeWord = formattedRegistry.register({
      id: word.id,
      load: () => word,
    })
    try {
      const unknown = formatted(prose)
      assert.ok(
        unknown.calls >= prose.length,
        `${unknown.calls} obsidian inline parser calls for ${prose.length} characters`,
      )
      const words = formatted('ordinary hibi text prehibipost')
      assert.deepEqual(words.tree, words.expected)
      assert.equal(words.tree.filter(([name]) => name === 'HibiWord').length, 2)
    } finally {
      removeWord()
    }
  } finally {
    for (const remove of removals) remove()
    for (const [index, inline] of obsidianSyntax.parseInline.entries())
      inline.parse = parses[index]
  }
})
