import assert from 'node:assert/strict'
import test from 'node:test'
import { countText } from '../src/addons/word-count/count.ts'
import { FormattedCounter } from '../src/addons/word-count/formatted-counter.ts'
import { richText } from '../src/addons/word-count/formatted-text.ts'
import { defaultNoteSyntax } from '../src/shared/note-syntax.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'

const syntax = { ...defaultNoteSyntax, alerts: true, textExtras: true }
function count(counter) {
  const work = counter.read()
  for (;;) {
    const next = work.next()
    if (next.done) return next.value
  }
}
function edit(counter, from, to, insert, origin = 'source') {
  const before = counter.store.snapshot()
  counter.apply({
    document: before.document,
    operationId: crypto.randomUUID(),
    baseVersion: before.version,
    contentVersion: before.version + 1,
    origin,
    historyGroup: 'count-test',
    changes: [{ from, to, insert }],
  })
}
function fixture(t, source) {
  const counter = new FormattedCounter(
    new SourceStore(source, { tabId: 'counts', revision: 0 }),
    syntax,
  )
  t.after(() => counter.dispose())
  return counter
}
test('regional counts equal a full rich-text projection across syntax boundaries', (t) => {
  for (const source of [
    '',
    '\n\n',
    'one\n\ntwo\n\n\nthree',
    '# title\nbody\n---\n\nlast',
    '> quote\n> - list\n\nparagraph',
    '- [ ] one\n- [x] two',
    '| a | b |\n|---|---|\n| c | d |',
    '~~strike~~ and H~2~O\n\n-# small',
    '[label][ref]\n\n[ref]: https://example.test',
    'one[^a]\n\n[^a]: explanation',
    'one[^a]\n\nother\n\n[^a]: explanation',
    'one\r\n\r\ncafé 👩🏽‍💻',
    '<div>\nliteral &amp;\n</div>\n\n[link](target)',
  ]) {
    const counter = fixture(t, source)
    assert.deepEqual(
      count(counter),
      countText(richText(source, syntax).slice(1)),
      JSON.stringify(source),
    )
  }
})
for (const language of ['mermaid', 'typst'])
  test(`${language} opacity follows fence edits and undo`, (t) => {
    const config = { ...syntax, [language]: true }
    const source = `before\n\n\`\`\`${language}\nx\n\`\`\`\n\nafter`
    const counter = new FormattedCounter(
      new SourceStore(source, { tabId: 'opaque', revision: 0 }),
      config,
    )
    t.after(() => counter.dispose())
    assert.deepEqual(count(counter), { words: 2, characters: 13 })
    const at = source.indexOf(language)
    edit(counter, at, at + language.length, 'js')
    const code = source.replace(language, 'js')
    assert.deepEqual(count(counter), countText(richText(code, config).slice(1)))
    edit(counter, at, at + 2, language, 'undo')
    assert.deepEqual(count(counter), { words: 2, characters: 13 })
    const close = source.lastIndexOf('\`\`\`')
    edit(counter, close, close + 3, '')
    const unclosed = source.slice(0, close) + source.slice(close + 3)
    assert.deepEqual(
      count(counter),
      countText(richText(unclosed, config).slice(1)),
    )
    edit(counter, close, close, '\`\`\`', 'undo')
    assert.deepEqual(count(counter), { words: 2, characters: 13 })
    assert.equal(counter.store.snapshot().sliceRaw(0, source.length), source)
  })

test('leading indentation and undo keep fence counts equal to a fresh projection', (t) => {
  const config = { ...syntax, typst: true, mermaid: true }
  const expected = (text) => countText(richText(text, config).slice(1))
  for (const body of ['```\n```\nd', '~~~typst\nx\n~~~\n\ntail'])
    for (const prefix of ['', 'before\n\n'])
      for (const insert of ['\t', '    ']) {
        const source = prefix + body
        const changed = prefix + insert + body
        const counter = new FormattedCounter(
          new SourceStore(source, { tabId: 'indent', revision: 0 }),
          config,
        )
        t.after(() => counter.dispose())
        assert.deepEqual(count(counter), expected(source))
        for (let cycle = 0; cycle < 2; cycle++) {
          edit(counter, prefix.length, prefix.length, insert)
          assert.deepEqual(count(counter), expected(changed), changed)
          edit(
            counter,
            prefix.length,
            prefix.length + insert.length,
            '',
            'undo',
          )
          assert.deepEqual(count(counter), expected(source), `undo ${changed}`)
        }
      }
})

