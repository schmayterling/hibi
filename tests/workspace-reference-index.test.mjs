import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkspaceReferenceIndex } from '../src/main/workspace-reference-index.ts'
import { noteReferences } from '../src/shared/note-links.ts'

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
  })
  assert.deepEqual(index.backlinks('b.md', 1, 1), {
    items: ['c.md'],
    hasMore: false,
  })
})
