import { build } from 'esbuild'
import {
  BoundaryTree,
  boundaryRecords,
  spliceBoundaryFragments,
} from '../src/shared/chunked-markdown.ts'
import { MarkdownBoundaryIndex } from '../src/shared/markdown-boundary-index.ts'
import {
  boundaryKey,
  boundaryParser,
  boundarySyntaxIds,
} from '../src/shared/markdown-boundary-syntax.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'
import { sourceParserInput } from '../src/shared/source-parser.ts'
import {
  editorChangesFromSource,
  normalizedSource,
} from '../src/shared/source-projection.ts'

const configuration = (extra = {}) => ({
  schema: 1,
  syntax: [
    'table@1',
    'tasks@1',
    'empty-tasks@1',
    'footnotes@1',
    'github-alerts@1',
    'strike@1',
    'autolink@1',
    'math-inline@1',
    'math-block@1',
  ],
  flavors: ['markdown.github', 'math.latex'],
  literal: [],
  opaque: ['FencedCode', 'Table', 'BlockMath'],
  prefix: 0,
  chunkSize: 64,
  groupSize: 4,
  giantBlock: 1024,
  ...extra,
})
const drain = (index) => {
  while (!index.advance()) {}
}
const shape = (tree) => {
  const nodes = []
  tree.iterate({ enter: (node) => nodes.push([node.name, node.from, node.to]) })
  return nodes
}
const hydrate = (index, parser = index.parser) => {
  const builder = new BoundaryTree(parser, index.length)
  for (const page of index.pages()) {
    assert.ok(page.records.length <= 128)
    assert.ok(JSON.stringify(page.records).length < 17000)
    builder.append(structuredClone(page.records))
  }
  return builder.finish()
}
const edit = (store, changes) => {
  const before = store.snapshot()
  const prepared = store.prepare({
    document: before.document,
    operationId: crypto.randomUUID(),
    baseVersion: before.version,
    contentVersion: before.version + 1,
    origin: 'source',
    historyGroup: 'test',
    changes,
  })
  store.commit(prepared)
  return prepared
}
const changedRanges = (prepared) => {
  let offset = 0
  return editorChangesFromSource(
    prepared.before,
    prepared.operation.changes,
  ).map((change) => {
    const result = {
      fromA: change.from,
      toA: change.to,
      fromB: change.from + offset,
      toB: change.from + offset + change.insert.length,
    }
    offset += change.insert.length - change.to + change.from
    return result
  })
}

test('worker boundaries and giant metadata match the main scanner through flavor fixtures and seeded edits', () => {
  const snippets = [
    '# heading\n\n',
    'paragraph **bold** words\n\n',
    '- one\n- two\n\n',
    '> [!NOTE]\n> alert text\n\n',
    '[^note]: a footnote\n    continued\n\n',
    '~~~js\n# code\n\n~~~\n\n',
    '| a | b |\n| --- | --- |\n| x | y |\n\n',
    '- [ ] task\n- [x] done\n\n',
    '$$\nx+y\n$$\n\n',
    'title\n---\n\n',
    '<div>\nhtml\n\n# after\n\n',
    '[ref]: /target\n\n',
    '    indented\n\n',
    '> -\n>   first\n>\n>   second\n\n',
    '---\nkey: value\n---\n\n',
  ]
  const inserts = [
    'x',
    '\n',
    '\n\n',
    '~~~\n',
    '> ',
    '- ',
    '$$\n',
    '|',
    '\n---\n',
    '<!--',
    '-->',
  ]
  for (const ending of ['\n', '\r\n', '\r']) {
    for (let seed = 1; seed <= 36; seed++) {
      let state = seed
      const random = (size) => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0
        return state % size
      }
      let text =
        '\uFEFF' +
        Array.from(
          { length: 24 },
          () => snippets[random(snippets.length)],
        ).join('')
      const config = configuration({
        syntax: seed % 3 ? configuration().syntax : ['table@1'],
      })
      const store = new SourceStore(text.replaceAll('\n', ending), {
        tabId: 'parity',
        revision: 0,
      })
      const probe = counts(),
        worker = new MarkdownBoundaryIndex(store.snapshot(), config, probe)
      const base = boundaryParser(config),
        main = new ChunkedMarkdownParser(base, base, {
          ...config,
          opaque: new Set(config.opaque),
        })
      let expected = finish(main.startBoundaryParse(input(text), []))
      for (let step = 0; step < 7; step++) {
        drain(worker)
        assert.deepEqual(
          [...worker.records()],
          [...boundaryRecords(expected)],
          `seed ${seed} step ${step} ending ${JSON.stringify(ending)}`,
        )
        const adopted = hydrate(worker)
        assert.deepEqual([...boundaryRecords(adopted)], [...worker.records()])
        const actual = finish(
          main.startChunkedParse(input(text), TreeFragment.addTree(adopted), {
            from: 0,
            to: text.length,
          }),
        )
        assert.deepEqual(
          shape(actual),
          shape(base.parse(text)),
          `nodes seed ${seed} step ${step}`,
        )
        const from = random(text.length + 1),
          to = Math.min(text.length, from + random(10))
        let insert = inserts[random(inserts.length)]
        if (text.slice(from, to) === insert) insert += 'x'
        const source = store.snapshot()
        const prepared = edit(store, [
          {
            from: source.editorToRaw(from),
            to: source.editorToRaw(to),
            insert: insert.replaceAll('\n', ending),
          },
        ])
        worker.apply(prepared)
        text = normalizedSource(store.snapshot().materialize())
        expected = finish(
          main.startBoundaryParse(
            input(text),
            TreeFragment.applyChanges(
              TreeFragment.addTree(expected),
              changedRanges(prepared),
            ),
          ),
        )
      }
      assert.equal(probe.parsedUnits, 0)
    }
  }
})

