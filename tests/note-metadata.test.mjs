import assert from 'node:assert/strict'
import test from 'node:test'
import { noteReferences } from '../src/shared/note-links.ts'
import { noteHeadings, noteProperties } from '../src/shared/note-metadata.ts'
import { defaultNoteSyntax } from '../src/shared/note-syntax.ts'
import { noteTags } from '../src/shared/note-tags.ts'

test('shared tag parser keeps built-in tag syntax', () => {
  assert.deepEqual(
    noteTags(
      '---\ntags: [metadata]\n---\n# Heading\n\n#Work #work/project `#code`',
    ),
    ['work', 'work/project'],
  )
})

test('built-in parser settings govern GFM, Obsidian, headings, and hashtags', () => {
  const source =
    '# [[target|Alias]] #work\n\nwww.example.com [[target]] [local](target.md)'
  assert.deepEqual(noteReferences(source).wikilinks, ['target', 'target'])
  assert.deepEqual(
    noteReferences(source, { ...defaultNoteSyntax, wikilinks: false })
      .wikilinks,
    [],
  )
  assert.equal(noteReferences(source).links.length, 2)
  assert.equal(
    noteReferences(source, { ...defaultNoteSyntax, gfm: false }).links.length,
    1,
  )
  assert.deepEqual(noteHeadings(source).items, [
    { depth: 1, text: 'Alias #work' },
  ])
  assert.deepEqual(
    noteHeadings(source, {
      ...defaultNoteSyntax,
      disabledFeatures: ['core.heading-1'],
    }).items,
    [],
  )
  assert.deepEqual(
    noteTags(source, { ...defaultNoteSyntax, hashtags: false }),
    [],
  )
  assert.deepEqual(noteTags('| tag |\n| --- |\n| #table |'), ['table'])
  const task = '- [ ] [next](target.md) #todo'
  const bulletsOff = {
    ...defaultNoteSyntax,
    disabledFeatures: ['core.bullet-lists'],
  }
  assert.deepEqual(noteReferences(task, bulletsOff).links, ['target.md'])
  assert.deepEqual(noteTags(task, bulletsOff), ['todo'])
  const tasksOff = {
    ...defaultNoteSyntax,
    disabledFeatures: ['markdown.tasks'],
  }
  assert.deepEqual(noteReferences(task, tasksOff).links, [])
  assert.deepEqual(noteTags(task, tasksOff), [])
  const highlighted = '==[hidden](target.md)== [shown](target.md)'
  assert.deepEqual(noteReferences(highlighted).links, ['target.md'])
  assert.deepEqual(
    noteReferences(highlighted, {
      ...defaultNoteSyntax,
      wikilinks: false,
    }).links,
    ['target.md', 'target.md'],
  )
  const frontmatterOff = { ...defaultNoteSyntax, frontmatter: false }
  const leadingYaml = '---\nlink: "[hidden](target.md)"\n---\n# Body'
  assert.deepEqual(noteReferences(leadingYaml).links, [])
  assert.deepEqual(noteReferences(leadingYaml, frontmatterOff).links, [
    'target.md',
  ])
  const yamlTag = '---\ntag: #yaml\n---\n# Body'
  assert.deepEqual(noteTags(yamlTag), [])
  assert.deepEqual(noteTags(yamlTag, frontmatterOff), ['yaml'])
  assert.deepEqual(
    Object.keys(
      noteProperties('---\ntitle: Alpha\n---\n# Body', frontmatterOff).values,
    ),
    [],
  )
})

test('properties retain scalars and reject nested or invalid yaml', () => {
  const result = noteProperties(
    '---\ntitle: Example\nrating: 3\npublic: true\ntags: [one, two]\nnested: { unsafe: value }\n---\n# Heading',
  )
  assert.equal(result.values.title, 'Example')
  assert.equal(result.values.rating, 3)
  assert.equal(result.values.public, true)
  assert.deepEqual(result.values.tags, ['one', 'two'])
  assert.equal(Object.hasOwn(result.values, 'nested'), false)
  assert.equal(result.complete, false)
  assert.equal(noteProperties('---\nbad: [\n---\nbody').complete, false)
  assert.equal(
    noteProperties(`---\nlong: ${'x'.repeat(100_000)}\n---\nbody`).complete,
    true,
  )
  assert.equal(noteProperties('plain markdown').complete, true)
  assert.equal(noteProperties('---\n[link](a.md)').complete, false)
})

test('headings follow standard gfm text while excluding code and frontmatter', () => {
  assert.deepEqual(
    noteHeadings(
      '---\ntitle: # not a heading\n---\n# **Hello** `world`\n\n```md\n# Code\n```\n\nSubheading\n----------',
    ).items,
    [
      { depth: 1, text: 'Hello world' },
      { depth: 2, text: 'Subheading' },
    ],
  )
  const long = noteHeadings(`# ${'x'.repeat(40_000)}`)
  assert.equal(long.complete, true)
  assert.equal(long.items[0].text, 'x'.repeat(40_000))
  assert.deepEqual(
    noteHeadings(`---\nlong: ${'x'.repeat(100_000)}\n---\n# Visible`),
    { items: [{ depth: 1, text: 'Visible' }], complete: true },
  )
  assert.deepEqual(noteHeadings('---\n# Visible').items, [
    { depth: 1, text: 'Visible' },
  ])
})

test('metadata retains every property, scalar, list item and heading beyond former cutoffs', () => {
  const key = 'k'.repeat(200)
  const value = 'v'.repeat(5000)
  const members = Array.from({ length: 40 }, (_, i) => `item-${i}`)
  const properties = noteProperties(
    `---\n${Array.from({ length: 100 }, (_, i) => `key${i}: ${i}`).join('\n')}\n${key}: ${value}\nlist: [${members.join(', ')}]\n---\nbody`,
  )
  assert.equal(properties.complete, true)
  assert.equal(Object.keys(properties.values).length, 102)
  assert.equal(properties.values[key], value)
  assert.deepEqual(properties.values.list, members)
  const headings = noteHeadings(
    Array.from({ length: 300 }, (_, i) => `# heading ${i}`).join('\n\n'),
  )
  assert.equal(headings.complete, true)
  assert.equal(headings.items.length, 300)
  assert.equal(headings.items.at(-1).text, 'heading 299')
})

test('yaml alias expansion remains bounded', () => {
  const source = `---\na: &a one\nlist: [${Array.from({ length: 60 }, () => '*a').join(', ')}]\n---\nbody`
  assert.equal(noteProperties(source).complete, false)
})
