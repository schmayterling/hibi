import assert from 'node:assert/strict'
import test from 'node:test'
import { countText } from '../src/addons/word-count/count.ts'
import { CountBrackets } from '../src/addons/word-count/count-brackets.ts'
import { FormattedCounter } from '../src/addons/word-count/formatted-counter.ts'
import {
  countParser,
  richText,
} from '../src/addons/word-count/formatted-text.ts'
import { defaultNoteSyntax } from '../src/shared/note-syntax.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'

const syntax = { ...defaultNoteSyntax, frontmatter: false }
function operation(store, changes, origin = 'source') {
  const before = store.snapshot()
  return {
    document: before.document,
    operationId: crypto.randomUUID(),
    baseVersion: before.version,
    contentVersion: before.version + 1,
    origin,
    historyGroup: 'brackets',
    changes,
  }
}
function fixture(t, source, gfm = false) {
  const store = new SourceStore(source, { tabId: 'brackets', revision: 0 })
  const brackets = new CountBrackets(store.snapshot(), gfm)
  t.after(() => brackets.dispose())
  const edit = (changes, origin = 'source') => {
    const prepared = store.prepare(operation(store, changes, origin))
    const openers = brackets.apply(prepared)
    store.commit(prepared)
    return [...openers]
  }
  return { store, brackets, edit }
}
function read(counter) {
  const work = counter.read()
  for (;;) {
    const step = work.next()
    if (step.done) return step.value
  }
}
const expected = (source, config = syntax) =>
  countText(richText(source, config).slice(1))
function counterFixture(t, source, config = syntax) {
  const counter = new FormattedCounter(
    new SourceStore(source, { tabId: 'bracket-counts', revision: 0 }),
    config,
  )
  t.after(() => counter.dispose())
  const edit = (changes, origin = 'source') => {
    counter.apply(operation(counter.store, changes, origin))
    const snapshot = counter.store.snapshot()
    const text = snapshot.sliceRaw(0, snapshot.utf16Length)
    assert.deepEqual(read(counter), expected(text, config), text)
  }
  assert.deepEqual(read(counter), expected(source, config))
  return { counter, edit }
}

test('plain edits around escapes notify distant label readers before undo', (t) => {
  for (const [tail, insert, remove, before, after] of [
    ['\\]: /target', 'x', 0, false, true],
    ['\\x]: /target', '', 1, true, false],
    ['\\[inner\n\n]: /target', 'x', 0, true, false],
    ['\\x[inner\n\n]: /target', '', 1, false, true],
  ]) {
    const source = `[first\n\nplain words\n\n${tail}\n\nlast`
    const f = fixture(t, source)
    const from = source.indexOf('\\') + 1
    assert.equal(f.brackets.canClose(0), before, source)
    assert.deepEqual(
      f.edit([{ from, to: from + remove, insert }]),
      !before && after ? [0] : [],
      source,
    )
    assert.equal(f.brackets.canClose(0), after, source)
    assert.deepEqual(
      f.edit(
        [
          {
            from,
            to: from + insert.length,
            insert: source.slice(from, from + remove),
          },
        ],
        'undo',
      ),
      before && !after ? [0] : [],
      source,
    )
    assert.equal(f.brackets.canClose(0), before, source)
  }
})

test('bracket queries use normalized positions and honor escapes and nested labels', (t) => {
  for (const eol of ['\n', '\r\n'])
    for (const [body, valid] of [
      ['first\n\nlast]: /target', true],
      ['first\n\nlast]', false],
      ['first\n\nlast]x: /target', false],
      ['first\n\nlast\\]: /target', false],
      ['first\n\nlast\\[]: /target', true],
      ['first\n\nlast\\\\]: /target', true],
      ['first\n\n[nested]: /target', false],
      ['first\n\nlast\\\n]: /target', true],
    ]) {
      const prefix = '😀 prefix\n\n'.replaceAll('\n', eol)
      const source = `${prefix}[${body.replaceAll('\n', eol)}`
      const f = fixture(t, source)
      assert.equal(
        f.brackets.canClose(f.store.snapshot().rawToEditor(prefix.length)),
        valid,
        JSON.stringify(source),
      )
    }
})