test('frontmatter prefixes and empty notes transfer without syntax nodes', () => {
  for (const text of ['', '---\ntitle: example\n---\n\n# body\n\ntext\n']) {
    const prefix = text ? text.indexOf('\n\n') : 0
    const store = new SourceStore(text.replaceAll('\n', '\r\n'), {
      tabId: 'prefix',
      revision: 0,
    })
    const worker = new MarkdownBoundaryIndex(
      store.snapshot(),
      configuration({ prefix }),
    )
    drain(worker)
    const adopted = hydrate(worker)
    assert.deepEqual(shape(adopted), [['Document', 0, text.length]])
    const parsed = finish(
      worker.parser.startChunkedParse(
        sourceParserInput(store.snapshot()),
        TreeFragment.addTree(adopted),
        { from: 0, to: text.length },
        prefix,
      ),
    )
    assert.equal(
      parsed.topNode.firstChild?.name,
      text ? 'Frontmatter' : undefined,
    )
  }
})

test('properties edits map worker prefixes and retain boundaries without scanning body text', () => {
  const prefix = '---\ntitle: exact\n---\n\n'
  const config = configuration({
    prefix: prefix.length,
    chunkSize: 4096,
    groupSize: 64,
    giantBlock: 65536,
  })
  assert.equal(
    boundaryKey(config),
    boundaryKey({ ...config, prefix: prefix.length + 1 }),
  )
  for (const ending of ['\n', '\r\n', '\r']) {
    const unit = '# heading\n\nparagraph words\n\n'
    const length = ending === '\n' ? 8 * 1024 * 1024 : 128 * 1024
    const text = prefix + unit.repeat(Math.ceil(length / unit.length))
    const store = new SourceStore(text.replaceAll('\n', ending), {
      tabId: 'properties',
      revision: 0,
    })
    const probe = counts()
    const index = new MarkdownBoundaryIndex(store.snapshot(), config, probe)
    drain(index)
    let expected = prefix.length
    for (const insert of ['x', ending + 'other: value', 'z']) {
      const at = store.snapshot().materialize().indexOf('exact') + 5
      probe.scannedUnits = probe.reusedNodes = 0
      index.apply(edit(store, [{ from: at, to: at, insert }]))
      expected += normalizedSource(insert).length
      drain(index)
      assert.equal(index.config.prefix, expected)
      assert.equal(index.key, boundaryKey({ ...config, prefix: expected }))
      assert.equal(probe.scannedUnits, 0, JSON.stringify(probe))
      assert.ok(probe.reusedNodes > 0)
      assert.ok(
        [...index.records()].every(
          (record) => record.kind !== 'chunk' || record.type !== 'tail',
        ),
      )
    }
  }
})

