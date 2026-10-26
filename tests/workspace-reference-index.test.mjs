import assert from 'node:assert/strict'
import test from 'node:test'
import { parseWorkspaceMetadata } from '../src/main/workspace-index-metadata.ts'
import { parseWorkspaceMetadataFallback } from '../src/main/workspace-metadata-fallback.ts'
import { WorkspaceReferenceIndex } from '../src/main/workspace-reference-index.ts'
import {
  localTarget,
  noteBasenames,
  noteReferences,
  wikiTarget,
} from '../src/shared/note-links.ts'
import { defaultNoteSyntax } from '../src/shared/note-syntax.ts'

const workspace = { workspaceId: 'notes', workspaceGeneration: 1 }
const page = (path, markdown = '') => ({ path, markdown })

test('path filters equate final and medial sigma without changing path identities', async () => {
  const index = new WorkspaceReferenceIndex()
  const paths = ['upper/ΟΔΟΣ.md', 'final/οδος.md', 'medial/οδοσ.md']
  index.apply(
    workspace,
    paths.map((path) => page(path)),
  )
  for (const query of ['ΟΔΟΣ', 'οδος', 'οδοσ', 'Σ', 'σ', 'ς']) {
    assert.deepEqual(index.searchPaths(query, 0, 10).items, [...paths].sort())
    assert.deepEqual(
      (await index.searchPathsCooperatively(query, 0, 10, () => true)).items,
      [...paths].sort(),
    )
  }
})

test('reference index parses only changed content and updates reverse links', () => {
  let parses = 0
  const index = new WorkspaceReferenceIndex((source) => {
    parses++
    return noteReferences(source)
  })
  const initial = [page('a.md', '[B](b.md) [[c]]'), page('b.md'), page('c.md')]
  assert.deepEqual(index.apply(workspace, initial), { parsed: 3, resolved: 3 })
  assert.deepEqual(index.backlinks('b.md', 0, 10).items, ['a.md'])
  assert.deepEqual(index.links('a.md', 0, 10).items, ['b.md', 'c.md'])
  index.apply(workspace, initial)
  assert.equal(parses, 3)
  const changed = [page('a.md', '[[c]]'), ...initial.slice(1)]
  assert.deepEqual(index.apply(workspace, changed), { parsed: 1, resolved: 1 })
  assert.deepEqual(index.backlinks('b.md', 0, 10).items, [])
  assert.deepEqual(index.backlinks('c.md', 0, 10).items, ['a.md'])
  assert.equal(parses, 4)
})

test('unchanged source reparses when built-in file syntax changes', () => {
  let parses = 0
  const index = new WorkspaceReferenceIndex((source, syntax) => {
    parses++
    return noteReferences(source, syntax)
  })
  const pages = [
    page('a.md', '[B](b.md) [[c]] #work'),
    page('b.md'),
    page('c.md'),
  ]
  const profile = (key, settings) => (page) => ({
    key: page.path === 'a.md' ? key : 'default',
    settings: page.path === 'a.md' ? settings : defaultNoteSyntax,
    complete: true,
    unsupported: false,
  })
  index.apply(workspace, pages, profile('default', defaultNoteSyntax))
  assert.deepEqual(index.links('a.md', 0, 10).items, ['b.md', 'c.md'])
  assert.deepEqual(index.tagged('work', 0, 10).items, ['a.md'])
  assert.equal(parses, 3)
  const noWiki = { ...defaultNoteSyntax, wikilinks: false }
  index.apply(workspace, pages, profile('no-wiki', noWiki))
  assert.deepEqual(index.links('a.md', 0, 10).items, ['b.md'])
  assert.deepEqual(index.backlinks('c.md', 0, 10).items, [])
  assert.equal(parses, 4)
  const noLinksOrTags = {
    ...noWiki,
    hashtags: false,
    disabledFeatures: ['core.links'],
  }
  index.apply(workspace, pages, profile('no-links-or-tags', noLinksOrTags))
  assert.deepEqual(index.links('a.md', 0, 10).items, [])
  assert.deepEqual(index.tagged('work', 0, 10).items, [])
  assert.equal(parses, 5)
  index.apply(workspace, pages, profile('no-links-or-tags', noLinksOrTags))
  assert.equal(parses, 5)
})