test('line break edits that retain indentation keep fresh counts through undo', (t) => {
  const source = '-     c\n\n  =\n'
  const counter = fixture(t, source)
  const original = count(counter)
  edit(counter, 1, 3, '\n')
  const fresh = fixture(t, counter.store.snapshot().materialize())
  assert.deepEqual(count(counter), count(fresh))
  assert.deepEqual(count(counter), { words: 1, characters: 7 })
  edit(counter, 1, 2, '  ', 'undo')
  assert.deepEqual(count(counter), original)
})

test('a blank line before empty-marker lists keeps fresh counts through undo', (t) => {
  const source = '\n  h\n\n1.\n1. \n   c\n\n   e'
  const counter = fixture(t, source)
  const original = count(counter)
  edit(counter, 0, 4, '  ')
  const fresh = fixture(t, counter.store.snapshot().materialize())
  assert.deepEqual(count(counter), count(fresh))
  assert.deepEqual(count(counter), { words: 2, characters: 10 })
  edit(counter, 0, 2, source.slice(0, 4), 'undo')
  assert.deepEqual(count(counter), original)
})

test('regional fence termination matches Marked through tab edits and undo', (t) => {
  for (const language of ['mermaid', 'js', 'typst']) {
    for (const marker of ['```', '~~~']) {
      for (const eol of ['\n', '\r\n'])
        for (const indent of ['', ' ', '   ']) {
          const config = { ...syntax, mermaid: true, typst: true }
          const source = `before${eol}${eol}${indent}${marker}${language}${eol}x${eol}${indent}${marker}${eol}${eol}after`
          const counter = new FormattedCounter(
            new SourceStore(source, { tabId: 'closing', revision: 0 }),
            config,
          )
          t.after(() => counter.dispose())
          const expected = (text) => countText(richText(text, config).slice(1))
          assert.deepEqual(count(counter), expected(source))
          const at = source.lastIndexOf(marker) + marker.length
          const changed = source.slice(0, at) + '\t' + source.slice(at)
          for (let cycle = 0; cycle < 2; cycle++) {
            edit(counter, at, at, '\t', cycle ? 'redo' : 'source')
            assert.deepEqual(
              count(counter),
              expected(changed),
              JSON.stringify({ language, marker, eol, indent, cycle }),
            )
            edit(counter, at, at + 1, '', 'undo')
            assert.deepEqual(count(counter), expected(source))
          }
        }
    }
  }
})

test('leading blank lines retain their first empty paragraph', (t) => {
  for (const eol of ['\n', '\r\n']) {
    const source = `${eol}${eol}body`
    const counter = fixture(t, source)
    assert.deepEqual(
      count(counter),
      countText(richText(source, syntax).slice(1)),
    )
    edit(counter, 0, eol.length * 2, '')
    assert.deepEqual(count(counter), countText('body'))
    edit(counter, 0, 0, eol + eol, 'undo')
    assert.deepEqual(
      count(counter),
      countText(richText(source, syntax).slice(1)),
    )
  }
})
test('opaque math spans blank lines through edits, undo and disabled syntax', (t) => {
  for (const eol of ['\n', '\r\n']) {
    for (const config of [
      { ...syntax, math: true },
      { ...syntax, math: true, disabledFeatures: ['math.block'] },
      { ...syntax, math: false },
    ]) {
      const source = 'before\n\n$$\nx\n\ny\n$$\n\nafter'.replaceAll('\n', eol)
      const counter = new FormattedCounter(
        new SourceStore(source, { tabId: 'math', revision: 0 }),
        config,
      )
      t.after(() => counter.dispose())
      const expected = (text) => countText(richText(text, config).slice(1))
      assert.deepEqual(count(counter), expected(source))
      const close = source.lastIndexOf('$$')
      edit(counter, close, close + 2, '')
      const changed = source.slice(0, close) + source.slice(close + 2)
      assert.deepEqual(count(counter), expected(changed))
      edit(counter, close, close, '$$', 'undo')
      assert.deepEqual(count(counter), expected(source))
      assert.equal(counter.store.snapshot().sliceRaw(0, source.length), source)
    }
  }
})
test('frontmatter is excluded; edits, reference changes, undo and cancelled work retain totals', (t) => {
  const body =
    '# title\r\n\r\n[label][ref]\r\n\r\n-# body 👩🏽‍💻\r\n\r\n[ref]: old\r\n'
  const prefix = '---\r\ntitle: private\r\n---\r\n'
  const counter = fixture(t, prefix + body)
  assert.deepEqual(count(counter), countText(richText(body, syntax).slice(1)))
  const from = prefix.length + body.indexOf('body')
  edit(counter, from, from + 4, 'new words')
  let current = body.replace('body', 'new words')
  assert.deepEqual(
    count(counter),
    countText(richText(current, syntax).slice(1)),
  )
  edit(counter, from, from + 9, 'body', 'undo')
  assert.deepEqual(count(counter), countText(richText(body, syntax).slice(1)))
  const ref = prefix.length + body.indexOf('[ref]:')
  edit(counter, ref, ref + 1, '')
  current =
    body.slice(0, body.indexOf('[ref]:')) +
    body.slice(body.indexOf('[ref]:') + 1)
  const pending = counter.read()
  pending.next()
  pending.return()
  assert.deepEqual(
    count(counter),
    countText(richText(current, syntax).slice(1)),
  )
})
test('editing metadata keeps totals; removing and undoing its delimiter changes body ownership', (t) => {
  const prefix = '---\r\ntitle: private\r\n---\r\n'
  const body = '# Title\r\n\r\none two'
  const counter = fixture(t, prefix + body)
  const expected = countText(richText(body, syntax).slice(1))
  assert.deepEqual(count(counter), expected)
  edit(
    counter,
    prefix.indexOf('private'),
    prefix.indexOf('private') + 7,
    'changed metadata',
  )
  assert.deepEqual(count(counter), expected)
  const current = counter.store
    .snapshot()
    .sliceRaw(0, counter.store.snapshot().utf16Length)
  const closing = current.indexOf('---', 3)
  edit(counter, closing, closing + 3, 'xxx')
  assert.deepEqual(
    count(counter),
    countText(
      richText(
        current.slice(0, closing) + 'xxx' + current.slice(closing + 3),
        syntax,
      ).slice(1),
    ),
  )
  edit(counter, closing, closing + 3, '---', 'undo')
  assert.deepEqual(count(counter), expected)
})