test('short-line boundary scans amortize normalized rope lookups across bounded ranges', () => {
  const unit = '# heading\n\nparagraph **bold** words\n\n- one\n- two\n\n'
  const text = unit.repeat(Math.ceil((1024 * 1024) / unit.length))
  const store = new SourceStore(text, { tabId: 'cached-input', revision: 0 })
  store.counters(true)
  const worker = new MarkdownBoundaryIndex(
    store.snapshot(),
    configuration({ chunkSize: 4096, groupSize: 64, giantBlock: 65536 }),
  )
  drain(worker)
  const work = store.counters()
  assert.ok(work.nodeVisits < text.length, JSON.stringify(work))
  assert.ok(work.unitsScanned < text.length, JSON.stringify(work))
  assert.ok(work.sourceUnitsRead < text.length * 8, JSON.stringify(work))
  assert.equal(work.materializations, 0)
})

test('edits during a scan preserve its verified prefix and rescan only damaged ranges', () => {
  const text = '# heading\n\nparagraph text\n\n'.repeat(40000)
  const store = new SourceStore(text, { tabId: 'incremental', revision: 0 })
  const probe = counts(),
    worker = new MarkdownBoundaryIndex(
      store.snapshot(),
      configuration({ chunkSize: 4096, groupSize: 64, giantBlock: 65536 }),
      probe,
    )
  for (let i = 0; i < 20; i++) assert.equal(worker.advance(), false)
  const scanned = probe.scannedUnits
  probe.scannedUnits = 0
  worker.apply(
    edit(store, [
      { from: text.length - 10, to: text.length - 10, insert: 'x' },
    ]),
  )
  drain(worker)
  assert.ok(probe.reusedNodes > 0)
  assert.ok(
    probe.scannedUnits < text.length - scanned / 2,
    JSON.stringify({ scanned, after: probe.scannedUnits, length: text.length }),
  )
  probe.scannedUnits = 0
  worker.apply(
    edit(store, [{ from: text.length - 8, to: text.length - 8, insert: 'y' }]),
  )
  drain(worker)
  assert.ok(probe.scannedUnits < 160 * 1024, JSON.stringify(probe))
})

test('multiple edits between requests retain verified boundaries and scan every unfinished tail', () => {
  const unit = '# heading\n\nparagraph words\n\n'
  const text = unit.repeat(Math.ceil((8 * 1024 * 1024) / unit.length))
  for (const complete of [true, false]) {
    const store = new SourceStore(text, { tabId: 'queued-edits', revision: 0 })
    const probe = counts()
    const index = new MarkdownBoundaryIndex(
      store.snapshot(),
      configuration({ chunkSize: 4096, groupSize: 64, giantBlock: 65536 }),
      probe,
    )
    if (complete) drain(index)
    else for (let i = 0; i < 20; i++) assert.equal(index.advance(), false)
    probe.scannedUnits = 0
    probe.reusedNodes = 0
    const at = Math.floor(text.length / 2)
    for (let i = 0; i < 3; i++)
      index.apply(edit(store, [{ from: at + i, to: at + i, insert: 'x' }]))
    drain(index)
    const records = [...index.records()]
    assert.ok(
      records.length > 1000,
      JSON.stringify({ complete, records: records.length }),
    )
    assert.ok(
      records.every(
        (record) => record.kind !== 'chunk' || record.type !== 'tail',
      ),
    )
    assert.equal(
      records.reduce(
        (length, record) =>
          length + (record.kind === 'chunk' ? record.length : 0),
        0,
      ),
      index.length,
    )
    assert.ok(probe.reusedNodes > 0, JSON.stringify(probe))
    if (complete)
      assert.ok(probe.scannedUnits < 512 * 1024, JSON.stringify(probe))
    const from = Math.floor(index.length / 2)
    assert.ok([...index.pages(from)][0].from > 0)
  }
})