test('path changes re-resolve cached references and ambiguity without reparsing', () => {
  let parses = 0
  const index = new WorkspaceReferenceIndex((source) => {
    parses++
    return noteReferences(source)
  })
  const source = page('a.md', '[[note]] [[new]]')
  index.apply(workspace, [source, page('x/note.md')])
  assert.deepEqual(index.links('a.md', 0, 10).items, ['x/note.md'])
  const afterAdd = index.apply(workspace, [
    source,
    page('x/note.md'),
    page('y/note.md'),
    page('new.md'),
  ])
  assert.deepEqual(afterAdd, { parsed: 2, resolved: 4 })
  assert.deepEqual(index.links('a.md', 0, 10).items, ['new.md'])
  assert.deepEqual(index.backlinks('x/note.md', 0, 10).items, [])
  assert.equal(index.resolve('a.md', 'note', 'wiki'), null)
  assert.equal(index.resolve('a.md', 'new', 'wiki'), 'new.md')
  assert.equal(parses, 4)
})

test('generation replacement clears reverse links and bounds pages', () => {
  const index = new WorkspaceReferenceIndex()
  index.apply(workspace, [page('a.md', '[[b]]'), page('b.md')])
  assert.deepEqual(index.backlinks('b.md', 0, 10).items, ['a.md'])
  index.apply({ ...workspace, workspaceGeneration: 2 }, [page('b.md')])
  assert.deepEqual(index.backlinks('b.md', 0, 10).items, [])
  assert.equal(index.has('a.md'), false)
  index.apply(workspace, [
    page('a.md', '[[b]]'),
    page('b.md'),
    page('c.md', '[[b]]'),
  ])
  assert.deepEqual(index.backlinks('b.md', 0, 1), {
    items: ['a.md'],
    hasMore: true,
    nextOffset: 1,
  })
  assert.deepEqual(index.backlinks('b.md', 1, 1), {
    items: ['c.md'],
    hasMore: false,
    nextOffset: 2,
  })
})

test('indexed basename lookup preserves wiki resolution semantics', () => {
  const paths = new Set([
    'notes/start.md',
    'notes/next.md',
    'root.md',
    'x/note.md',
    'y/note.md',
  ])
  const basenames = noteBasenames(paths)
  for (const target of [
    'next',
    'root',
    'note',
    'missing',
    'notes/next',
    '#Heading',
  ])
    assert.equal(
      wikiTarget('notes/start.md', target, paths, basenames),
      wikiTarget('notes/start.md', target, paths),
    )
})

test('non-markdown pages do not add source links and result bytes are capped', () => {
  const index = new WorkspaceReferenceIndex()
  const longPaths = Array.from(
    { length: 100 },
    (_, number) => `folder-${number}/${'a'.repeat(190)}/${'b'.repeat(190)}.md`,
  )
  index.apply(workspace, [
    page('target.md'),
    page('plain.txt', '[[target]]'),
    ...longPaths.map((path) => page(path, '[[target]]')),
  ])
  const first = index.backlinks('target.md', 0, 100)
  assert.equal(first.items.includes('plain.txt'), false)
  assert.equal(first.hasMore, true)
  assert.ok(Buffer.byteLength(first.items.join('')) <= 32 * 1024)
  const second = index.backlinks('target.md', first.nextOffset, 100)
  assert.equal(first.items.length + second.items.length, 100)
  assert.equal(second.hasMore, false)
})

test('lazy tag, property and path queries invalidate changed notes', () => {
  const index = new WorkspaceReferenceIndex()
  index.apply(workspace, [
    page('a.md', '---\ntitle: Alpha\ntags: [one, two]\n---\n# Intro\n\n#work'),
    page('plain.txt', '#work'),
  ])
  assert.deepEqual(index.tagged('work', 0, 10).items, ['a.md'])
  assert.deepEqual(index.tags(0, 10).items, [{ tag: 'work', count: 1 }])
  assert.deepEqual(index.property('tags', 'two', 0, 10).items, ['a.md'])
  assert.deepEqual(index.searchPaths('A.MD', 0, 10).items, ['a.md'])
  index.apply(workspace, [
    page('a.md', '---\ntitle: Beta\n---\n# Changed\n\n#other'),
    page('plain.txt', '#work'),
  ])
  assert.deepEqual(index.tagged('work', 0, 10).items, [])
  assert.deepEqual(index.tagged('other', 0, 10).items, ['a.md'])
  assert.deepEqual(index.tags(0, 10).items, [{ tag: 'other', count: 1 }])
  assert.deepEqual(index.property('title', 'Alpha', 0, 10).items, [])
})

