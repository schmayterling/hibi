import assert from 'node:assert/strict'
import test from 'node:test'
import MiniSearch from 'minisearch'
import { createSiteSearch } from '../src/site/search.ts'
import { pageTitle } from '../src/site/title.ts'

test('exported titles avoid markdown reads and legacy titles still derive from headings', () => {
  assert.equal(
    pageTitle({
      path: 'note.md',
      title: 'Saved title',
      get markdown() {
        throw new Error('unexpected title lex')
      },
    }),
    'Saved title',
  )
  assert.equal(
    pageTitle({ path: 'note.md', markdown: '# Old *title*' }),
    'Old title',
  )
  assert.equal(
    pageTitle({ path: '日本語.md', markdown: 'no heading' }),
    '日本語',
  )
})

test('versioned search never renders pages and memoizes repeated queries', async () => {
  const pages = Array.from({ length: 100 }, (_, i) => ({
    path: `${i}.md`,
    title: `Page ${i}`,
    description: '',
    markdown: 'needle body text',
    search: {
      version: 1,
      headings: [{ anchor: '日本語', label: '日本語 label', depth: 2 }],
    },
  }))
  const search = createSiteSearch(pages, () => {
    throw new Error('unexpected page render')
  })
  let calls = 0
  const original = MiniSearch.prototype.search
  MiniSearch.prototype.search = function (...args) {
    calls++
    return original.apply(this, args)
  }
  try {
    assert.equal(search.preload(), search.preload())
    const first = await search.find('needle')
    assert.equal(first.length, 50)
    for (let i = 0; i < 20; i++)
      assert.equal(await search.find('NEEDLE'), first)
    assert.equal(calls, 1)
    assert.equal((await search.find('日本語'))[0].anchor, '日本語')
    assert.equal(calls, 2)
  } finally {
    MiniSearch.prototype.search = original
    search.dispose()
  }
})

test('versioned search keeps frontmatter, link targets and image alt matches', async () => {
  const search = createSiteSearch(
    [
      {
        path: 'beds.md',
        title: 'Beds',
        description: '',
        markdown:
          '---\ntags: [gardening]\naliases: [raised-beds]\n---\n# Beds\n\n[guide](https://example.com/zebra) ![sunflower](img.png)',
        search: { version: 1, text: 'Beds guide', headings: [] },
      },
    ],
    () => [],
  )
  try {
    for (const query of ['gardening', 'raised', 'zebra', 'sunflower'])
      assert.equal((await search.find(query)).length, 1, query)
  } finally {
    search.dispose()
  }
})

test('legacy fallback hydrates in bounded tasks and disposed indexing stops', async () => {
  const pages = Array.from({ length: 200 }, (_, i) => ({
    path: `${i}.md`,
    title: `Page ${i}`,
    description: '',
    markdown: 'needle body text',
  }))
  let reads = 0,
    sinceTurn = 0,
    maximumBatch = 0,
    running = true,
    turns = 0
  const tick = () => {
    turns++
    maximumBatch = Math.max(maximumBatch, sinceTurn)
    sinceTurn = 0
    if (running) setImmediate(tick)
  }
  setImmediate(tick)
  const search = createSiteSearch(pages, () => {
    reads++
    sinceTurn++
    return []
  })
  try {
    await search.find('needle')
    assert.equal(reads, pages.length)
    assert.ok(turns > 1)
    assert.ok(maximumBatch <= 32, `${maximumBatch} pages without a task turn`)
    search.dispose()
    await assert.rejects(search.find('new query'), { name: 'AbortError' })
  } finally {
    running = false
    search.dispose()
  }
})

test('superseded queries do not rank after shared hydration finishes', async () => {
  const search = createSiteSearch(
    [
      {
        path: 'note.md',
        markdown: 'needle body',
        title: 'Note',
        description: '',
        search: { version: 1, headings: [] },
      },
    ],
    () => [],
  )
  const request = new AbortController()
  const stale = search.find('needle', request.signal)
  request.abort()
  try {
    await assert.rejects(stale, { name: 'AbortError' })
    assert.equal((await search.find('body')).length, 1)
  } finally {
    search.dispose()
  }
})