test('queued structural edits produce the same syntax as a fresh index away from offset zero', () => {
  const text = '# heading\n\nparagraph words\n\n'.repeat(3000)
  const store = new SourceStore(text, {
    tabId: 'queued-structure',
    revision: 0,
  })
  const config = configuration()
  const index = new MarkdownBoundaryIndex(store.snapshot(), config)
  drain(index)
  const at = text.indexOf('# heading', Math.floor(text.length / 2))
  for (let i = 0; i < 4; i++)
    index.apply(edit(store, [{ from: at + i, to: at + i, insert: '~~~\n'[i] }]))
  drain(index)
  const fresh = new MarkdownBoundaryIndex(store.snapshot(), config)
  drain(fresh)
  const source = store.snapshot().materialize()
  const parse = (model) =>
    finish(
      model.parser.startChunkedParse(
        input(source),
        TreeFragment.addTree(hydrate(model)),
        null,
      ),
    )
  assert.ok(
    [...index.records()].every(
      (record) => record.kind !== 'chunk' || record.type !== 'tail',
    ),
  )
  assert.deepEqual(shape(parse(index)), shape(parse(fresh)))
})

test('receiving views reject unscanned boundary records before adopting any page', () => {
  const store = new SourceStore('paragraph\n', { tabId: 'tail', revision: 0 })
  const index = new MarkdownBoundaryIndex(store.snapshot(), configuration())
  const builder = new BoundaryTree(index.parser, index.length)
  assert.throws(
    () =>
      builder.append([{ kind: 'chunk', type: 'tail', length: index.length }]),
    /Could not read a document worker reply/,
  )
})

test('continued typing lets a long worker repair finish within a fixed advance budget', (t) => {
  const unit = '# heading\n\nparagraph words\n\n'
  const text = unit.repeat(Math.ceil((8 * 1024 * 1024) / unit.length))
  const store = new SourceStore(text, { tabId: 'continued', revision: 0 })
  const probe = counts()
  const index = new MarkdownBoundaryIndex(
    store.snapshot(),
    configuration({
      chunkSize: 4096,
      groupSize: 64,
      giantBlock: 65536,
      opaque: ['Table'],
    }),
    probe,
  )
  drain(index)
  probe.scannedUnits = 0
  const fence = text.indexOf('# heading', Math.floor(text.length / 2))
  index.apply(edit(store, [{ from: fence, to: fence, insert: '~~~\n' }]))
  const at = text.indexOf('paragraph', Math.floor(text.length / 10)) + 4
  let typed = 0,
    complete = false
  while (typed < 12) {
    for (let step = 0; step < 30 && !complete; step++)
      complete = index.advance()
    if (complete) break
    index.apply(
      edit(store, [{ from: at + typed, to: at + typed, insert: 'x' }]),
    )
    typed++
  }
  t.diagnostic(JSON.stringify({ typed, complete, scanned: probe.scannedUnits }))
  assert.equal(complete, true)
  assert.ok(probe.scannedUnits < 8 * 1024 * 1024, JSON.stringify(probe))
})

test('edits during active boundary repairs retain progress and the saved suffix', (t) => {
  const text = '# heading\n\nparagraph words\n\n'.repeat(
    Math.ceil((8 * 1024 * 1024) / 28),
  )
  const store = new SourceStore(text, { tabId: 'midscan', revision: 0 })
  const probe = counts()
  const index = new MarkdownBoundaryIndex(
    store.snapshot(),
    configuration({
      chunkSize: 4096,
      groupSize: 64,
      giantBlock: 65536,
      opaque: ['Table'],
    }),
    probe,
  )
  drain(index)
  const at = text.indexOf('# heading', Math.floor(text.length / 2))
  probe.scannedUnits = 0
  index.apply(edit(store, [{ from: at + 2, to: at + 2, insert: 'x' }]))
  assert.equal(index.advance(), false)
  assert.equal(index.advance(), false)
  index.apply(edit(store, [{ from: at + 3, to: at + 3, insert: 'y' }]))
  drain(index)
  assert.ok(probe.scannedUnits < 512 * 1024, JSON.stringify(probe))
  const ordinaryScanned = probe.scannedUnits
  probe.scannedUnits = 0
  let pos = at
  for (const character of '<!-- note -->') {
    index.apply(edit(store, [{ from: pos, to: pos, insert: character }]))
    pos++
    for (let step = 0; step < 3; step++) if (index.advance()) break
  }
  drain(index)
  assert.ok(probe.scannedUnits < 2 * 1024 * 1024, JSON.stringify(probe))
  t.diagnostic(
    JSON.stringify({ ordinaryScanned, commentScanned: probe.scannedUnits }),
  )
  assert.ok(
    [...index.records()].every(
      (record) => record.kind !== 'chunk' || record.type !== 'tail',
    ),
  )
})

