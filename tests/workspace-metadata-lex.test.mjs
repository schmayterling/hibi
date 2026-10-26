import assert from 'node:assert/strict'
import test from 'node:test'
import { Marked } from 'marked'
import {
  parseWorkspaceMetadata,
  propertyIndexValue,
  sourceIndexVersion,
} from '../src/main/workspace-index-metadata.ts'
import {
  localTargetPath,
  noteReferences,
  wikiTargetName,
} from '../src/shared/note-links.ts'
import { noteHeadings, noteProperties } from '../src/shared/note-metadata.ts'
import { defaultNoteSyntax, noteLexer } from '../src/shared/note-syntax.ts'
import { noteTags } from '../src/shared/note-tags.ts'

const source = `---
title: Example
rating: 3
tags: [one, two]
link: "[hidden](hidden.md) #yaml"
---
# **Heading** [[target#part|Alias]] #Work

[second](../second.md#part) [first](first.md) [second](../second.md)
[[target#part|Alias]] ![[embedded]] [[#heading]] [[../unsafe]]
[remote](https://example.com) [bad](%ZZ.md) [escape](../../escape.md)
[ref][id] ![image #hidden](image.png) [#hidden](label.md)

- [ ] [task](task.md) #Todo
  - #Nested

> ## Quote #quote
> [quoted](quote.md)

| #Header | link |
| --- | --- |
| #Table | [cell](cell.md) |

==[highlighted](hidden.md) #highlighted==
\`#code [code](code.md)\` \\#escaped #123 #work

\`\`\`md
# Code
[code](code.md) #code
\`\`\`

<div>
# Html
[html](html.md) #html
</div>

Setext
------

[id]: ref.md
`
const page = { path: 'folder/note.md', markdown: source }
const profile = (settings = defaultNoteSyntax) => ({
  settings,
  key: 'test',
  complete: true,
  unsupported: false,
})

function standaloneMetadata(settings) {
  const references = noteReferences(source, settings)
  const properties = noteProperties(source, settings)
  const values = Object.create(null)
  for (const [key, value] of Object.entries(properties.values))
    values[sourceIndexVersion(key)] = (
      Array.isArray(value) ? value : [value]
    ).map(propertyIndexValue)
  return {
    references: {
      links: references.links.flatMap((href) => {
        const path = localTargetPath(page.path, href)
        return path === null ? [] : [path]
      }),
      wikilinks: references.wikilinks.flatMap((target) => {
        const name = wikiTargetName(target)
        return name === null ? [] : [name]
      }),
    },
    referenceComplete: true,
    tags: noteTags(source, settings),
    properties: { values, complete: properties.complete },
    headings: noteHeadings(source, settings),
  }
}

test('workspace metadata lexes each markdown page exactly once with the real lexer', (t) => {
  const lexer = t.mock.method(Marked.prototype, 'lexer')
  for (const markdown of [source, `${source}\n# Another #new`]) {
    const before = lexer.mock.callCount()
    const metadata = parseWorkspaceMetadata({ ...page, markdown }, profile())
    assert.ok(metadata.references.links.includes('second.md'))
    assert.ok(metadata.tags.includes('work'))
    assert.equal(metadata.headings.items[0].text, 'Heading Alias #Work')
    assert.equal(lexer.mock.callCount() - before, 1)
  }
})

test('workspace metadata preserves standalone helper output and order for syntax projections', () => {
  const settings = [
    defaultNoteSyntax,
    ...['gfm', 'wikilinks', 'hashtags', 'frontmatter'].map((key) => ({
      ...defaultNoteSyntax,
      [key]: false,
    })),
    ...[
      ['core.heading-1', 'core.heading-2'],
      ['core.links', 'core.images'],
      ['core.bullet-lists', 'core.quotes'],
      ['markdown.tasks', 'markdown.tables'],
      ['core.code-blocks', 'core.inline-code'],
      ['core.html-blocks', 'core.inline-html', 'core.escapes'],
    ].map((disabledFeatures) => ({ ...defaultNoteSyntax, disabledFeatures })),
  ]
  for (const syntax of settings)
    assert.deepEqual(
      parseWorkspaceMetadata(page, profile(syntax)),
      standaloneMetadata(syntax),
      JSON.stringify(syntax),
    )
})

test('prelexed helpers reuse projected tokens without mutating them', (t) => {
  const settings = { ...defaultNoteSyntax, disabledFeatures: ['core.links'] }
  const expected = [
    noteReferences(source, settings),
    noteTags(source, settings),
    noteHeadings(source, settings),
  ]
  const lexer = t.mock.method(Marked.prototype, 'lexer')
  const lexed = noteLexer(source, settings)
  const tokens = structuredClone(lexed.tokens)
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(noteHeadings(source, settings, lexed), expected[2])
    assert.deepEqual(noteTags(source, settings, lexed), expected[1])
    assert.deepEqual(noteReferences(source, settings, lexed), expected[0])
  }
  assert.deepEqual(structuredClone(lexed.tokens), tokens)
  assert.equal(lexer.mock.callCount(), 1)
})

test('custom reference parsers retain injection and can forward prelexed tokens', (t) => {
  const lexer = t.mock.method(Marked.prototype, 'lexer')
  const custom = t.mock.fn((markdown, settings) => {
    assert.equal(markdown, source)
    assert.equal(settings, defaultNoteSyntax)
    return { links: ['custom.md'], wikilinks: ['custom#section'] }
  })
  const metadata = parseWorkspaceMetadata(page, profile(), custom)
  assert.equal(custom.mock.callCount(), 1)
  assert.deepEqual(metadata.references, {
    links: ['folder/custom.md'],
    wikilinks: ['custom'],
  })
  assert.ok(metadata.tags.includes('work'))
  assert.equal(lexer.mock.callCount(), 1)
  const forwarding = t.mock.fn((...args) => noteReferences(...args))
  assert.deepEqual(
    parseWorkspaceMetadata(page, profile(), forwarding),
    parseWorkspaceMetadata(page, profile()),
  )
  assert.equal(forwarding.mock.callCount(), 1)
  assert.equal(lexer.mock.callCount(), 3)
})

test('non-markdown pages and disabled standalone hashtags do not invoke the lexer', (t) => {
  const lexer = t.mock.method(Marked.prototype, 'lexer')
  const parse = t.mock.fn()
  assert.deepEqual(
    parseWorkspaceMetadata({ ...page, path: 'note.typ' }, profile(), parse),
    {
      references: { links: [], wikilinks: [] },
      referenceComplete: true,
      tags: [],
      properties: { values: Object.create(null), complete: true },
      headings: { items: [], complete: true },
    },
  )
  assert.deepEqual(
    noteTags(source, { ...defaultNoteSyntax, hashtags: false }),
    [],
  )
  assert.equal(parse.mock.callCount(), 0)
  assert.equal(lexer.mock.callCount(), 0)
})
