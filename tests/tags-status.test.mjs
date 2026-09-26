import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { createTagAnalysis } from '../src/addons/tags/analysis.ts'
import { scheduleTagCounts, tagVersion } from '../src/addons/tags/schedule.ts'
import { defaultNoteSyntax } from '../src/shared/note-syntax.ts'

const settle = () => new Promise((resolve) => setTimeout(resolve, 300))

test('status cache keeps only the current source and syntax result', () => {
  const analysis = createTagAnalysis()
  analysis.remember('#one:frontmatter-on', ['one'])
  assert.deepEqual(analysis.get('#one:frontmatter-on'), ['one'])
  assert.equal(analysis.get('#one:frontmatter-off'), null)
  assert.equal(analysis.get('#other'), null)
  analysis.remember('#two', ['two'])
  assert.deepEqual(analysis.get('#two'), ['two'])
  assert.equal(analysis.get('#one'), null)
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
  assert.notEqual(
    tagVersion(first, 'frontmatter-on'),
    tagVersion(first, 'frontmatter-off'),
  )
})

test('tag count worker uses active Frontmatter syntax', async () => {
  const bundle = await build({
    entryPoints: ['src/addons/tags/count.worker.ts'],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    write: false,
  })
  const replies = []
  const worker = { postMessage: (reply) => replies.push(reply) }
  new Function('self', bundle.outputFiles[0].text)(worker)
  const source = '---\ntag: #yaml\n---\n# Body'
  worker.onmessage({
    data: { key: 'on', source, syntax: defaultNoteSyntax },
  })
  worker.onmessage({
    data: {
      key: 'off',
      source,
      syntax: { ...defaultNoteSyntax, frontmatter: false },
    },
  })
  assert.deepEqual(replies, [
    { key: 'on', tags: [] },
    { key: 'off', tags: ['yaml'] },
  ])
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