test('short repair pages splice into mapped viewport fragments with matching syntax', () => {
  const unit = '# heading\n\nparagraph **bold** words\n\n- one\n- two\n\n'
  const body = unit.repeat(1200)
  const at = body.indexOf('# heading', Math.floor(body.length / 4))
  const close = body.indexOf('paragraph', at + 2000)
  const text = body.slice(0, close) + 'words --> text\n\n' + body.slice(close)
  const store = new SourceStore(text, { tabId: 'splice', revision: 0 })
  const config = configuration({ opaque: ['Table'] })
  const index = new MarkdownBoundaryIndex(store.snapshot(), config)
  drain(index)
  const old = hydrate(index)
  const version = index.version
  const change = edit(store, [{ from: at, to: at, insert: '<!--\n' }])
  const mapped = TreeFragment.applyChanges(
    TreeFragment.addTree(old),
    changedRanges(change),
  )
  const source = sourceParserInput(store.snapshot())
  const local = index.parser.startChunkedParse(source, mapped, {
    from: 0,
    to: 200,
  })
  local.advance()
  index.apply(change)
  drain(index)
  const pages = [...index.pages(at, version)]
  const { from, to } = pages[0]
  assert.ok(to < index.length)
  const builder = new BoundaryTree(index.parser, to - from)
  for (const page of pages) builder.append(page.records)
  const fragments = spliceBoundaryFragments(
    local.snapshot(),
    mapped,
    from,
    to,
    builder.finish(),
  )
  const fresh = new MarkdownBoundaryIndex(store.snapshot(), config)
  drain(fresh)
  for (const center of [from, at + 1000, to, index.length - 200]) {
    const demand = {
      from: Math.max(0, center - 200),
      to: Math.min(index.length, center + 200),
    }
    const visible = (tree) =>
      shape(tree).filter(
        ([name, start, end]) =>
          name && name !== 'Document' && start < demand.to && end > demand.from,
      )
    const actual = finish(
      index.parser.startChunkedParse(source, fragments, demand, 0, true),
    )
    const expected = finish(
      fresh.parser.startChunkedParse(
        source,
        TreeFragment.addTree(hydrate(fresh)),
        demand,
      ),
    )
    assert.deepEqual(visible(actual), visible(expected), JSON.stringify(demand))
  }
})

test('a repair beginning inside the stale view prefix preserves its giant paragraph', () => {
  const line = 'code body line\n'
  const head = `intro\n\n${line.repeat(80)}`
  const before = `${head}${line}${line.repeat(10)}\n# end\n`
  const after = `${head}# code body ln\n${line.repeat(10)}\n# end\n`
  assert.equal(before.length, after.length)
  const config = configuration({ syntax: [], opaque: [] })
  const store = new SourceStore(after, { tabId: 'prefix-seam', revision: 0 })
  const index = new MarkdownBoundaryIndex(store.snapshot(), config)
  drain(index)
  // A stale giant in the view crosses the worker's verified repair start.
  const stale = finish(
    index.parser.startChunkedParse(input(before), [], {
      from: after.length - 20,
      to: after.length,
    }),
  )
  const from = head.length
  const pages = [...index.pages(from)]
  assert.equal(pages[0].from, from)
  const builder = new BoundaryTree(index.parser, after.length - from)
  for (const page of pages) builder.append(page.records)
  const fragments = spliceBoundaryFragments(
    stale,
    [],
    from,
    after.length,
    builder.finish(),
  )
  const actual = finish(
    index.parser.startChunkedParse(
      input(after),
      fragments,
      { from: 0, to: 400 },
      0,
      true,
    ),
  )
  const paragraphs = (tree) =>
    shape(tree).filter(([name, start]) => name === 'Paragraph' && start < 400)
  assert.deepEqual(
    paragraphs(actual),
    paragraphs(boundaryParser(config).parse(after)),
  )
})

