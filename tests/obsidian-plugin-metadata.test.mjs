import assert from 'node:assert/strict'
import test from 'node:test'
import { obsidianMetadata } from '../src/addons/obsidian-plugin-loader/metadata.ts'

test('metadata cache exposes properties, headings, links, embeds, and tags', () => {
  const source = [
    '---',
    'title: Example',
    'tags:',
    '  - work',
    '---',
    '',
    '# Heading',
    '',
    'Read [Other](Other.md) and ![image](pic.png) #todo.',
    '',
    '`[not a link](skip.md)`',
    '',
  ].join('\n')
  const cache = obsidianMetadata(source)
  assert.equal(cache.frontmatter.title, 'Example')
  assert.deepEqual(cache.frontmatter.tags, ['work'])
  assert.deepEqual(
    cache.headings.map((item) => item.heading),
    ['Heading'],
  )
  assert.deepEqual(
    cache.links.map((item) => item.link),
    ['Other.md'],
  )
  assert.deepEqual(
    cache.embeds.map((item) => item.link),
    ['pic.png'],
  )
  assert.deepEqual(
    cache.tags.map((item) => item.tag),
    ['#todo'],
  )
  const heading = cache.headings[0].position
  assert.equal(
    source.slice(heading.start.offset, heading.end.offset).trim(),
    '# Heading',
  )
})

test('positions skip identical links and tags inside code', () => {
  const source = [
    '```md',
    '[A](a.md) #tag',
    '```',
    '',
    '`[A](a.md) #tag` [A](a.md) #tag',
    '',
  ].join('\n')
  const cache = obsidianMetadata(source)
  assert.equal(cache.links.length, 1)
  assert.equal(cache.tags.length, 1)
  assert.equal(
    cache.links[0].position.start.offset,
    source.lastIndexOf('[A](a.md)'),
  )
  assert.equal(cache.tags[0].position.start.offset, source.lastIndexOf('#tag'))
})
