import assert from 'node:assert/strict'
import test from 'node:test'
import { DocumentSession } from '../src/shared/document-session.ts'
import { renderedReplaceEdits as applyRenderedReplaceEdits } from '../src/shared/rendered-replace.ts'
import { RenderedTextIndex } from '../src/shared/rendered-text.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'
import { sourceChangesFromEditor } from '../src/shared/source-projection.ts'
import { searchRenderedLiteral } from '../src/shared/source-rendered-search.ts'
import { searchSourceLiteral } from '../src/shared/source-search.ts'
import { renderedConfig } from './rendered-config.mjs'

const projections = new WeakMap()
const finish = (work) => {
  for (;;) {
    const next = work.next()
    if (next.done) return next.value
  }
}
function renderedReplaceEdits(match, value) {
  const projection = projections.get(match)
  return applyRenderedReplaceEdits(
    match,
    value,
    projection
      ? finish(projection.prepareReplacement(match, value))
      : undefined,
  )
}
function matches(text, query, options) {
  const store = new SourceStore(text, { tabId: 'provenance', revision: 0 })
  const projection = new RenderedTextIndex(store.snapshot(), 0, renderedConfig)
  for (const _step of projection.build()) {
  }
  const found = [...searchRenderedLiteral(projection, query, options)].flatMap(
    (batch) => batch.matches,
  )
  for (const match of found) projections.set(match, projection)
  return found
}
function replace(text, query, value) {
  const [match] = matches(text, query)
  assert.ok(match, query)
  const edits = renderedReplaceEdits(match, value)
  assert.ok(edits)
  let output = text
  for (const edit of [...edits].reverse())
    output = output.slice(0, edit.from) + edit.insert + output.slice(edit.to)
  return output
}

test('rendered matches retain exact provenance across marks, atoms, links and code', () => {
  for (const [source, query] of [
    ['hello **world**', 'hello world'],
    ['hello *world*', 'hello world'],
    ['hello ***world***', 'hello world'],
    ['hello [world](https://example.test/a_(b))', 'hello world'],
    ['hello `world`', 'hello world'],
    ['hello\\\nworld', 'hello\nworld'],
    ['hello <https://example.test/world>', 'hello https://example.test/world'],
    ['hello <foo@example.test>', 'hello foo@example.test'],
    ['hello &amp; world', 'hello & world'],
    ['hello \\*world\\*', 'hello *world*'],
    ['CAFÉ **ΟΣ**', 'café ος'],
    ['👩🏽‍💻 **world**', '👩🏽‍💻 world'],
  ]) {
    const found = matches(source, query)
    assert.equal(found.length, 1, source)
    assert.equal(found[0].precise, true, source)
    assert.ok(found[0].segments.length, source)
  }
})

test('rendered replacements preserve surviving marks and remove emptied syntax', () => {
  for (const [source, query, value, expected] of [
    ['hello **world**', 'lo wo', 'X', 'helX**rld**'],
    ['hello **world**', 'hello world', 'X', 'X'],
    ['hello **world**', 'world', 'X', 'hello **X**'],
    ['hello **world**', 'world', '', 'hello '],
    ['hello ***world***', 'hello world', 'X', 'X'],
    [
      '[hello world](https://example.test)',
      'world',
      'X',
      '[hello X](https://example.test)',
    ],
    ['[hello world](https://example.test)', 'hello world', 'X', 'X'],
    ['hello &amp; world', '&', 'and', 'hello and world'],
    ['hello \\*world\\*', '*world*', 'X', 'hello X'],
    ['hello `world`', 'hello world', 'X', 'X'],
  ])
    assert.equal(replace(source, query, value), expected, source)
})

test('opaque content keeps surrounding marks and links nonempty during replacement', () => {
  assert.equal(
    replace('[A ![image](pic)](href)', 'A ', 'X'),
    '[X![image](pic)](href)',
  )
  assert.equal(replace('**A ![image](pic)**', 'A ', ''), '**![image](pic)**')
})

