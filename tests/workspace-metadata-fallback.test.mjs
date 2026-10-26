import assert from 'node:assert/strict'
import test from 'node:test'
import { Marked } from 'marked'
import { parseWorkspaceMetadataFallback } from '../src/main/workspace-metadata-fallback.ts'
import { defaultNoteSyntax } from '../src/shared/note-syntax.ts'

const input = {
  id: 'a'.repeat(64),
  path: 'folder/slow.md',
  version: 'disk:version',
  fingerprint: 'syntax',
  syntax: {
    settings: defaultNoteSyntax,
    key: 'test',
    complete: true,
    unsupported: false,
  },
}
const collect = (chunks, request = input) => {
  const headings = []
  const page = parseWorkspaceMetadataFallback(request, chunks, (heading) =>
    headings.push(heading),
  )
  return { page, headings }
}

test('fallback preserves headings, local links and tags without entering the slow lexer', () => {
  const lexer = Marked.prototype.lexer
  Marked.prototype.lexer = () => {
    throw new Error('native lexer must not run')
  }
  try {
    const { page, headings } = collect([
      '# slow\n',
      '*a '.repeat(16_384),
      '\n[Target](../target.md#part) [[another|Alias]] #Real\n## later\n',
    ])
    assert.deepEqual(headings, [
      { depth: 1, text: 'slow' },
      { depth: 2, text: 'later' },
    ])
    assert.deepEqual(page.metadata.references, {
      links: ['target.md'],
      wikilinks: ['another'],
    })
    assert.deepEqual(page.metadata.tags, ['real'])
    assert.deepEqual(page.metadata.headings, {
      items: [],
      complete: false,
      count: 2,
      paged: true,
    })
    assert.equal(page.metadata.referenceComplete, false)
    assert.equal(page.syntax.complete, false)
  } finally {
    Marked.prototype.lexer = lexer
  }
})

test('fallback results do not depend on input chunk boundaries', () => {
  const source =
    '# Heading 😀\r\n[Note](../note.md) [[other]] #Café\r\nSetext\r\n---\r\n'
  const expected = collect([source])
  for (const size of [1, 2, 7, 31]) {
    const chunks = []
    for (let start = 0; start < source.length; start += size)
      chunks.push(source.slice(start, start + size))
    assert.deepEqual(collect(chunks), expected)
  }
  assert.deepEqual(expected.headings, [
    { depth: 1, text: 'Heading 😀' },
    { depth: 2, text: 'Setext' },
  ])
  assert.deepEqual(expected.page.metadata.tags, ['café'])
})

test('fallback skips frontmatter and code and honors disabled builtin settings', () => {
  const source = [
    '---',
    'title: "#yaml [hidden](yaml.md)"',
    '---',
    '```md',
    '# hidden',
    '[hidden](code.md) #code',
    '```',
    '    # indented',
    '`[hidden](inline.md) #inline` #visible',
    '> ## quoted',
    '[visible](visible.md) ![image](image.png)',
  ].join('\n')
  const { page, headings } = collect([source])
  assert.deepEqual(headings, [{ depth: 2, text: 'quoted' }])
  assert.deepEqual(page.metadata.references.links, ['folder/visible.md'])
  assert.deepEqual(page.metadata.tags, ['visible'])
  const disabled = collect(['# first\n## second\n[a](a.md) [[wiki]] #tag'], {
    ...input,
    syntax: {
      ...input.syntax,
      settings: {
        ...defaultNoteSyntax,
        hashtags: false,
        wikilinks: false,
        disabledFeatures: ['core.heading-1', 'core.links'],
      },
    },
  })
  assert.deepEqual(disabled.headings, [{ depth: 2, text: 'second' }])
  assert.deepEqual(disabled.page.metadata.references, {
    links: [],
    wikilinks: [],
  })
  assert.deepEqual(disabled.page.metadata.tags, [])
})

test('fallback bounds failed target searches and leaves later lines reachable', () => {
  let searched = 0
  const indexOf = String.prototype.indexOf
  String.prototype.indexOf = function (needle, from = 0) {
    const result = indexOf.call(this, needle, from)
    searched +=
      (result < 0 ? this.length : result + String(needle).length) - from
    return result
  }
  try {
    for (const size of [16_384, 65_536]) {
      searched = 0
      const source =
        '[x]('.repeat(size / 4) + '\n# found\n[good](good.md) #found'
      const result = collect([source])
      assert.deepEqual(result.headings, [{ depth: 1, text: 'found' }])
      assert.deepEqual(result.page.metadata.references.links, [
        'folder/good.md',
      ])
      assert.deepEqual(result.page.metadata.tags, ['found'])
      assert.ok(
        searched <= 8 * source.length,
        `${searched} searched for ${source.length} characters`,
      )
    }
  } finally {
    String.prototype.indexOf = indexOf
  }
})