test('ordinary gap edits preserve subscriptions to unchanged closing markers', (t) => {
  const source = '[first\n\nbody\n\nlast]x: /target'
  const f = fixture(t, source)
  assert.equal(f.brackets.canClose(0), false)
  f.brackets.counters(true)
  const from = source.indexOf('body')
  assert.deepEqual(f.edit([{ from, to: from, insert: 'more words ' }]), [])
  const work = f.brackets.counters(true)
  assert.equal(work.candidateQueries, 0)
  assert.equal(work.markerVisits, 0)
  assert.equal(work.readUnits, 'more words '.length)
  const close = source.indexOf(']') + 'more words '.length + 1
  assert.deepEqual(f.edit([{ from: close, to: close + 1, insert: '' }]), [0])
  assert.equal(f.brackets.canClose(0), true)
  assert.deepEqual(
    f.edit([{ from: close, to: close, insert: 'x' }], 'undo'),
    [],
  )
  assert.equal(f.brackets.canClose(0), false)
})

test('colon adjacency insertions and deletions invalidate only newly valid labels', (t) => {
  for (const [tail, remove, insert] of [
    [']x: /target', 1, ''],
    ['] /target', 0, ':'],
  ]) {
    const source = `[first\n\nbody\n\nlast${tail}`
    const f = fixture(t, source)
    assert.equal(f.brackets.canClose(0), false)
    const from = source.indexOf(']') + 1
    assert.deepEqual(f.edit([{ from, to: from + remove, insert }]), [0])
    assert.equal(f.brackets.canClose(0), true)
    assert.deepEqual(
      f.edit(
        [
          {
            from,
            to: from + insert.length,
            insert: source.slice(from, from + remove),
          },
        ],
        'undo',
      ),
      [],
    )
    assert.equal(f.brackets.canClose(0), false)
  }
})

test('multi-change edits return shifted raw openers through crlf and undo', (t) => {
  const source = '😀 prefix\r\n\r\n[first\r\n\r\nbody\r\n\r\nlast]x: /target'
  const f = fixture(t, source)
  const opener = source.indexOf('[')
  const from = source.indexOf(']') + 1
  const prefix = 'new\r\n'
  assert.equal(
    f.brackets.canClose(f.store.snapshot().rawToEditor(opener)),
    false,
  )
  assert.deepEqual(
    f.edit([
      { from: 0, to: 0, insert: prefix },
      { from, to: from + 1, insert: '' },
    ]),
    [opener + prefix.length],
  )
  assert.equal(
    f.brackets.canClose(f.store.snapshot().rawToEditor(opener + prefix.length)),
    true,
  )
  assert.deepEqual(
    f.edit(
      [
        { from: 0, to: prefix.length, insert: '' },
        { from: from + prefix.length, to: from + prefix.length, insert: 'x' },
      ],
      'undo',
    ),
    [],
  )
  assert.equal(
    f.brackets.canClose(f.store.snapshot().rawToEditor(opener)),
    false,
  )
  assert.equal(f.store.snapshot().sliceRaw(0, source.length), source)
})

test('distant definition closing retroactively hides body counts through undo and redo', (t) => {
  for (const eol of ['\n', '\r\n']) {
    const source =
      `[first\n\n${'plain words here\n\n'.repeat(80)}last`.replaceAll('\n', eol)
    const f = counterFixture(t, source)
    const insert = `${eol}${eol}]: /target`
    f.edit([{ from: source.length, to: source.length, insert }])
    f.edit(
      [{ from: source.length, to: source.length + insert.length, insert: '' }],
      'undo',
    )
    f.edit([{ from: source.length, to: source.length, insert }], 'redo')
  }
})