test('a 52 mib structural repair transfers only through the unchanged suffix', (t) => {
  const unit = '# heading\n\nparagraph **bold** words\n\n- one\n- two\n\n'
  const body = unit.repeat(Math.ceil((52 * 1024 * 1024) / unit.length))
  const close = body.indexOf(
    'paragraph',
    Math.floor(body.length * 0.01) + 200 * 1024,
  )
  const text =
    body.slice(0, close) + 'paragraph --> text\n\n' + body.slice(close)
  const store = new SourceStore(text, { tabId: 'rejoin', revision: 0 })
  const config = configuration({
    chunkSize: 4096,
    groupSize: 64,
    giantBlock: 65536,
  })
  const probe = counts()
  const index = new MarkdownBoundaryIndex(store.snapshot(), config, probe)
  drain(index)
  const old = hydrate(index)
  const baseVersion = index.version
  const at = text.lastIndexOf('\n# heading', Math.floor(text.length * 0.01)) + 1
  const prepared = edit(store, [{ from: at, to: at, insert: '<!--\n' }])
  probe.scannedUnits = 0
  index.apply(prepared)
  drain(index)
  const pages = [...index.pages(at, baseVersion)]
  const records = pages.reduce((sum, page) => sum + page.records.length, 0)
  t.diagnostic(
    JSON.stringify({
      pages: pages.length,
      records,
      scanned: probe.scannedUnits,
    }),
  )
  assert.ok(pages.length <= 2, JSON.stringify({ pages: pages.length, records }))
  assert.ok(records <= 256)
  const { from, to } = pages[0]
  assert.ok(from > 0 && from <= at)
  assert.ok(to > close && to < close + 512 * 1024)
  assert.ok(pages.every((page) => page.from === from && page.to === to))
  assert.ok(probe.scannedUnits < 1024 * 1024)
  const builder = new BoundaryTree(index.parser, to - from)
  for (const page of pages) builder.append(page.records)
  const mapped = TreeFragment.applyChanges(
    TreeFragment.addTree(old),
    changedRanges(prepared),
  )
  const fragments = spliceBoundaryFragments(
    old,
    mapped,
    from,
    to,
    builder.finish(),
  )
  probe.scannedUnits = 0
  const parsed = finish(
    index.parser.startChunkedParse(
      sourceParserInput(store.snapshot()),
      fragments,
      {
        from: index.length - 8192,
        to: index.length,
      },
      0,
      true,
    ),
  )
  assert.equal(parsed.length, index.length)
  // The repaired start may fall inside the view's last prefix chunk.
  t.diagnostic(JSON.stringify({ spliceScanned: probe.scannedUnits }))
  assert.ok(probe.scannedUnits <= 32 * config.chunkSize, JSON.stringify(probe))
  probe.scannedUnits = 0
  finish(
    index.parser.startChunkedParse(
      sourceParserInput(store.snapshot()),
      TreeFragment.addTree(parsed),
      {
        from: index.length - 16384,
        to: index.length - 8192,
      },
    ),
  )
  assert.equal(probe.scannedUnits, 0)
  const unchanged = [...index.pages(index.length - 100, baseVersion)]
  assert.equal(unchanged.length, 1)
  assert.equal(unchanged[0].to, unchanged[0].from)
  assert.deepEqual(unchanged[0].records, [])
  index.apply(edit(store, [{ from: at + 10, to: at + 10, insert: 'x' }]))
  drain(index)
  assert.ok(
    [...index.pages(at, baseVersion)].every((page) => page.to === undefined),
  )
})

test('giant replay points, ordered counts, read-ahead, and ends survive bounded pages', () => {
  for (const text of [
    '1. first\n' +
      Array.from(
        { length: 2000 },
        (_, i) =>
          `${i + 2}. row **bold**\n\n${' '.repeat(String(i + 2).length + 2)}detail\n\n`,
      ).join('') +
      '\n# end\n',
    '~~~\n' + 'code words\n'.repeat(20000) + '~~~\n\n# end\n',
    '| a | b |\n| --- | --- |\n' + '| x | y |\n'.repeat(12000) + '\n# end\n',
    '$$\n' + 'x + y\n'.repeat(900) + '$$\n\n# end\n',
  ]) {
    const store = new SourceStore(text, { tabId: 'giant', revision: 0 })
    const worker = new MarkdownBoundaryIndex(
      store.snapshot(),
      configuration({ opaque: [] }),
    )
    drain(worker)
    const restored = hydrate(worker)
    assert.deepEqual([...boundaryRecords(restored)], [...worker.records()])
    const middle = Math.floor(text.length / 2)
    const actual = finish(
      worker.parser.startChunkedParse(
        input(text),
        TreeFragment.addTree(restored),
        { from: middle, to: middle + 100 },
      ),
    )
    const start = middle,
      end = Math.min(text.length, middle + 100)
    const within = (tree) =>
      shape(tree).filter(([, from, to]) => from >= start && to <= end)
    assert.deepEqual(
      within(actual),
      within(boundaryParser(configuration()).parse(text)),
    )
  }
})

