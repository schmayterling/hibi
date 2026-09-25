import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { arch, cpus, platform, release } from 'node:os'
import { performance } from 'node:perf_hooks'
import { WorkspaceReferenceIndex } from '../src/main/workspace-reference-index.ts'
import { noteReferences } from '../src/shared/note-links.ts'

// Core metadata index only: no workspace scan, IPC, renderer, or disk I/O.
// Run alone with Node 24: node --expose-gc scripts/benchmark-foundations-metadata.mjs
const seed = 20260925
const runs = Number(
  process.argv.find((arg) => arg.startsWith('--runs='))?.slice(7) ?? 30,
)
if (!Number.isSafeInteger(runs) || runs < 5 || runs > 200)
  throw new Error('Use --runs=5..200.')

const workspace = { workspaceId: 'benchmark', workspaceGeneration: 1 }
const graphStart = {
  pathIndex: 0,
  targetIndex: 0,
  nodeEmitted: false,
  emitted: 0,
}
const searchStart = { pathIndex: 0, sourceOffset: 0 }
const path = (number) => `notes/n${String(number).padStart(4, '0')}.md`
const target = (number, offset, count) =>
  `n${String((number + offset + (seed % 13)) % count).padStart(4, '0')}.md`
const source = (number, count, changed = false) =>
  [
    '---',
    `bucket: ${changed ? 7 : number % 8}`,
    `title: Note ${number}`,
    '---',
    `# Note ${number}`,
    `#group${changed ? 1 : number % 16} #topic${number}`,
    ...[1, 3, 7, 11, 17].map(
      (offset) => `[next](${target(number, offset, count)})`,
    ),
    `[home](${changed ? 'n0002.md' : 'n0000.md'})`,
    number % 97 === 0 ? 'benchmark-needle' : 'ordinary note content',
  ].join('\n')

const percentile = (sorted, fraction) =>
  sorted[Math.ceil(sorted.length * fraction) - 1]
const distribution = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    n: sorted.length,
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    minMs: sorted[0],
    maxMs: sorted.at(-1),
  }
}
const measure = (samples, run) => {
  const start = performance.now()
  const result = run()
  samples.push(performance.now() - start)
  return result
}
const bytes = (value) => Buffer.byteLength(JSON.stringify(value))
const memory = () => {
  const { rss, heapUsed, heapTotal, external } = process.memoryUsage()
  return { rss, heapUsed, heapTotal, external }
}