test('cooperative metadata work yields between batches and publishes whole snapshots', async () => {
  const index = new WorkspaceReferenceIndex()
  index.apply(workspace, [page('old.md', '[[target]]'), page('target.md')])
  const pages = Array.from({ length: 128 }, (_, number) =>
    page(
      `notes/${number}.md`,
      `---\nbucket: ${number % 2}\n---\n#work [[target]]`,
    ),
  )
  let applySettled = false
  const applying = index
    .applyCooperatively(workspace, pages)
    .finally(() => (applySettled = true))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(applySettled, false)
  assert.deepEqual(index.backlinks('target.md', 0, 10).items, ['old.md'])
  assert.deepEqual(await applying, { parsed: 128, resolved: 128 })
  assert.deepEqual(index.backlinks('target.md', 0, 200).items, [])

  const tagged = index.taggedCooperatively('work', 0, 200)
  assert.deepEqual((await tagged)?.items, pages.map((item) => item.path).sort())

  let propertySettled = false
  const properties = index
    .propertyCooperatively('bucket', 1, 0, 200)
    .finally(() => (propertySettled = true))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(propertySettled, false)
  assert.deepEqual(
    (await properties)?.items,
    pages
      .filter((_, number) => number % 2 === 1)
      .map((item) => item.path)
      .sort(),
  )
})

test('cooperative metadata yields after a slow page and publishes the completed snapshot', async (t) => {
  let clock = 0
  let parsed = 0
  const yielded = []
  t.mock.method(performance, 'now', () => clock)
  const index = new WorkspaceReferenceIndex(
    (source) => {
      parsed++
      clock += 5
      return noteReferences(source)
    },
    async () => {
      yielded.push(parsed)
    },
  )
  index.apply(workspace, [page('old.md', '[[target]]'), page('target.md')])
  parsed = 0
  const applying = index.applyCooperatively(workspace, [
    page('first.md', '[[second]]'),
    page('second.md'),
  ])
  assert.equal(parsed, 1)
  assert.deepEqual(yielded, [1])
  assert.deepEqual(index.backlinks('target.md', 0, 10).items, ['old.md'])
  assert.deepEqual(await applying, { parsed: 2, resolved: 2 })
  assert.deepEqual(yielded, [1, 2])
  assert.deepEqual(index.backlinks('second.md', 0, 10).items, ['first.md'])
  assert.equal(index.has('old.md'), false)
})

