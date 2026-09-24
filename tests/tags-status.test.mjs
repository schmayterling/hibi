import assert from 'node:assert/strict'
import test from 'node:test'
import { createTagAnalysis } from '../src/addons/tags/analysis.ts'
import { tagIndex } from '../src/addons/tags/model.ts'
import { scheduleTagCounts, tagVersion } from '../src/addons/tags/schedule.ts'

const settle = () => new Promise((resolve) => setTimeout(resolve, 300))

test('panel and status reuse the active note result', () => {
  const parsed = []
  const analysis = createTagAnalysis((source) => {
    parsed.push(source)
    return [source.slice(1)]
  })
  analysis.remember('#one', ['one'])
  assert.deepEqual(analysis.parsePage('#one', '#one'), ['one'])
  assert.deepEqual(analysis.parsePage('#other', '#one'), ['other'])
  assert.deepEqual(analysis.get('#one'), ['one'])
  assert.deepEqual(analysis.parsePage('#two', '#two'), ['two'])
  assert.deepEqual(analysis.get('#two'), ['two'])
  assert.deepEqual(parsed, ['#other', '#two'])
})

test('open panel and status count parse an edited active note once', async () => {
  let parses = 0
  const analysis = createTagAnalysis((source) => {
    parses++
    return [source.slice(1)]
  })
  const cache = { workspaceId: undefined, pages: new Map() }
  let source = '#one'
  let page = { id: 'active', path: 'active.md', markdown: source }
  const index = () =>
    tagIndex('workspace', [page], cache, (markdown) =>
      analysis.parsePage(markdown, source),
    )
  const sent = []
  const published = []
  let key = 'active:1'
  const counter = scheduleTagCounts(
    () => ({ key, source }),
    (job) => {
      const tags = analysis.get(job.source)
      if (tags) counter.receive({ key: job.key, tags })
      else sent.push(job)
    },
    (tags) => published.push(tags),
  )
  try {
    index()
    counter.refresh(key)
    await settle()
    source = '#two'
    page = { ...page, markdown: source }
    key = 'active:2'
    index()
    counter.refresh(key)
    await settle()
    assert.equal(parses, 2)
    assert.deepEqual(sent, [])
    assert.deepEqual(published, [['one'], ['two']])
  } finally {
    counter.stop()
  }
})

test('tag count key survives tab switches but advances with content', () => {
  const first = { tabId: 'a', id: 'note-a', revision: 1, contentVersion: 4 }
  assert.equal(tagVersion(first), tagVersion({ ...first, revision: 9 }))
  assert.notEqual(
    tagVersion(first),
    tagVersion({ ...first, contentVersion: 5 }),
  )
  assert.notEqual(tagVersion(first), tagVersion({ ...first, tabId: 'b' }))
  assert.notEqual(tagVersion(first), tagVersion({ ...first, id: 'note-b' }))
})

test('returning to a cached tab does not read or reparse its source', async () => {
  let current = {
    key: tagVersion({ tabId: 'a', id: 'note-a', contentVersion: 4 }),
    source: '#a',
  }
  let reads = 0
  const sent = []
  const published = []
  const counter = scheduleTagCounts(
    () => {
      reads++
      return current
    },
    (job) => sent.push(job),
    (tags) => published.push(tags),
  )
  try {
    counter.refresh(current.key)
    await settle()
    counter.receive({ key: current.key, tags: ['a'] })
    current = {
      key: tagVersion({ tabId: 'b', id: 'note-b', contentVersion: 2 }),
      source: '#b',
    }
    counter.refresh(current.key)
    await settle()
    counter.receive({ key: current.key, tags: ['b'] })
    current = {
      key: tagVersion({ tabId: 'a', id: 'note-a', contentVersion: 4 }),
      source: '#a',
    }
    counter.refresh(current.key)
    assert.deepEqual(published, [['a'], ['b'], ['a']])
    assert.equal(reads, 2)
    assert.deepEqual(
      sent.map((job) => job.source),
      ['#a', '#b'],
    )
  } finally {
    counter.stop()
  }
})

test('worker failure releases pending work and retries once', async () => {
  let current = { key: 'a', source: '#a' }
  const sent = []
  const published = []
  const counter = scheduleTagCounts(
    () => current,
    (job) => sent.push(job),
    (tags) => published.push(tags),
  )
  try {
    counter.refresh('a')
    await settle()
    assert.equal(sent.length, 1)
    counter.fail()
    assert.equal(sent.length, 2)
    counter.receive({ key: 'stale', tags: ['stale'] })
    assert.deepEqual(published, [])
    counter.fail()
    assert.deepEqual(published, [[]])
    current = { key: 'b', source: '#b' }
    counter.refresh('b')
    await settle()
    assert.equal(sent.length, 3)
    counter.receive({ key: 'b', tags: ['b'] })
    assert.deepEqual(published, [[], ['b']])
  } finally {
    counter.stop()
  }
})