const results = []
for (const count of [100, 2000]) {
  const pages = Array.from({ length: count }, (_, number) => ({
    path: path(number),
    markdown: source(number, count),
  }))
  const changedNumber = 16
  const changedPath = path(changedNumber)
  const changedPages = pages.with(changedNumber, {
    path: changedPath,
    markdown: source(changedNumber, count, true),
  })
  const fixtureSha256 = createHash('sha256')
    .update(pages.map((page) => `${page.path}\0${page.markdown}\0`).join(''))
    .digest('hex')
  const samples = {
    coldApply: [],
    oneNoteApply: [],
    queries: Object.fromEntries(
      [
        'links',
        'backlinks',
        'tag',
        'tagSummaries',
        'property',
        'headings',
        'searchPaths',
        'searchText',
        'graphPage',
      ].map((name) => [name, { firstAfterUpdate: [], repeat: [] }]),
    ),
  }
  const queries = {
    links: (index) => index.links(changedPath, 0, 100),
    backlinks: (index) => index.backlinks(path(0), 0, 100),
    tag: (index) => index.tagged('group0', 0, 100),
    tagSummaries: (index) => index.tags(0, 100, 'group'),
    property: (index) => index.property('bucket', 0, 0, 100),
    headings: (index) => index.headings(changedPath, 0, 100),
    searchPaths: (index) => index.searchPaths('n0', 0, 100),
    searchText: (index) =>
      index.searchText('benchmark-needle', searchStart, 50),
    graphPage: (index) => index.graph(graphStart, 100),
  }
  global.gc?.()
  const memoryBefore = memory()
  let finalIndex
  let parseCounts
  let resultShapes
  for (let run = 0; run < runs; run++) {
    let parserCalls = 0
    const index = new WorkspaceReferenceIndex((markdown) => {
      parserCalls++
      return noteReferences(markdown)
    })
    const cold = measure(samples.coldApply, () => index.apply(workspace, pages))
    assert.deepEqual(cold, { parsed: count, resolved: count })
    assert.ok(index.backlinks(path(0), 0, 100).items.includes(changedPath))
    const changed = measure(samples.oneNoteApply, () =>
      index.apply(workspace, changedPages),
    )
    assert.deepEqual(changed, { parsed: 1, resolved: 1 })
    assert.equal(parserCalls, count + 1)
    resultShapes = {}
    for (const [name, query] of Object.entries(queries)) {
      const durations = samples.queries[name]
      measure(durations.firstAfterUpdate, () => query(index))
      const result = measure(durations.repeat, () => query(index))
      resultShapes[name] = {
        resultBytes: bytes(result),
        returned: result.items?.length ?? null,
        hasMore: result.hasMore ?? null,
        capReached: result.capReached ?? null,
      }
    }
    assert.equal(
      index.links(changedPath, 0, 100).items.includes(path(0)),
      false,
    )
    assert.equal(
      index.backlinks(path(0), 0, 100).items.includes(changedPath),
      false,
    )
    assert.equal(
      index.tagged('group0', 0, 100).items.includes(changedPath),
      false,
    )
    parseCounts = {
      cold: cold.parsed,
      oneNoteUpdate: changed.parsed,
      parserCalls,
    }
    finalIndex = index
  }

  let graphPosition = graphStart
  let graphPages = 0
  let graphItems = 0
  let largestGraphPageBytes = 0
  let largestGraphItemsBytes = 0
  let graphEnd
  do {
    graphEnd = finalIndex.graph(graphPosition, 100)
    graphPages++
    graphItems += graphEnd.items.length
    largestGraphPageBytes = Math.max(largestGraphPageBytes, bytes(graphEnd))
    const itemBytes = graphEnd.items.reduce(
      (total, item) =>
        total +
        (item.kind === 'node'
          ? Buffer.byteLength(item.path)
          : Buffer.byteLength(item.source) + Buffer.byteLength(item.target)),
      0,
    )
    largestGraphItemsBytes = Math.max(largestGraphItemsBytes, itemBytes)
    assert.ok(itemBytes <= 32 * 1024)
    assert.ok(graphEnd.items.length <= 100)
    assert.ok(graphPages <= 200)
    graphPosition = graphEnd.position
  } while (graphEnd.hasMore)
  global.gc?.()
  const memoryWithIndex = memory()
  results.push({
    noteCount: count,
    fixtureSha256,
    inputBytes: pages.reduce(
      (total, page) => total + Buffer.byteLength(page.markdown),
      0,
    ),
    changedPages: 1,
    parseCounts,
    resolvedCounts: { cold: count, oneNoteUpdate: 1 },
    cacheInvalidationCount: 'not exposed',
    timings: {
      coldApply: distribution(samples.coldApply),
      oneNoteApply: distribution(samples.oneNoteApply),
      queries: Object.fromEntries(
        Object.entries(samples.queries).map(([name, durations]) => [
          name,
          {
            firstAfterUpdate: distribution(durations.firstAfterUpdate),
            repeat: distribution(durations.repeat),
          },
        ]),
      ),
    },
    observationsMs: samples,
    resultShapes,
    caps: {
      tagSummary: finalIndex.tags(0, 100).capReached,
      graph: {
        pages: graphPages,
        returned: graphItems,
        capReached: graphEnd.capReached,
        largestPageItemsBytes: largestGraphItemsBytes,
        largestPageJsonBytes: largestGraphPageBytes,
      },
    },
    memory: { beforeIndex: memoryBefore, withIndex: memoryWithIndex },
  })
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
console.log(
  JSON.stringify(
    {
      kind: 'in-process workspace metadata core',
      endpoints: {
        coldApply:
          'WorkspaceReferenceIndex.apply on new index and retained pages',
        oneNoteApply:
          'WorkspaceReferenceIndex.apply after one page source changed',
        queries:
          'direct index methods after update, in listed order; first and repeat call',
        resultBytes:
          'UTF-8 JSON bytes of direct method result, without IPC envelope',
        memory:
          'process.memoryUsage after fixture allocation and with final index held; process level, not index retained size',
        excluded:
          'filesystem scan, dirty overlay, IPC, renderer, paint, and addon execution',
      },
      head: git('rev-parse', 'HEAD'),
      dirty: git('status', '--short'),
      environment: {
        node: process.version,
        platform: platform(),
        release: release(),
        arch: arch(),
        cpu: cpus()[0]?.model,
        forcedGc: typeof global.gc === 'function',
      },
      fixture: { seed, sizes: [100, 2000], runs, markdownLinksPerNote: 6 },
      results,
    },
    null,
    2,
  ),
)