for (const replacing of [false, true]) {
  test(`slow-page work stops before another parse after ${replacing ? 'snapshot replacement' : 'cancellation'}`, async (t) => {
    let clock = 0
    let parsed = 0
    let current = true
    let release
    t.mock.method(performance, 'now', () => clock)
    const index = new WorkspaceReferenceIndex(
      (source) => {
        parsed++
        clock += 5
        return noteReferences(source)
      },
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    index.apply(workspace, [page('old.md', '[[target]]'), page('target.md')])
    parsed = 0
    const applying = index.applyCooperatively(
      workspace,
      [page('first.md', '[[second]]'), page('second.md')],
      undefined,
      () => current,
    )
    assert.equal(parsed, 1)
    assert.deepEqual(index.backlinks('target.md', 0, 10).items, ['old.md'])
    if (replacing)
      index.apply(workspace, [
        page('replacement.md', '[[target]]'),
        page('target.md'),
      ])
    else current = false
    const beforeResume = parsed
    release()
    assert.equal(await applying, null)
    assert.equal(parsed, beforeResume)
    assert.deepEqual(index.backlinks('target.md', 0, 10).items, [
      replacing ? 'replacement.md' : 'old.md',
    ])
  })
}

test('cooperative metadata cancels stale caches and cannot overwrite an overlapping apply', async (t) => {
  t.mock.method(performance, 'now', () => 0)
  const pages = Array.from({ length: 128 }, (_, number) =>
    page(`notes/${number}.md`, `---\nbucket: 1\n---\n#new [[target]]`),
  )
  const index = new WorkspaceReferenceIndex()
  index.apply(workspace, [page('old.md', '#old [[target]]'), page('target.md')])
  assert.deepEqual(index.tagged('old', 0, 10).items, ['old.md'])
  assert.equal(await index.taggedCooperatively('old', 0, 10, () => false), null)
  assert.equal(
    await index.tagsCooperatively(0, 10, undefined, () => false),
    null,
  )
  assert.equal(
    await index.propertyCooperatively('bucket', 1, 0, 10, () => false),
    null,
  )

  const staleTags = new WorkspaceReferenceIndex()
  staleTags.apply(workspace, pages)
  const stale = staleTags.taggedCooperatively('new', 0, 200)
  staleTags.apply(workspace, [page('replacement.md', '#replacement')])
  assert.equal(await stale, null)
  assert.deepEqual(staleTags.tagged('replacement', 0, 10).items, [
    'replacement.md',
  ])

  const gates = []
  const oldPages = Array.from({ length: 128 }, (_, number) =>
    page(`notes/${number}.md`, '#old [[target]]'),
  )
  const overlapping = new WorkspaceReferenceIndex(
    undefined,
    () =>
      new Promise((resolve) => {
        gates.push({ resolve, released: false })
      }),
  )
  overlapping.apply(workspace, oldPages)
  let applySettled = false
  const applying = overlapping
    .applyCooperatively(workspace, pages)
    .finally(() => (applySettled = true))
  let querySettled = false
  const querying = overlapping
    .taggedCooperatively('old', 0, 10)
    .finally(() => (querySettled = true))
  await Promise.resolve()
  assert.equal(applySettled, false)
  assert.equal(querySettled, false)
  for (let turn = 0; !querySettled; turn++) {
    assert.ok(turn < 20, 'query must settle after its bounded yields')
    const gate = gates.find(
      (candidate, index) => index > 0 && !candidate.released,
    )
    if (gate) {
      gate.released = true
      gate.resolve()
    }
    await Promise.resolve()
  }
  assert.deepEqual(
    (await querying)?.items,
    oldPages
      .map((item) => item.path)
      .sort()
      .slice(0, 10),
  )
  for (let turn = 0; !applySettled; turn++) {
    assert.ok(turn < 20, 'apply must settle after its bounded yields')
    const gate = gates.find((candidate) => !candidate.released)
    if (gate) {
      gate.released = true
      gate.resolve()
    }
    await Promise.resolve()
  }
  assert.deepEqual(await applying, { parsed: 128, resolved: 128 })
  assert.deepEqual(
    overlapping.tagged('new', 0, 200).items,
    pages.map((item) => item.path).sort(),
  )
})

test('graph pages contain every node and resolved link without another parse', () => {
  let parses = 0
  const index = new WorkspaceReferenceIndex((source) => {
    parses++
    return noteReferences(source)
  })
  index.apply(workspace, [
    page('a.md', '[[b]]'),
    page('b.md', '[[a]]'),
    page('plain.txt'),
  ])
  const items = []
  let position = {
    pathIndex: 0,
    targetIndex: 0,
    nodeEmitted: false,
  }
  let result
  do {
    result = index.graph(position, 2)
    items.push(...result.items)
    position = result.position
  } while (result.hasMore)
  assert.deepEqual(items, [
    { kind: 'node', path: 'a.md' },
    { kind: 'edge', source: 'a.md', target: 'b.md' },
    { kind: 'node', path: 'b.md' },
    { kind: 'edge', source: 'b.md', target: 'a.md' },
    { kind: 'node', path: 'plain.txt' },
  ])
  assert.equal(parses, 2)
})

test('graph pages sort the targets of a note once per build, not once per page', () => {
  const index = new WorkspaceReferenceIndex()
  const leaves = Array.from(
    { length: 1000 },
    (_, number) => `leaf${String(number).padStart(4, '0')}`,
  )
  const hub = page('hub.md', leaves.map((leaf) => `[[${leaf}]]`).join(' '))
  index.apply(workspace, [hub, ...leaves.map((leaf) => page(`${leaf}.md`))])
  const sort = Array.prototype.sort
  let hubSorts = 0
  const read = () => {
    let position = { pathIndex: 0, targetIndex: 0, nodeEmitted: false }
    let result,
      pages = 0,
      edges = 0
    do {
      result = index.graph(position, 100)
      edges += result.items.filter((item) => item.kind === 'edge').length
      position = result.position
      pages++
    } while (result.hasMore)
    return { pages, edges }
  }
  Array.prototype.sort = function (...args) {
    if (this.length === 1000) hubSorts++
    return sort.apply(this, args)
  }
  try {
    // The hub's 1,000 links span about ten pages; two full reads sort them once.
    assert.deepEqual(read(), { pages: 21, edges: 1000 })
    assert.deepEqual(read(), { pages: 21, edges: 1000 })
    assert.equal(hubSorts, 1)
    // A rebuild that changes the hub's links sorts the new targets once.
    index.apply(workspace, [
      page('hub.md', `${hub.markdown} `),
      ...leaves.map((leaf) => page(`${leaf}.md`)),
    ])
    read()
    read()
    assert.equal(hubSorts, 2)
  } finally {
    Array.prototype.sort = sort
  }
})

test('tag summaries retain distinct names beyond the former cap', () => {
  const index = new WorkspaceReferenceIndex()
  index.apply(workspace, [
    page('a.md', Array.from({ length: 2001 }, (_, i) => `#tag${i}`).join(' ')),
  ])
  const summary = index.tags(0, 100)
  assert.equal(summary.capReached, false)
  assert.equal(summary.hasMore, true)
  assert.deepEqual(index.tagged('tag2000', 0, 10).items, ['a.md'])
})

test('tag suggestions match prefixes and rank by note count then name', () => {
  const index = new WorkspaceReferenceIndex()
  index.apply(workspace, [
    page('a.md', '#Work #work/task #work/idea #work/low'),
    page('b.md', '#WORK #work/idea'),
    page('c.md', '#work/task #personal'),
  ])
  assert.deepEqual(index.tags(0, 10, 'work').items, [
    { tag: 'work', count: 2 },
    { tag: 'work/idea', count: 2 },
    { tag: 'work/task', count: 2 },
    { tag: 'work/low', count: 1 },
  ])
  assert.deepEqual(index.tags(1, 1, 'work'), {
    items: [{ tag: 'work/idea', count: 2 }],
    hasMore: true,
    nextOffset: 2,
    capReached: false,
  })
  assert.deepEqual(index.tags(0, 10, 'idea').items, [])
})

test('long tags remain in the index and bounded summary pages', () => {
  const index = new WorkspaceReferenceIndex()
  index.apply(workspace, [page('a.md', `#${'a'.repeat(129)} #work`)])
  assert.deepEqual(index.tags(0, 10), {
    items: [
      { tag: 'a'.repeat(129), count: 1 },
      { tag: 'work', count: 1 },
    ],
    hasMore: false,
    nextOffset: 2,
    capReached: false,
  })
})

test('large frontmatter preserves references, tags, and properties', () => {
  let parses = 0
  const index = new WorkspaceReferenceIndex((source) => {
    parses++
    return noteReferences(source)
  })
  index.apply(workspace, [
    page(
      'a.md',
      `---\nlong: ${'x'.repeat(100_000)}\n---\n# Heading [[b]] #work`,
    ),
    page('b.md'),
  ])
  assert.equal(parses, 2)
  assert.equal(index.isComplete(), true)
  assert.deepEqual(index.links('a.md', 0, 10).items, ['b.md'])
  assert.deepEqual(index.tagged('work', 0, 10).items, ['a.md'])
  assert.equal(
    index.property('long', 'x'.repeat(100_000), 0, 10).items[0],
    'a.md',
  )
  index.apply(workspace, [page('a.md', '# Heading [[b]] #work'), page('b.md')])
  assert.equal(index.isComplete(), true)
  assert.deepEqual(index.links('a.md', 0, 10).items, ['b.md'])
  index.apply(workspace, [page('a.md', '---\n[B](b.md)'), page('b.md')])
  assert.equal(index.isComplete(), true)
  assert.deepEqual(index.links('a.md', 0, 10).items, ['b.md'])
})

test('workspace metadata indexes more than 2000 documents and continues past offset 2100', async () => {
  const index = new WorkspaceReferenceIndex()
  const pages = Array.from({ length: 2101 }, (_, i) =>
    page(`note-${String(i).padStart(5, '0')}.md`, '#work [[target]]'),
  )
  await index.applyCooperatively(workspace, [...pages, page('target.md')])
  assert.deepEqual(index.backlinks('target.md', 2100, 100), {
    items: ['note-02100.md'],
    hasMore: false,
    nextOffset: 2101,
  })
  assert.equal(index.isComplete(), true)
})

test('resident reference index retains derived metadata without full source text', () => {
  const source = `# heading\n\n#work [[target]]\n\n${'body '.repeat(20000)}`
  const index = new WorkspaceReferenceIndex()
  index.apply(workspace, [page('source.md', source), page('target.md')])
  const retained = JSON.stringify(
    [...index.documents.values()],
    (_key, value) => (value instanceof Set ? [...value] : value),
  )
  assert.ok(retained.length < source.length / 10)
  assert.equal(retained.includes('body body body'), false)
  assert.deepEqual(index.backlinks('target.md', 0, 10).items, ['source.md'])
})

test('continuation pages reuse sorted reference and property views', (t) => {
  const index = new WorkspaceReferenceIndex()
  const pages = Array.from({ length: 1000 }, (_, i) =>
    page(
      `note-${String(i).padStart(4, '0')}.md`,
      '---\nbucket: 1\n---\n[[target]]',
    ),
  )
  index.apply(workspace, [...pages, page('target.md')])
  let comparisons = 0
  const original = String.prototype.localeCompare
  t.mock.method(String.prototype, 'localeCompare', function (...args) {
    comparisons++
    return original.apply(this, args)
  })
  index.backlinks('target.md', 0, 100)
  assert.ok(comparisons > 0)
  comparisons = 0
  assert.equal(index.backlinks('target.md', 900, 100).items.length, 100)
  assert.equal(comparisons, 0)
  index.property('bucket', 1, 0, 100)
  comparisons = 0
  assert.equal(index.property('bucket', 1, 900, 100).items.length, 100)
  assert.equal(comparisons, 0)
})

test('concurrent tag consumers reuse one prepared tag index', async () => {
  const syntax = {
    settings: defaultNoteSyntax,
    key: 'default',
    complete: true,
    unsupported: false,
  }
  let traversals = 0
  const pages = Array.from({ length: 64 }, (_, i) => {
    const source = page(`note-${i}.md`, '#work')
    const metadata = parseWorkspaceMetadata(source, syntax)
    const iterate = metadata.tags[Symbol.iterator]
    Object.defineProperty(metadata.tags, Symbol.iterator, {
      value: function* () {
        traversals++
        yield* iterate.call(this)
      },
    })
    return { path: source.path, version: 'one', syntax, metadata }
  })
  const index = new WorkspaceReferenceIndex()
  const stream = async function* () {
    yield* pages
  }
  await index.applyMetadataCooperatively(workspace, stream())
  const results = await Promise.all(
    Array.from({ length: 10 }, () => index.taggedCooperatively('work', 0, 100)),
  )
  assert.ok(results.every((result) => result.items.length === 64))
  assert.equal(traversals, 64)
  await index.applyMetadataCooperatively(workspace, stream())
  assert.equal(traversals, 64)
})

test('link normalization preserves root, encoded filenames and wiki heading semantics', () => {
  const paths = new Set([
    'docs/from.md',
    'docs/next.md',
    'root.md',
    'a#b.md',
    'percent%.md',
    '.md',
  ])
  for (const [href, expected] of [
    ['../root.md#heading', 'root.md'],
    ['./next.md?view=source', 'docs/next.md'],
    ['/a%23b.md', 'a#b.md'],
    ['/percent%25.md', 'percent%.md'],
    ['../../../root.md', null],
    ['https://example.com/root.md', null],
    ['/', '.md'],
  ])
    assert.equal(localTarget('docs/from.md', href, paths), expected)
  for (const [href, expected] of [
    ['next', 'docs/next.md'],
    [' /root#heading ', 'root.md'],
    ['#heading', 'docs/from.md'],
    ['../root', null],
    ['./next', null],
    ['/', '.md'],
  ])
    assert.equal(wikiTarget('docs/from.md', href, paths), expected)
})

test('oversized tag fields advance their offsets and leave later records reachable', () => {
  const index = new WorkspaceReferenceIndex()
  index.apply(workspace, [
    page(
      'a.md',
      '#aaa #' +
        'b'.repeat(40000) +
        ' #ccc #ddd\n\n# one\n# ' +
        'x'.repeat(40000) +
        '\n# three\n# four',
    ),
  ])
  const tags = []
  let offset = 0
  let incomplete = false
  while (true) {
    const result = index.tags(offset, 1)
    tags.push(...result.items.map((item) => item.tag))
    incomplete ||= result.capReached
    assert.ok(!result.hasMore || result.nextOffset > offset)
    if (!result.hasMore) break
    offset = result.nextOffset
  }
  assert.deepEqual(tags, ['aaa', 'ccc', 'ddd'])
  assert.equal(incomplete, true)
})

test('fallback tags agree across delta and full builds', async () => {
  const index = new WorkspaceReferenceIndex()
  const input = {
    id: 'a'.repeat(64),
    path: 'slow.md',
    version: 'one',
    fingerprint: 'syntax',
    syntax: {
      settings: defaultNoteSyntax,
      key: 'default',
      complete: true,
      unsupported: false,
    },
  }
  const initial = parseWorkspaceMetadataFallback(input, ['#old'], () => {})
  const changed = parseWorkspaceMetadataFallback(
    { ...input, version: 'two' },
    ['#retained'],
    () => {},
  )
  const stream = async function* (item) {
    yield item
  }
  await index.applyMetadataCooperatively(workspace, stream(initial))
  await index.tagsCooperatively(0, 10)
  await index.applyDeltaCooperatively(workspace, [changed])
  const delta = await index.tagsCooperatively(0, 10)
  assert.deepEqual(delta.items, [{ tag: 'retained', count: 1 }])
  assert.deepEqual(index.tagged('old', 0, 10).items, [])
  assert.deepEqual(index.tagged('retained', 0, 10).items, ['slow.md'])
  assert.equal(index.isComplete(), false)
  assert.deepEqual(index.incompletePaths(), ['slow.md'])
  const full = new WorkspaceReferenceIndex()
  await full.applyMetadataCooperatively(workspace, stream(changed))
  assert.deepEqual(await full.tagsCooperatively(0, 10), delta)
  assert.deepEqual(full.tagged('retained', 0, 10).items, ['slow.md'])
  assert.equal(full.isComplete(), false)
})

test('draft deltas retain untouched documents and cached path views without walking the workspace', async () => {
  const index = new WorkspaceReferenceIndex()
  const syntax = {
    settings: defaultNoteSyntax,
    key: 'default',
    complete: true,
    unsupported: false,
  }
  const metadata = parseWorkspaceMetadata(page('a.md', '#shared'), syntax)
  const pages = Array.from({ length: 100000 }, (_, i) => ({
    path: `note-${i}.md`,
    version: 'one',
    syntax,
    metadata,
  }))
  await index.applyMetadataCooperatively(
    workspace,
    (async function* () {
      yield* pages
    })(),
  )
  assert.equal(index.tagPaths, null, 'path queries do not prepare tags')
  const untouched = index.documents.get('note-99999.md')
  const sorted = index.sortedPaths
  const pathView = await index.searchPathsCooperatively(
    'note-',
    0,
    10,
    () => true,
  )
  assert.equal(pathView.items.length, 10)
  let walks = 0
  const iterate = index.documents[Symbol.iterator]
  index.documents[Symbol.iterator] = function* () {
    walks++
    yield* iterate.call(this)
  }
  const changed = {
    path: 'note-0.md',
    version: 'two',
    syntax,
    metadata: parseWorkspaceMetadata(
      page('note-0.md', '#shared #new [[note-1]]'),
      syntax,
    ),
  }
  assert.deepEqual(await index.applyDeltaCooperatively(workspace, [changed]), {
    parsed: 1,
    resolved: 1,
  })
  assert.equal(walks, 0)
  assert.equal(index.documents.get('note-99999.md'), untouched)
  assert.equal(index.sortedPaths, sorted)
  assert.equal(index.tagPaths, null)
  assert.deepEqual(
    await index.searchPathsCooperatively('note-', 0, 10, () => true),
    pathView,
  )
  assert.equal(walks, 0)
  assert.deepEqual(index.links('note-0.md', 0, 10).items, ['note-1.md'])
  const tags = await index.tagsCooperatively(0, 10)
  assert.deepEqual(tags.items, [
    { tag: 'new', count: 1 },
    { tag: 'shared', count: 100000 },
  ])
  const before = walks
  await index.applyDeltaCooperatively(workspace, [
    {
      ...changed,
      version: 'three',
      metadata: parseWorkspaceMetadata(
        page('note-0.md', '#shared #next'),
        syntax,
      ),
    },
  ])
  assert.equal(walks, before)
  assert.deepEqual((await index.tagsCooperatively(0, 10)).items, [
    { tag: 'next', count: 1 },
    { tag: 'shared', count: 100000 },
  ])
})
