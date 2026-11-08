import assert from 'node:assert/strict'
import test from 'node:test'
import * as links from '../src/main/workspace-obsidian-links.ts'

function rewrite(source, from, paths, moves) {
  return links.rewriteObsidianLinks(
    source,
    from,
    new Set(paths),
    new Map(moves),
  )
}

test('wiki resolution folds case and unicode normalization; ambiguous folds stay untouched', () => {
  assert.equal(
    rewrite(
      '[[my note#H|shown]] [[cafe\u0301]]',
      'r.md',
      ['r.md', 'My Note.md', 'café.md'],
      [
        ['My Note.md', 'Other.md'],
        ['café.md', 'été.md'],
      ],
    ),
    '[[Other#H|shown]] [[été]]',
  )
  assert.equal(
    rewrite(
      '[[NOTE]]',
      'r.md',
      ['r.md', 'Note.md', 'note.md'],
      [['Note.md', 'New.md']],
    ),
    '[[NOTE]]',
  )
})

test('table-escaped wiki alias stays escaped while only target changes', () => {
  assert.equal(
    rewrite(
      '| [[a\\|x]] |\r\n|---|\r\n',
      'r.md',
      ['r.md', 'a.md'],
      [['a.md', 'b.md']],
    ),
    '| [[b\\|x]] |\r\n|---|\r\n',
  )
})

test('markdown target keeps angle brackets, raw unicode, escapes and original percent encoding style', () => {
  const source =
    '[t](<my note.md#H>) [u](日本.md) [e](my\\(note\\).md) [p](my%20note.md)\r\n'
  assert.equal(
    rewrite(
      source,
      'r.md',
      ['r.md', 'my note.md', 'my(note).md', '日本.md'],
      [
        ['my note.md', 'my new.md'],
        ['my(note).md', 'my(new).md'],
        ['日本.md', '日本2.md'],
      ],
    ),
    '[t](<my new.md#H>) [u](日本2.md) [e](my\\(new\\).md) [p](my%20new.md)\r\n',
  )
})

test('unique shortest wiki links remain shortest when source or target moves', () => {
  assert.equal(
    rewrite(
      '[[note]] [[other#H]]',
      'r.md',
      ['r.md', 'note.md', 'other.md'],
      [
        ['r.md', 'deep/r.md'],
        ['note.md', 'sub/note.md'],
      ],
    ),
    '[[note]] [[other#H]]',
  )
})

test('moved note rewrites outgoing relative links, path-style wiki and self links only', () => {
  const source =
    '\ufeff[up](../b.md#H "keep") [[../b#^block|alias]] [[a#h]] [[/b]] [[assets/pic.png]]\r\n`[code](../b.md)`\r\n'
  const paths = ['x/a.md', 'b.md', 'x/assets/pic.png']
  const moves = [['x/a.md', 'y/z/a2.md']]
  assert.equal(
    rewrite(source, 'x/a.md', paths, moves),
    '\ufeff[up](../../b.md#H "keep") [[../../b#^block|alias]] [[a2#h]] [[/b]] [[../../x/assets/pic.png]]\r\n`[code](../b.md)`\r\n',
  )
})

test('moving folder rewrites outside-relative links and retains inside-relative paths', () => {
  assert.equal(
    rewrite(
      '[inside](b.md) [outside](../other.md) [[./b]]\r\n',
      'x/a.md',
      ['x/a.md', 'x/b.md', 'other.md'],
      [
        ['x/a.md', 'deep/y/a.md'],
        ['x/b.md', 'deep/y/b.md'],
      ],
    ),
    '[inside](b.md) [outside](../../other.md) [[./b]]\r\n',
  )
})

test('yaml scalar and list wiki targets update without reserializing properties or comments', () => {
  const source =
    '\ufeff---\r\ntitle: "[[a#H|alias]]" # [[a]] keep\r\nlinks:\r\n  - \'[[a]]\'\r\n  - "[[a#^block]]"\r\nflow: ["[[a]]", \'[[other]]\']\r\nquoted: "[[a]] \\u006b"\r\n"[[a]]": unchanged\r\n---\r\n[[a]]\r\n'
  const expected = source
    .replaceAll('"[[a#H|alias]]"', '"[[b#H|alias]]"')
    .replaceAll("'[[a]]'", "'[[b]]'")
    .replaceAll('"[[a#^block]]"', '"[[b#^block]]"')
    .replace('["[[a]]",', '["[[b]]",')
    .replace('"[[a]] \\u006b"', '"[[b]] \\u006b"')
    .replace('---\r\n[[a]]', '---\r\n[[b]]')
  assert.equal(
    rewrite(source, 'r.md', ['r.md', 'a.md', 'other.md'], [['a.md', 'b.md']]),
    expected,
  )
})

test('canvas updates file nodes and markdown text strings; all other json bytes remain exact', () => {
  const source =
    '\ufeff{\r\n "nodes" : [\r\n {"type":"file","id":"one","file":"x\\/a.md","subpath":"#Heading","extra":"x/a.md"},\r\n {"type":"text","id":"two","text":"[[x/a#H|shown]]\\n[shown](x/a.md) `[[x/a]]`"},\r\n {"type":"link","url":"https://example.test/x/a.md","file":"x/a.md"}\r\n ], "edges":[], "unknown":{"file":"x/a.md"}\r\n}\r\n'
  const expected = source
    .replace('"file":"x\\/a.md"', '"file":"y/b.md"')
    .replace(
      '"text":"[[x/a#H|shown]]\\n[shown](x/a.md) `[[x/a]]`"',
      '"text":"[[y/b#H|shown]]\\n[shown](y/b.md) `[[x/a]]`"',
    )
  assert.equal(
    links.rewriteObsidianCanvas(
      source,
      'board.canvas',
      new Set(['board.canvas', 'x/a.md']),
      new Map([['x/a.md', 'y/b.md']]),
    ),
    expected,
  )
})

test('moving a canvas preserves its text-node relative references and file-node root paths', () => {
  const source =
    '{"nodes":[{"type":"file","file":"asset.png"},{"type":"text","text":"[asset](../asset.png)"}]}'
  assert.equal(
    links.rewriteObsidianCanvas(
      source,
      'x/board.canvas',
      new Set(['x/board.canvas', 'asset.png']),
      new Map([['x/board.canvas', 'y/z/board.canvas']]),
    ),
    source.replace('../asset.png', '../../asset.png'),
  )
})

test('mixed raw-unicode percent-space targets and newly unbalanced parentheses stay valid', () => {
  assert.equal(
    rewrite(
      '[mix](日本%20note.md) [plain](Target.md)',
      'r.md',
      ['r.md', '日本 note.md', 'Target.md'],
      [
        ['日本 note.md', '日本 new.md'],
        ['Target.md', 'new(note.md'],
      ],
    ),
    '[mix](日本%20new.md) [plain](new%28note.md)',
  )
})