test('escape and colon adjacency edits update distant counter ownership', (t) => {
  for (const eol of ['\n', '\r\n'])
    for (const [tail, remove, insert] of [
      ['\\]: /target', 0, 'x'],
      ['\\x]: /target', 1, ''],
      ['\\[inner\n\n]: /target', 0, 'x'],
      ['\\x[inner\n\n]: /target', 1, ''],
      [']x: /target', 1, ''],
    ]) {
      const source = `[first\n\nplain words\n\n${tail}`.replaceAll('\n', eol)
      const f = counterFixture(t, source)
      const from =
        source.indexOf('\\') >= 0
          ? source.indexOf('\\') + 1
          : source.indexOf(']') + 1
      f.edit([{ from, to: from + remove, insert }])
      f.edit(
        [
          {
            from,
            to: from + insert.length,
            insert: source.slice(from, from + remove),
          },
        ],
        'undo',
      )
    }
})

test('warm body edits after stray openers keep work bounded at 1000 and 4000 paragraphs', (t) => {
  for (const paragraphs of [1000, 4000])
    for (const prefix of ['', '[', '[^a']) {
      const source = `${prefix}first\n\n${'plain words here\n\n'.repeat(paragraphs)}last`
      const { counter } = counterFixture(t, source)
      counter.counters(true)
      const from = source.length - 2
      counter.apply(operation(counter.store, [{ from, to: from, insert: 'x' }]))
      assert.deepEqual(
        read(counter),
        expected(`${source.slice(0, from)}x${source.slice(from)}`),
      )
      const work = counter.counters()
      const details = JSON.stringify({ paragraphs, prefix, work })
      assert.ok(work.countedUnits < 1024, details)
      assert.ok(work.referenceUnits < 1024, details)
      assert.ok(work.parser.parser.readUnits < 1024, details)
      assert.equal(work.brackets.candidateQueries, 0, details)
      assert.equal(work.brackets.markerVisits, 0, details)
      assert.equal(work.brackets.readUnits, 1, details)
      assert.equal(work.source.materializations, 0, details)
    }
})

test('title closers after backslashes reject blank title lines', (t) => {
  const parser = countParser(syntax)
  for (const eol of ['\n', '\r\n'])
    for (const [open, gap, close] of [
      ['"', '\n\n', '"'],
      ["'", '\n', "'"],
      ['(', '\n\n', ')'],
    ]) {
      const source =
        `[ref]: /target ${open}first${gap}last\\${close}`.replaceAll('\n', eol)
      const tokens = parser.lexer(source)
      const valid = gap === '\n'
      assert.equal(tokens[0]?.type === 'def', valid, JSON.stringify(source))
      const f = fixture(t, source)
      assert.equal(f.brackets.canClose(0), valid, JSON.stringify(source))
    }
})

test('blank title lines do not consume following block state in regional counts', async (t) => {
  for (const [source, words, characters] of [
    ['[ref]: /x\n"one\n\n```"\ncode\n\n[ref]', 3, 16],
    ['[ref]: /x "one\n\n<!-- "\n\n[ref]\n\n-->', 4, 33],
    ['[ref]: /x\n"note\n\n~~~ "\nmore\n\n[ref]', 3, 17],
    ['[ref]: /x (one\n\ntwo)\n---\n\n[ref]', 5, 25],
  ])
    await t.test(JSON.stringify(source), (t) => {
      for (const eol of ['\n', '\r\n']) {
        const text = source.replaceAll('\n', eol)
        assert.deepEqual(expected(text), { words, characters })
        const { counter } = counterFixture(t, text)
        assert.deepEqual(read(counter), { words, characters })
      }
    })
})

