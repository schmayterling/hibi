import { build } from 'esbuild'
import {
  BoundaryTree,
  boundaryRecords,
} from '../src/shared/chunked-markdown.ts'
import { MarkdownBoundaryIndex } from '../src/shared/markdown-boundary-index.ts'
import {
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
