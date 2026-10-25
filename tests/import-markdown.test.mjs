import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createWikiLinkResolver,
  wikiLinks,
} from '../src/addons/_shared/import-markdown.ts'

// Expected results captured from the scan-based resolver before indexing.
const cases = [
  [
    'exact',
    'notes/Start.md',
    ['Target.md', 'other/Target.md'],
    '[[Target|go]]',
    {
      source: '[go](../Target.md)',
      embeddedNotes: false,
      unresolved: false,
    },
  ],
  [
    'relative',
    'notes/Start.md',
    ['notes/Target.md', 'other/Target.md'],
    '[[Target]]',
    {
      source: '[Target](Target.md)',
      embeddedNotes: false,
      unresolved: false,
    },
  ],
  [
    'explicit relative',
    'notes/Start.md',
    ['Target.md', 'other/Target.md'],
    '[[../Target#two words]]',
    {
      source: '[two words](../Target.md#two%20words)',
      embeddedNotes: false,
      unresolved: false,
    },
  ],
  [
    'exact-relative conflict',
    'notes/Start.md',
    ['Target.md', 'notes/Target.md'],
    '[[Target]]',
    {
      source: '[[Target]]',
      embeddedNotes: false,
      unresolved: true,
    },
  ],
  [
    'duplicate basename',
    'notes/Start.md',
    ['a/Target.md', 'b/Target.md'],
    '[[Target]]',
    {
      source: '[[Target]]',
      embeddedNotes: false,
      unresolved: true,
    },
  ],
  [
    'exact asset',
    'notes/Start.md',
    ['images/pic one.png', 'pdf/guide.pdf'],
    '![[images/pic one.png|image]] ![[pdf/guide.pdf]]',
    {
      source: '![image](../images/pic%20one.png) [guide.pdf](../pdf/guide.pdf)',
      embeddedNotes: false,
      unresolved: false,
    },
  ],
  [
    'textbundle',
    'notes/Start.md',
    ['Bear.textbundle/text.md'],
    '[[Bear]]',
    {
      source: '[Bear](../Bear.textbundle/text.md)',
      embeddedNotes: false,
      unresolved: false,
    },
  ],
  [
    'duplicate textbundle',
    'notes/Start.md',
    ['Bear.textbundle/text.md', 'other/Bear.md'],
    '[[Bear]]',
    {
      source: '[[Bear]]',
      embeddedNotes: false,
      unresolved: true,
    },
  ],
  [
    'case sensitive suffix',
    'notes/Start.md',
    ['Target.MD', 'Bear.TEXTBUNDLE/text.md'],
    '[[Target]] [[Bear]] [[Bear.TEXTBUNDLE]]',
    {
      source:
        '[[Target]] [[Bear]] [Bear.TEXTBUNDLE](../Bear.TEXTBUNDLE/text.md)',
      embeddedNotes: false,
      unresolved: true,
    },
  ],
  [
    'code',
    'Start.md',
    ['Target.md'],
    '[[Target]] `[[Target]]`\n\n~~~md\n[[Target]]\n~~~\n\n    [[Target]]\n',
    {
      source:
        '[Target](Target.md) `[[Target]]`\n\n~~~md\n[[Target]]\n~~~\n\n    [[Target]]\n',
      embeddedNotes: false,
      unresolved: false,
    },
  ],
  [
    'headings and embeds',
    'notes/Start.md',
    ['Target.md'],
    '[[#same page]] ![[Target]] [[Missing]]',
    {
      source:
        '[same page](Start.md#same%20page) [Target](../Target.md) [[Missing]]',
      embeddedNotes: true,
      unresolved: true,
    },
  ],
  [
    'duplicate exact',
    'Start.md',
    ['Target.md', 'Target.md'],
    '[[Target]]',
    {
      source: '[[Target]]',
      embeddedNotes: false,
      unresolved: true,
    },
  ],
  [
    'empty target first-match order',
    'notes/Start.md',
    ['notes/.md', '.md', 'notes'],
    '[[#head]]',
    {
      source: '[head](.md#head)',
      embeddedNotes: false,
      unresolved: false,
    },
  ],
]
for (const [name, path, paths, source, expected] of cases)
  test(`wiki link parity: ${name}`, () => {
    assert.deepEqual(
      wikiLinks(source, path, createWikiLinkResolver(paths)),
      expected,
    )
  })

test('wiki link resolution never revisits the imported path list', () => {
  for (const count of [250, 1000]) {
    let reads = 0
    const paths = new Proxy(
      Array.from({ length: count }, (_, index) => `folder/n${index}.md`),
      {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^\d+$/.test(key)) reads++
          return Reflect.get(target, key, receiver)
        },
      },
    )
    const resolve = createWikiLinkResolver(paths)
    assert.equal(reads, count)
    for (let index = 0; index < count; index++)
      for (const offset of [1, 2, 3, 4]) {
        const target = `n${(index + offset) % count}`
        assert.deepEqual(resolve(target, 'folder'), {
          path: `folder/${target}.md`,
          count: 1,
        })
      }
    assert.equal(reads, count)
  }
})
