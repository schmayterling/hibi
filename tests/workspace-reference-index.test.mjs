import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkspaceReferenceIndex } from '../src/main/workspace-reference-index.ts'
import {
  noteBasenames,
  noteReferences,
  wikiTarget,
} from '../src/shared/note-links.ts'

const workspace = { workspaceId: 'notes', workspaceGeneration: 1 }
const page = (path, markdown = '') => ({ path, markdown })

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

test('lazy tag, property, heading and path queries invalidate changed notes', () => {
  const index = new WorkspaceReferenceIndex()
  index.apply(workspace, [
    page('a.md', '---\ntitle: Alpha\ntags: [one, two]\n---\n# Intro\n\n#work'),
    page('plain.txt', '#work'),
  ])
  assert.deepEqual(index.tagged('work', 0, 10).items, ['a.md'])
  assert.deepEqual(index.tags(0, 10).items, [{ tag: 'work', count: 1 }])
  assert.deepEqual(index.property('tags', 'two', 0, 10).items, ['a.md'])
  assert.deepEqual(index.headings('a.md', 0, 10).items, [
    { depth: 1, text: 'Intro' },
  ])
  assert.deepEqual(index.searchPaths('A.MD', 0, 10).items, ['a.md'])
  index.apply(workspace, [
    page('a.md', '---\ntitle: Beta\n---\n# Changed\n\n#other'),
    page('plain.txt', '#work'),
  ])
  assert.deepEqual(index.tagged('work', 0, 10).items, [])
  assert.deepEqual(index.tagged('other', 0, 10).items, ['a.md'])
  assert.deepEqual(index.tags(0, 10).items, [{ tag: 'other', count: 1 }])
  assert.deepEqual(index.property('title', 'Alpha', 0, 10).items, [])
  assert.deepEqual(index.headings('a.md', 0, 10).items, [
    { depth: 1, text: 'Changed' },
  ])
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
    emitted: 0,
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
  assert.equal(result.capReached, false)
  const capped = index.graph({ ...position, pathIndex: 0, emitted: 9999 }, 2)
  assert.equal(capped.capReached, true)
  assert.equal(capped.hasMore, false)
})

test('tag summaries cap distinct names while exact queries still find later tags', () => {
  const index = new WorkspaceReferenceIndex()
  index.apply(workspace, [
    page('a.md', Array.from({ length: 2001 }, (_, i) => `#tag${i}`).join(' ')),
  ])
  const summary = index.tags(0, 100)
  assert.equal(summary.capReached, true)
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

test('oversized frontmatter never reaches reference or tag parsers', () => {
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
  assert.equal(parses, 1)
  assert.equal(index.isComplete(), false)
  assert.deepEqual(index.links('a.md', 0, 10).items, [])
  assert.deepEqual(index.tagged('work', 0, 10).items, [])
  assert.equal(index.property('long', 'x', 0, 10).complete, false)
  assert.equal(index.headings('a.md', 0, 10).complete, false)
  index.apply(workspace, [page('a.md', '# Heading [[b]] #work'), page('b.md')])
  assert.equal(index.isComplete(), true)
  assert.deepEqual(index.links('a.md', 0, 10).items, ['b.md'])
  index.apply(workspace, [page('a.md', '---\n[B](b.md)'), page('b.md')])
  assert.equal(index.isComplete(), true)
  assert.deepEqual(index.links('a.md', 0, 10).items, ['b.md'])
})

test('text search resumes long notes and finds boundary-spanning matches', () => {
  const index = new WorkspaceReferenceIndex()
  index.apply(workspace, [
    page('a.md', `${'x'.repeat(65_534)}needle${'y'.repeat(1_100_000)}`),
    page('b.md', 'needle'),
  ])
  let result = index.searchText('NEEDLE', { pathIndex: 0, sourceOffset: 0 }, 1)
  assert.deepEqual(result.items, ['a.md'])
  assert.equal(result.hasMore, true)
  result = index.searchText('NEEDLE', result.position, 1)
  assert.deepEqual(result.items, ['b.md'])
  assert.equal(result.hasMore, false)
})