test('regional title ownership follows CommonMark paragraph interruptions', async (t) => {
  for (const [open, close] of [
    ['"', '"'],
    ["'", "'"],
    ['(', ')'],
  ])
    for (const separator of [' ', '\n'])
      for (const line of ['# two', '> two', '- two', '1. two', '```', '<div>'])
        await t.test(JSON.stringify({ open, separator, line }), (t) => {
          for (const eol of ['\n', '\r\n']) {
            const source =
              `[ref]: /x${separator}${open}one\n${line}${close}\n\n[ref]\n`.replaceAll(
                '\n',
                eol,
              )
            const href = separator === ' ' ? null : '/x'
            const definition = countParser(syntax).lexer(source).links.ref
            assert.equal(definition?.href ?? null, href)
            assert.equal(definition?.title ?? null, null)
            const f = fixture(t, source)
            assert.equal(f.brackets.canClose(0), href !== null)
            counterFixture(t, source)
          }
        })
})

test('regional title probes agree across 450 paragraph boundary cases', (t) => {
  assert.deepEqual(expected('[ref]: /x "one\n- \nlast"\n\n[ref]'), {
    words: 5,
    characters: 26,
  })
  let cases = 0
  for (const [open, close] of [
    ['"', '"'],
    ["'", "'"],
    ['(', ')'],
  ])
    for (const separator of [' ', '\n'])
      for (const eol of ['\n', '\r\n', '\r'])
        for (const line of [
          '',
          ' ',
          '\t',
          '# two',
          '#',
          '> two',
          '- two',
          '- ',
          '-',
          '* two',
          '1. two',
          '1) two',
          '2. two',
          '```',
          '~~~',
          '***',
          '---',
          '- - -',
          '___',
          '<div>',
          '<!-- x',
          '<script>',
          '===',
          '   ===',
          'plain',
        ]) {
          const source =
            `[ref]: /x${separator}${open}one\n${line}\nlast${close}\n\n[ref]`.replaceAll(
              '\n',
              eol,
            )
          counterFixture(t, source)
          cases++
        }
  assert.equal(cases, 450)
})

test('regional title lookahead follows gfm tables through delimiter edits and undo', (t) => {
  for (const [open, close] of [
    ['"', '"'],
    ["'", "'"],
    ['(', ')'],
  ])
    for (const separator of [' ', '\n'])
      for (const gfm of [false, true]) {
        const config = { ...syntax, gfm }
        const source = `[ref]: /x${separator}${open}one\na | b\n--|--\nlast${close}\n\n[ref]`
        const { edit } = counterFixture(t, source, config)
        const from = source.indexOf('--|--')
        edit([{ from, to: from + 5, insert: 'plain' }])
        edit([{ from, to: from + 5, insert: '--|--' }], 'undo')
        const header = source.indexOf('a | b')
        edit([{ from: header, to: header + 5, insert: 'a b' }])
        edit([{ from: header, to: header + 3, insert: 'a | b' }], 'undo')
      }
})

test('regional title lookahead invalidates gfm headers and delimiters', (t) => {
  const source = '[ref]: /x "one\na | b\n--|--\nlast"\n\n[ref]'
  const f = fixture(t, source, true)
  assert.equal(f.brackets.canClose(0), false)
  const header = source.indexOf('a | b')
  assert.deepEqual(
    f.edit([{ from: header, to: header + 5, insert: 'a b' }]),
    [0],
  )
  assert.equal(f.brackets.canClose(0), true)
  assert.notEqual(f.brackets.canTitle(0, source.indexOf('\n'), '"'), null)
  assert.deepEqual(
    f.edit([{ from: header, to: header + 3, insert: 'a | b' }], 'undo'),
    [0],
  )
  assert.equal(f.brackets.canClose(0), false)
  const delimiter = source.indexOf('--|--')
  assert.deepEqual(
    f.edit([{ from: delimiter, to: delimiter + 5, insert: 'plain' }]),
    [0],
  )
  assert.equal(f.brackets.canClose(0), true)
  assert.notEqual(f.brackets.canTitle(0, source.indexOf('\n'), '"'), null)
  assert.deepEqual(
    f.edit([{ from: delimiter, to: delimiter + 5, insert: '--|--' }], 'undo'),
    [0],
  )
  assert.equal(f.brackets.canClose(0), false)
})

