import assert from 'node:assert/strict'
import test from 'node:test'
import { countText } from '../src/addons/word-count/count.ts'
import { FormattedCounter } from '../src/addons/word-count/formatted-counter.ts'
import { richText } from '../src/addons/word-count/formatted-text.ts'
import { defaultNoteSyntax } from '../src/shared/note-syntax.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'

const syntax = { ...defaultNoteSyntax, alerts: true, textExtras: true }
function read(counter) {
  const work = counter.read()
  for (;;) {
    const step = work.next()
    if (step.done) return step.value
  }
}

for (const [source, text] of [
  ['> [!NOTE]\n> a\n>\n>\n>\n> b', '\na\nb'],
  ['> [!NOTE]\n>\n>\n> a\n>\n>', '\na'],
  [
    '| a | b |\n|---|---|\n| c | d |\n\n> [!TIP]\n> **careful**\n\n~~strike~~',
    '\n\n\na\n\nb\n\n\nc\n\nd\n\ncareful\nstrike',
  ],
  ['carriage&#13;\n\n# after 👩🏽‍💻\n\né 🇵🇭', 'carriage\r\nafter 👩🏽‍💻\né 🇵🇭'],
])
  test(`native block and grapheme boundaries: ${JSON.stringify(source)}`, () => {
    assert.equal(richText(source, syntax).slice(1), text)
    const counter = new FormattedCounter(
      new SourceStore(source, { tabId: 'boundaries', revision: 0 }),
      syntax,
    )
    try {
      assert.deepEqual(read(counter), countText(text))
    } finally {
      counter.dispose()
    }
  })

test('structural edits reconcile carriage seams and the last visible region', () => {
  const initial = 'carriage&#13;\n\n# after\n\n[ref]: /target'
  for (const at of [0, 8, 13, 14, 15, initial.length])
    for (const insert of ['x', '\n', '\r', '[a]: /x\n\n']) {
      const counter = new FormattedCounter(
        new SourceStore(initial, { tabId: 'edit', revision: 0 }),
        syntax,
      )
      try {
        read(counter)
        counter.apply({
          document: { tabId: 'edit', revision: 0 },
          operationId: 'edit',
          baseVersion: 0,
          contentVersion: 1,
          origin: 'source',
          historyGroup: 'edit',
          changes: [{ from: at, to: at, insert }],
        })
        const source = initial.slice(0, at) + insert + initial.slice(at)
        assert.deepEqual(
          read(counter),
          countText(richText(source, syntax).slice(1)),
          JSON.stringify({ at, insert }),
        )
      } finally {
        counter.dispose()
      }
    }
})

for (const source of [
  'carriage&#13;',
  'carriage&#13;\n\n[ref]: /target',
  'carriage&#13;\n\n[ref]: /target\n\n# after',
  '&#13;\n\n&#13;\n\nlast',
])
  test(`regional counts retain terminal carriage returns: ${JSON.stringify(source)}`, () => {
    const counter = new FormattedCounter(
      new SourceStore(source, { tabId: 'terminal', revision: 0 }),
      syntax,
    )
    try {
      assert.deepEqual(
        read(counter),
        countText(richText(source, syntax).slice(1)),
      )
    } finally {
      counter.dispose()
    }
  })
