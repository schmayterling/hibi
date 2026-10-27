import assert from 'node:assert/strict'
import test from 'node:test'
import { countText } from '../src/addons/word-count/count.ts'
import { FormattedCounter } from '../src/addons/word-count/formatted-counter.ts'
import { richText } from '../src/addons/word-count/formatted-text.ts'
import { defaultNoteSyntax } from '../src/shared/note-syntax.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'

const syntax = {
  ...defaultNoteSyntax,
  math: true,
  textExtras: true,
  alerts: true,
}
function read(counter) {
  const work = counter.read()
  for (;;) {
    const step = work.next()
    if (step.done) return step.value
  }
}
function change(counter, at, insert) {
  const source = counter.store.snapshot()
  counter.apply({
    document: source.document,
    operationId: crypto.randomUUID(),
    baseVersion: source.version,
    contentVersion: source.version + 1,
    origin: 'source',
    historyGroup: 'shape-scale',
    changes: [{ from: at, to: at, insert }],
  })
}
function bounded(counter, before, at, name, insert = ' y ', words = 2) {
  counter.counters(true)
  change(counter, at, insert)
  const result = read(counter)
  assert.equal(result.words, before.words + words)
  assert.equal(result.characters, before.characters + insert.length)
  const work = counter.counters()
  console.log(
    JSON.stringify({
      name,
      countedUnits: work.countedUnits,
      referenceUnits: work.referenceUnits,
      source: work.source,
      parser: work.parser,
      brackets: work.brackets,
    }),
  )
  assert.ok(work.countedUnits < 1024, JSON.stringify(work))
  assert.equal(work.referenceUnits, 0)
  assert.ok(work.source.sourceUnitsRead < 4096, JSON.stringify(work))
  assert.equal(work.source.materializations, 0)
  assert.equal(work.source.materializedUnits, 0)
  assert.equal(work.parser.parser.readUnits, 0)
  assert.ok(work.brackets.readUnits < 1024, JSON.stringify(work))
  assert.equal(
    counter.store.snapshot().sliceRaw(at, at + insert.length),
    insert,
  )
  return result
}

test('50 MiB formatted projections and reference reads retain long paragraphs', {
  timeout: 180000,
}, () => {
  const size = 50 * 1024 * 1024
  for (const unit of ['ordinary words. ', 'ordinary words.\n']) {
    const source = `${unit.repeat(Math.ceil(size / unit.length)).slice(0, size - 1)}x`
    assert.ok(
      richText(source, syntax).slice(1) === source.replaceAll('\n', ' '),
      JSON.stringify({ unit, size }),
    )
  }
  // Formatting prevents the plain-source shortcut from skipping reference lexing.
  const source = `**start** ${'ordinary words. '.repeat(size / 16)}`
  const counter = new FormattedCounter(
    new SourceStore(source, { tabId: 'long-reference-scale', revision: 0 }),
    syntax,
  )
  try {
    assert.deepEqual(read(counter), countText(`start ${source.slice(10)}`))
    assert.ok(counter.counters().referenceUnits >= size)
  } finally {
    counter.dispose()
  }
})

test('50 MiB single paragraph retains local counts at its endpoints and three depths', {
  timeout: 180000,
}, () => {
  const size = 50 * 1024 * 1024
  const source = 'ordinary words. '.repeat(Math.ceil(size / 16)).slice(0, size)
  const counter = new FormattedCounter(
    new SourceStore(source, { tabId: 'long-scale', revision: 0 }),
    syntax,
  )
  try {
    let total = read(counter)
    // each complete sentence has two words; this fixture ends at a sentence boundary.
    assert.equal(total.words, (size / 16) * 2)
    assert.equal(total.characters, size)
    total = bounded(counter, total, 0, 'single-paragraph-start', 'z', 0)
    let shift = 1
    for (const depth of [1 / 4, 1 / 2, 3 / 4]) {
      const at = Math.floor((size * depth) / 16) * 16 + 3 + shift
      total = bounded(counter, total, at, 'single-paragraph')
      shift += 3
    }
    bounded(
      counter,
      total,
      counter.store.snapshot().utf16Length,
      'single-paragraph-end',
      'z',
      1,
    )
  } finally {
    counter.dispose()
  }
})

test('50 MiB unclosed labels keep distant ordinary edits local', {
  timeout: 180000,
}, () => {
  const paragraph = 'plain words here. '.repeat(64)
  const unit = `${paragraph}\n\n`
  const units = Math.ceil((50 * 1024 * 1024) / unit.length)
  for (const prefix of ['[first\n\n', '[^afirst\n\n']) {
    const counter = new FormattedCounter(
      new SourceStore(`${prefix}${unit.repeat(units)}last`, {
        tabId: 'unclosed-scale',
        revision: 0,
      }),
      syntax,
    )
    try {
      const first = countText(
        richText(`${prefix}${unit}`, syntax, { after: true }),
      )
      const middle = countText(
        richText(unit, syntax, { before: true, after: true }),
      )
      const last = countText(richText('last', syntax, { before: true }))
      let total = read(counter)
      assert.deepEqual(total, {
        words: first.words + middle.words * (units - 1) + last.words,
        characters:
          first.characters +
          middle.characters * (units - 1) +
          last.characters -
          1,
      })
      let shift = 0
      for (const depth of [1 / 4, 1 / 2, 3 / 4]) {
        const at =
          prefix.length + unit.length * Math.floor(units * depth) + 3 + shift
        total = bounded(counter, total, at, 'unclosed-label')
        shift += 3
      }
    } finally {
      counter.dispose()
    }
  }
})

test('50 MiB mixed blocks retain counts inside long marked paragraphs', {
  timeout: 180000,
}, () => {
  const paragraph = 'ordinary words. '.repeat(2200)
  const unit = `# heading\n\n**bold** ${paragraph}**last**\n\n> quote\n> next\n\n- one\n- two\n\n| a | b |\n|---|---|\n| c | d |\n\n\`\`\`js\nx=1\n\`\`\`\n\n$$\nx\n\ny\n$$\n\n[label][ref]\n\n[ref]: https://example.test\n\n`
  const units = Math.ceil((50 * 1024 * 1024) / unit.length)
  const counter = new FormattedCounter(
    new SourceStore(unit.repeat(units), { tabId: 'mixed-scale', revision: 0 }),
    syntax,
  )
  try {
    const first = countText(richText(unit, syntax, { after: true }))
    const middle = countText(
      richText(unit, syntax, { before: true, after: true }),
    )
    const last = countText(richText(unit, syntax, { before: true }))
    let total = read(counter)
    assert.deepEqual(total, {
      words: first.words + middle.words * (units - 2) + last.words,
      characters:
        first.characters +
        middle.characters * (units - 2) +
        last.characters -
        1,
    })
    let shift = 0
    for (const index of [
      Math.floor(units / 4),
      Math.floor(units / 2),
      Math.floor((units * 3) / 4),
    ]) {
      const at = unit.length * index + unit.indexOf('ordinary') + 1027 + shift
      total = bounded(counter, total, at, 'mixed-blocks')
      shift += 3
    }
  } finally {
    counter.dispose()
  }
})