test('native escaped title completion updates distant counts through undo', (t) => {
  for (const eol of ['\n', '\r\n'])
    for (const [open, gap, close] of [
      ['"', '\n\n', '"'],
      ["'", '\n', "'"],
      ['(', '\n\n', ')'],
    ]) {
      const source = `[ref]: /target ${open}first${gap}last\\`.replaceAll(
        '\n',
        eol,
      )
      const { edit } = counterFixture(t, source)
      const end = source.length
      edit([{ from: end, to: end, insert: close }])
      edit([{ from: end, to: end + 1, insert: '' }], 'undo')
      edit([{ from: end, to: end, insert: close }], 'redo')
    }
})

test('header repairs reuse the cached closing marker without rescanning label markers', (t) => {
  for (const eol of ['\n', '\r\n']) {
    const source =
      `[first\n\n${'literal \\[x\\] words\n\n'.repeat(250)}last]: <broken`.replaceAll(
        '\n',
        eol,
      )
    const f = fixture(t, source)
    assert.equal(f.brackets.canClose(0), false)
    assert.ok(f.brackets.counters().markerVisits > 250)
    f.brackets.counters(true)
    const from = source.length
    assert.deepEqual(f.edit([{ from, to: from, insert: '>' }]), [0])
    let work = f.brackets.counters(true)
    assert.equal(work.candidateQueries, 1)
    assert.equal(work.markerVisits, 0)
    assert.ok(work.readUnits < 1024, JSON.stringify(work))
    assert.deepEqual(f.edit([{ from, to: from + 1, insert: '' }], 'undo'), [])
    work = f.brackets.counters(true)
    assert.equal(work.candidateQueries, 1)
    assert.equal(work.markerVisits, 0)
    assert.deepEqual(f.edit([{ from, to: from, insert: '>' }], 'redo'), [0])
  }
})

test('invalid destinations and unfinished same-line titles keep paragraph work local', (t) => {
  for (const paragraphs of [1000, 4000])
    for (const eol of ['\n', '\r\n'])
      for (const destination of ['<broken', '/target "unfinished', '']) {
        const source =
          `[first\n\n${'plain words here\n\n'.repeat(paragraphs)}last]: ${destination}`.replaceAll(
            '\n',
            eol,
          )
        const { counter } = counterFixture(t, source)
        counter.counters(true)
        const from = source.lastIndexOf('last') + 1
        counter.apply(
          operation(counter.store, [{ from, to: from, insert: 'x' }]),
        )
        assert.deepEqual(
          read(counter),
          expected(`${source.slice(0, from)}x${source.slice(from)}`),
        )
        const work = counter.counters(true)
        const details = JSON.stringify({ paragraphs, eol, destination, work })
        assert.ok(work.countedUnits < 1024, details)
        assert.ok(work.referenceUnits < 1024, details)
        assert.ok(work.source.sourceUnitsRead < 4096, details)
        assert.ok(work.parser.parser.readUnits < 1024, details)
        assert.ok(work.brackets.readUnits < 1024, details)
        assert.equal(work.source.materializations, 0, details)
      }
})

test('destination and title repairs invalidate earlier labels through undo and redo', (t) => {
  for (const eol of ['\n', '\r\n'])
    for (const [destination, closer] of [
      ['<broken', '>'],
      ['/target "unfinished', '"'],
      ['', '/target'],
    ]) {
      const source =
        `[first\n\n${'plain words here\n\n'.repeat(40)}last]: ${destination}`.replaceAll(
          '\n',
          eol,
        )
      const { edit } = counterFixture(t, source)
      const end = source.length
      edit([{ from: end, to: end, insert: closer }])
      edit([{ from: end, to: end + closer.length, insert: '' }], 'undo')
      edit([{ from: end, to: end, insert: closer }], 'redo')
    }
})

