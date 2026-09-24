import assert from 'node:assert/strict'
import test from 'node:test'
import { tagIndex } from '../src/addons/tags/model.ts'
import { noteTags } from '../src/addons/tags/syntax.ts'

test('tag index reuses unchanged pages, reparses edits, and drops deleted pages', () => {
  const cache = { workspaceId: undefined, pages: new Map() }
  const parsed = []
  const parse = (source) => {
    parsed.push(source)
    return noteTags(source)
  }
  const pages = [
    { path: 'a.md', markdown: '#one' },
    { path: 'b.md', markdown: '#two' },
  ]
  assert.deepEqual(tagIndex('workspace-a', pages, cache, parse), [
    ['one', ['a.md']],
    ['two', ['b.md']],
  ])
  assert.equal(parsed.length, 2)

  assert.deepEqual(
    tagIndex(
      'workspace-a',
      pages.map((page) => ({ ...page })),
      cache,
      parse,
    ),
    [
      ['one', ['a.md']],
      ['two', ['b.md']],
    ],
  )
  assert.equal(parsed.length, 2)

  assert.deepEqual(
    tagIndex(
      'workspace-a',
      [{ path: 'a.md', markdown: '#three' }, { ...pages[1] }],
      cache,
      parse,
    ),
    [
      ['three', ['a.md']],
      ['two', ['b.md']],
    ],
  )
  assert.equal(parsed.length, 3)

  tagIndex('workspace-a', [{ ...pages[1] }], cache, parse)
  assert.deepEqual([...cache.pages.keys()], ['b.md'])
  assert.equal(parsed.length, 3)

  tagIndex('workspace-b', [{ ...pages[1] }], cache, parse)
  assert.equal(parsed.length, 4)
})