test('unknown syntax and catalog version mismatches cannot claim worker parity', () => {
  assert.equal(boundarySyntaxIds({ parseBlock: [] }), null)
  assert.equal(boundaryParser(configuration({ schema: 2 })), null)
  assert.equal(boundaryParser(configuration({ syntax: ['unknown@1'] })), null)
})

test('document worker bundles contain no codemirror or dom modules', async () => {
  const built = await build({
    entryPoints: ['src/renderer/src/document.worker.ts'],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    metafile: true,
    logLevel: 'silent',
  })
  const modules = Object.keys(built.metafile.inputs)
  assert.ok(
    modules.some((path) => path.endsWith('src/shared/chunked-markdown.ts')),
  )
  assert.ok(
    modules.some((path) =>
      path.endsWith('src/addons/math/formatted-syntax.ts'),
    ),
  )
  assert.deepEqual(
    modules.filter(
      (path) =>
        path.includes('@codemirror/') ||
        /react-dom|renderer\/src\/(?:live-preview|formatted-contributions)/.test(
          path,
        ),
    ),
    [],
  )
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { TreeFragment } from '@lezer/common'
import { GFM, parser } from '@lezer/markdown'
import { ChunkedMarkdownParser } from '../src/renderer/src/chunked-markdown.ts'

const finish = (parse) => {
  for (;;) {
    const tree = parse.advance()
    if (tree) return tree
  }
}
const input = (text) => ({
  length: text.length,
  lineChunks: false,
  chunk: (from) => text.slice(from, from + 4096),
  read: (from, to) => text.slice(from, to),
})
const counts = () => ({
  parsedChunks: 0,
  parsedUnits: 0,
  scannedUnits: 0,
  reusedNodes: 0,
  builtGroups: 0,
})

test('a far jump uses the ready boundary index without a main-thread block scan', () => {
  const unit = '# heading\n\nparagraph words\n\n'
  const text = unit.repeat(Math.ceil((50 * 1024 * 1024) / unit.length))
  const base = parser.configure(GFM)
  const work = counts()
  const chunked = new ChunkedMarkdownParser(base, base, { probe: work })
  const source = input(text)
  const index = chunked.startBoundaryParse
    ? finish(chunked.startBoundaryParse(source, []))
    : finish(chunked.startChunkedParse(source, [], { from: 0, to: 8192 }))
  work.scannedUnits = 0
  const tree = finish(
    chunked.startChunkedParse(source, TreeFragment.addTree(index), {
      from: text.length - 8192,
      to: text.length,
    }),
  )
  assert.ok(tree.length === text.length)
  assert.equal(work.scannedUnits, 0)
})

test('suffix pages preserve exact boundaries without copying the unchanged prefix', () => {
  const text = '# heading🙂\n\nparagraph words\n\n'.repeat(20000)
  for (const ending of ['\n', '\r\n', '\r']) {
    const store = new SourceStore(text.replaceAll('\n', ending), {
      tabId: 'suffix',
      revision: 0,
    })
    const index = new MarkdownBoundaryIndex(store.snapshot(), configuration())
    drain(index)
    const requested = text.length - 150
    const pages = [...index.pages(requested)]
    const from = pages[0].from
    assert.ok(from > 0 && from <= requested)
    assert.ok(pages.length <= 2)
    assert.ok(pages.every((page) => page.from === from))
    const builder = new BoundaryTree(index.parser, text.length - from)
    for (const page of pages) builder.append(page.records)
    const parsed = finish(
      index.parser.startChunkedParse(
        input(text.slice(from)),
        TreeFragment.addTree(builder.finish()),
        { from: 0, to: text.length - from },
      ),
    )
    assert.deepEqual(
      shape(parsed),
      shape(boundaryParser(configuration()).parse(text.slice(from))),
    )
  }
})