test('unfinished optional titles stay literal until distant completion and undo', (t) => {
  for (const eol of ['\n', '\r\n'])
    for (const suffix of ['', '" trailing']) {
      const source =
        `[ref]: /target\n"title\n\n${'plain words here\n\n'.repeat(1000)}last${suffix}`.replaceAll(
          '\n',
          eol,
        )
      const { counter, edit } = counterFixture(t, source)
      counter.counters(true)
      const from = source.indexOf('words', source.length / 2) + 2
      counter.apply(operation(counter.store, [{ from, to: from, insert: 'x' }]))
      assert.deepEqual(
        read(counter),
        expected(`${source.slice(0, from)}x${source.slice(from)}`),
      )
      const work = counter.counters(true)
      assert.ok(work.countedUnits < 1024, JSON.stringify(work))
      assert.ok(work.source.sourceUnitsRead < 4096, JSON.stringify(work))
      assert.ok(work.brackets.readUnits < 1024, JSON.stringify(work))
      const end = counter.store.snapshot().utf16Length
      const start = suffix ? end - ' trailing'.length : end
      const removed = suffix ? ' trailing' : ''
      const insert = suffix ? '' : '"'
      edit([{ from: start, to: end, insert }])
      edit(
        [{ from: start, to: start + insert.length, insert: removed }],
        'undo',
      )
    }
})

test('ordinary suffix edits after pending escaped closers invalidate the earlier definition', (t) => {
  for (const eol of ['\n', '\r\n']) {
    const source =
      `[ref]: /x "first\\"\n\n${'plain words here\n\n'.repeat(30)}middle\\" trailing\n\nend`.replaceAll(
        '\n',
        eol,
      )
    const { edit } = counterFixture(t, source)
    const from = source.indexOf(' trailing')
    edit([{ from, to: from + ' trailing'.length, insert: '' }])
    edit([{ from, to: from, insert: ' trailing' }], 'undo')
    edit([{ from, to: from + ' trailing'.length, insert: '' }], 'redo')
  }
})

test('filling a blank title line notifies a previously invalid definition', (t) => {
  for (const eol of ['\n', '\r\n']) {
    const source = "[ref]: /x 'one\n\nlast'".replaceAll('\n', eol)
    const f = fixture(t, source)
    assert.equal(f.brackets.canClose(0), false)
    const from = source.indexOf(eol + eol) + eol.length
    assert.deepEqual(f.edit([{ from, to: from, insert: 'x' }]), [0])
    assert.equal(f.brackets.canClose(0), true)
  }
})

test('definition candidates retain native destination post-validation', (t) => {
  for (const destination of [
    '/target(',
    '/target)',
    '/target(x',
    '/target(x)',
    '<target(>',
  ]) {
    const source = `[ref\n\n]: ${destination}`
    const f = fixture(t, source)
    const valid =
      Object.keys(countParser(syntax).lexer(source).links).length > 0
    assert.equal(f.brackets.canClose(0), valid, destination)
  }
  for (const paragraphs of [100, 400])
    for (const destination of ['/target(', '/target)', '/target(x']) {
      const source = `[first\n\n${'plain words here\n\n'.repeat(paragraphs)}last]: ${destination}`
      const { counter } = counterFixture(t, source)
      counter.counters(true)
      const from = source.indexOf('words', source.length / 2) + 2
      counter.apply(operation(counter.store, [{ from, to: from, insert: 'x' }]))
      assert.deepEqual(
        read(counter),
        expected(`${source.slice(0, from)}x${source.slice(from)}`),
      )
      const work = counter.counters()
      assert.ok(work.countedUnits < 1024, JSON.stringify(work))
      assert.ok(work.referenceUnits < 1024, JSON.stringify(work))
      assert.ok(work.brackets.readUnits < 1024, JSON.stringify(work))
      assert.equal(work.source.materializations, 0)
    }
})