test('reference and footnote deletion invalidate distant dependent counts', (t) => {
  for (const source of [
    '[some]: other\n\ntext [some]\n\nlast',
    '[^some]: footnote\n\ntext[^Some]\n\nlast',
    '[some]: other\n\n- [ ] text [some]\n\nlast',
    '[^some]: footnote\n\n- [ ] text[^Some]\n\nlast',
  ]) {
    const counter = fixture(t, source)
    assert.deepEqual(
      count(counter),
      countText(richText(source, syntax).slice(1)),
    )
    const end = source.indexOf('\n\n') + 2
    edit(counter, 0, end, '')
    const pending = counter.read()
    for (let step = 0; step < 3; step++) if (pending.next().done) break
    pending.return()
    assert.deepEqual(
      count(counter),
      countText(richText(source.slice(end), syntax).slice(1)),
    )
    edit(counter, 0, 0, source.slice(0, end), 'undo')
    assert.deepEqual(
      count(counter),
      countText(richText(source, syntax).slice(1)),
    )
  }
})

test('removing a fence boundary recounts its preceding semantic anchor', (t) => {
  const config = {
    ...syntax,
    disabledFeatures: [
      'core.bullet-lists',
      'core.links',
      'core.images',
      'core.code-blocks',
    ],
  }
  const source = '-\ne\n-\n```j[^'
  const counter = new FormattedCounter(
    new SourceStore(source, { tabId: 'fence', revision: 0 }),
    config,
  )
  t.after(() => counter.dispose())
  const expected = (text) => countText(richText(text, config).slice(1))
  assert.deepEqual(count(counter), expected(source))
  edit(counter, 8, 12, '**')
  assert.deepEqual(count(counter), expected('-\ne\n-\n``**'))
  edit(counter, 8, 10, '`j[^', 'undo')
  assert.deepEqual(count(counter), expected(source))
})

for (const math of [false, true])
  test(`unchanged regions retain counts after a local edit with math=${math}`, (t) => {
    const source = 'a paragraph with **bold** text and emoji 😀.\n\n'.repeat(
      1500,
    )
    const counter = new FormattedCounter(
      new SourceStore(source, { tabId: 'bounded', revision: 0 }),
      { ...syntax, math },
    )
    t.after(() => counter.dispose())
    count(counter)
    counter.counters(true)
    const from = source.indexOf('paragraph', source.length / 2)
    edit(counter, from, from + 9, 'words')
    assert.deepEqual(
      count(counter),
      countText(
        richText(
          source.slice(0, from) + 'words' + source.slice(from + 9),
          syntax,
        ).slice(1),
      ),
    )
    const work = counter.counters()
    assert.ok(work.countedUnits < 1024, JSON.stringify(work))
    assert.ok(work.referenceUnits < 1024, JSON.stringify(work))
  })