test('rendered search never offers replacement through half a surrogate scalar', () => {
  for (const [source, queries] of [
    [
      'before 😀 after',
      [String.fromCharCode(0xd83d), String.fromCharCode(0xde00)],
    ],
    [
      'before &#x1F600; after',
      [String.fromCharCode(0xd83d), String.fromCharCode(0xde00)],
    ],
  ])
    for (const query of queries) {
      const [match] = matches(source, query)
      assert.ok(match)
      assert.equal(match.precise, false)
      assert.equal(renderedReplaceEdits(match, 'X'), null)
    }
  assert.equal(replace('before 😀 after', '😀', 'X'), 'before X after')
})

test('rendered search preserves source folding and unicode across CRLF and chunk seams', () => {
  const text = 'a'.repeat(4095) + '😀İ é ﬃ ΟΔΟΣ οδος οδοσ\r\nCAFÉ ΟΣ'
  for (const caseSensitive of [false, true])
    for (const query of [
      '😀',
      'i',
      'İ',
      'é',
      'ffi',
      'f',
      'ΟΔΟΣ',
      'οδος',
      'οδοσ',
      'café ος',
    ]) {
      const store = new SourceStore(text, { tabId: 'fold-parity', revision: 0 })
      const raw = [
        ...searchSourceLiteral(store.snapshot(), query, { caseSensitive }),
      ].flatMap((batch) => batch.matches)
      assert.deepEqual(
        matches(text, query, { caseSensitive }).map(
          ({ segments, containers, context, ...match }) => match,
        ),
        raw,
        query,
      )
    }
})

test('rendered replacement maps CRLF and unicode to one canonical operation and undo', (t) => {
  const text = '😀 intro\r\n```\r\nhello world\r\ntail\r\n```'
  const journal = [],
    errors = []
  const session = new DocumentSession(
    text,
    { tabId: 'replace-crlf', revision: 0 },
    0,
    {
      enqueue: (operation) => journal.push(operation),
      onError: (error) => errors.push(error),
    },
  )
  t.after(() => session.dispose())
  const snapshot = session.snapshot()
  const projection = new RenderedTextIndex(snapshot, 0, renderedConfig)
  for (const _step of projection.build()) {
  }
  const [match] = [...searchRenderedLiteral(projection, 'lo wo')].flatMap(
    (batch) => batch.matches,
  )
  projections.set(match, projection)
  const edits = renderedReplaceEdits(match, 'X\nY')
  assert.ok(edits)
  session.edit(sourceChangesFromEditor(snapshot, edits), 'source', 'replace')
  assert.equal(
    session.snapshot().materialize(),
    '😀 intro\r\n```\r\nhelX\r\nYrld\r\ntail\r\n```',
  )
  assert.equal(journal.length, 1)
  assert.equal(journal[0].changes.length, 1)
  assert.equal(session.state().contentVersion, 1)
  assert.ok(session.undo())
  assert.equal(session.snapshot().materialize(), text)
  assert.equal(journal.length, 2)
  assert.equal(session.undo(), null)
  assert.deepEqual(errors, [])
})

test('coextensive nested marks keep replacement provenance compact', () => {
  const marks = '*'.repeat(500)
  const source = marks + 'word' + marks
  const [match] = matches(source, 'word')
  assert.equal(match.containers.length, 1)
  assert.deepEqual(renderedReplaceEdits(match, ''), [
    { from: 0, to: source.length, insert: '' },
  ])
  assert.equal(replace(source, 'word', 'X'), marks + 'X' + marks)
})

