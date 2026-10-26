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

test('unchanged regions retain counts after an ordinary local edit', (t) => {
  const source = 'a paragraph with **bold** text and emoji 😀.\n\n'.repeat(1500)
  const counter = fixture(t, source)
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