test('replacement text stays literal at line starts, mid-word, in link labels and code', () => {
  const values = ['*', '_', '[', '`', '#', '>', '-', '1.', '|', '\\', '<', '&']
  const sources = [
    'TARGET tail',
    'midTARGETword',
    '[before TARGET after](url)',
    '[TARGET tail](url)',
    '`before TARGET after`',
    '`TARGET tail`',
    '```\nbefore TARGET after\n```',
    '```\nTARGET tail\n```',
    '    TARGET tail',
    '\tTARGET tail',
    '-     TARGET tail',
    '-\t\tTARGET tail',
  ]
  const project = (text) => {
    const store = new SourceStore(text, {
      tabId: 'replace-literal',
      revision: 0,
    })
    const projection = new RenderedTextIndex(
      store.snapshot(),
      0,
      renderedConfig,
    )
    for (const _step of projection.build()) {
    }
    return [...projection.range(0, projection.length)]
      .map((run) => run.text ?? projection.text(run.from, run.to))
      .join('')
  }
  for (const source of sources)
    for (const value of values) {
      const [match] = matches(source, 'TARGET')
      const edits = renderedReplaceEdits(match, value)
      if (
        source.startsWith('`') &&
        !source.startsWith('```') &&
        value === '`'
      ) {
        assert.equal(edits, null)
        continue
      }
      assert.ok(edits, source + ': ' + value)
      let output = source
      for (const edit of [...edits].reverse())
        output =
          output.slice(0, edit.from) + edit.insert + output.slice(edit.to)
      assert.equal(
        project(output),
        project(source).replace('TARGET', value),
        source + ': ' + value,
      )
    }
  for (const value of ['#', '>', '-', '1.', '|', '&']) {
    assert.equal(
      replace('midTARGETword', 'TARGET', value),
      'mid' + value + 'word',
    )
  }
  assert.equal(replace('**TARGET** tail', 'TARGET', '#'), '**#** tail')
  assert.equal(replace('[TARGET](url) tail', 'TARGET', '#'), '\\# tail')
  assert.equal(replace('TARGETamp;', 'TARGET', '&'), '\\&amp;')
  assert.equal(replace('TARGET **gone**amp;', 'TARGET gone', '&'), '\\&amp;')
  assert.equal(replace('TARGET[world](url)', 'TARGET', '!'), '\\![world](url)')
})

test('literal replacement respects existing block prefixes and completed ordered markers', () => {
  for (const [source, value, expected] of [
    ['# TARGET tail', '#', '# # tail'],
    ['- TARGET tail', '#', '- \\# tail'],
    ['> TARGET tail', '>', '> \\> tail'],
    ['1234TARGET tail', '.', '1234\\. tail'],
    ['   123456789TARGET tail', ')', '   123456789\\) tail'],
  ])
    assert.equal(replace(source, 'TARGET', value), expected, source)
})

test('inline code refuses closing runs and handles harmless backticks verbatim', () => {
  for (const [source, value, expected] of [
    ['``before TARGET after``', '`', '``before ` after``'],
    ['``before TARGET after``', '``', null],
    ['`TARGET after`', '``', null],
    ['`before TARGET`', '``', null],
    ['``a`TARGETb``', '`', null],
    ['``a`TARGET`b``', '', null],
  ]) {
    const [match] = matches(source, 'TARGET')
    const edits = renderedReplaceEdits(match, value)
    if (expected === null) assert.equal(edits, null, source)
    else assert.equal(replace(source, 'TARGET', value), expected)
  }
})

test('partial angle autolinks refuse replacement that cannot retain their target', () => {
  for (const query of ['example', 'hello https://']) {
    const [match] = matches('hello <https://example.test>', query)
    assert.equal(renderedReplaceEdits(match, 'X'), null)
  }
  assert.equal(
    replace('hello <https://example.test>', 'https://example.test', '#'),
    'hello #',
  )
  assert.equal(
    replace('<https://example.test> tail', 'https://example.test', '#'),
    '\\# tail',
  )
})

test('partial decoded entities remain findable and cannot be replaced', () => {
  for (const query of ['≂', '̸']) {
    const [match] = matches('before &NotEqualTilde; after', query)
    assert.ok(match)
    assert.equal(match.precise, false)
    assert.equal(renderedReplaceEdits(match, 'X'), null)
  }
  assert.equal(
    replace('before &NotEqualTilde; after', '≂̸', 'X'),
    'before X after',
  )
})
