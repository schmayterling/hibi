import assert from 'node:assert/strict'
import test from 'node:test'
import { parser } from '@lezer/markdown'
import { MarkdownBoundaryIndex } from '../src/shared/markdown-boundary-index.ts'
import { MarkdownCodeExtents } from '../src/shared/markdown-code-extents.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'
import {
  editorChangesFromSource,
  normalizedSource,
} from '../src/shared/source-projection.ts'

const config = {
  schema: 1,
  syntax: [],
  flavors: [],
  literal: [],
  opaque: ['FencedCode'],
  prefix: 0,
  chunkSize: 64,
  groupSize: 4,
  giantBlock: 1024,
}
function extents(text) {
  const store = new SourceStore(text, { tabId: 'code-extents', revision: 0 })
  const index = new MarkdownBoundaryIndex(store.snapshot(), config)
  while (!index.advance()) {}
  return [...index.pages()].flatMap((page) => page.code?.records ?? [])
}
test('boundary pages carry fenced and indented code bodies, lines, and tab-expanded widths', () => {
  assert.deepEqual(extents('~~~js\nwide\tline\n~~~\n\n    indented\n'), [
    {
      from: 0,
      to: 19,
      kind: 'fenced',
      contentFrom: 6,
      contentTo: 16,
      contentLines: 1,
      contentColumns: 12,
      closed: true,
    },
    {
      from: 21,
      to: 33,
      kind: 'indented',
      contentFrom: 25,
      contentTo: 33,
      contentLines: 1,
      contentColumns: 8,
      closed: true,
    },
  ])
})

const ticks = String.fromCharCode(96).repeat(3)
function columns(text) {
  let result = 0
  for (let i = 0; i < text.length; i++)
    result += text[i] === '\t' ? 4 - (result % 4) : 1
  return result
}
function fresh(raw) {
  const text = normalizedSource(raw),
    lines = text.split('\n'),
    starts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
  const line = (at) => {
    let low = 0,
      high = starts.length
    while (low + 1 < high) {
      const mid = (low + high) >>> 1
      if (starts[mid] <= at) low = mid
      else high = mid
    }
    return low
  }
  const output = []
  parser.parse(text).iterate({
    enter(ref) {
      if (ref.name !== 'FencedCode' && ref.name !== 'CodeBlock') return
      const node = ref.node,
        first = line(node.from),
        last = line(Math.max(node.from, node.to - 1))
      const fenced = node.name === 'FencedCode',
        close = node.lastChild
      const closed =
        !fenced || (close?.name === 'CodeMark' && close.from > node.from)
      const to = starts[last] + lines[last].length
      const body = fenced ? (starts[first + 1] ?? text.length) : node.from
      const contentFrom = Math.min(body, to)
      const contentTo = fenced && closed ? starts[line(close.from)] : to
      const contentLines = !fenced
        ? last - first + 1
        : closed
          ? line(close.from) - first - 1
          : node.to > body
            ? last - first
            : 0
      const pieces = node.getChildren('CodeText')
      let contentColumns = 0,
        piece = 0
      for (
        let number = fenced ? first + 1 : first;
        number <= (fenced && closed ? line(close.from) - 1 : last);
        number++
      ) {
        while (piece < pieces.length && pieces[piece].to <= starts[number])
          piece++
        const end = starts[number] + lines[number].length,
          next = pieces[piece]
        const from =
          next && next.from <= end ? Math.max(next.from, starts[number]) : end
        contentColumns = Math.max(
          contentColumns,
          columns(text.slice(from, end)),
        )
      }
      output.push({
        from: starts[first],
        to,
        kind: fenced ? 'fenced' : 'indented',
        contentFrom,
        contentTo,
        contentLines,
        contentColumns,
        closed,
      })
      return false
    },
  })
  return output
}
function prepare(store, changes) {
  const before = store.snapshot()
  const operation = store.prepare({
    document: before.document,
    operationId: crypto.randomUUID(),
    baseVersion: before.version,
    contentVersion: before.version + 1,
    origin: 'source',
    historyGroup: 'extent-test',
    changes,
  })
  store.commit(operation)
  return operation
}
function drain(index) {
  while (!index.advance()) {}
}
function collect(index) {
  const pages = [...index.pages()]
  for (const page of pages) {
    assert.ok(page.records.length + (page.code?.records.length ?? 0) <= 128)
    assert.ok(
      JSON.stringify(page.records).length +
        JSON.stringify(page.code ?? {}).length <
        17000,
    )
  }
  const code = pages.flatMap((page) => (page.code ? [page.code] : []))
  assert.equal(code[0].from, 0)
  assert.equal(code.at(-1).to, index.length)
  for (let i = 1; i < code.length; i++)
    assert.equal(code[i].from, code[i - 1].to)
  return code.flatMap((page) => page.records)
}

test('source line endings, empty bodies, eof fences, and container prefixes preserve exact code rows', () => {
  const cases = [
    ticks,
    ticks + '\n',
    ticks + '\n\n',
    ticks + '\n' + ticks + '\n',
    '  ~~~js\n  first\n\tsecond\n  ~~~  \n',
    '> - ~~~\n>   a\tq\n>     bb\n>   ~~~\n',
    '> ~~~\n> x\n> \n> y\n> ~~~\n\ntext\n',
    '> ~~~\n> unclosed\n\nplain\n',
    '- item\n\n      indented\n\t  continued\n',
    '    one\n\t  two\n\n    three\n',
    '~~~\n' + 'body\ttext\n'.repeat(400) + '~~~\n',
    '> - ~~~\n' + '>   body\ttext\n'.repeat(400) + '>   ~~~\n',
    '~~~\nemoji 😀 e\u0301\n~~~\n',
  ]
  for (const ending of ['\n', '\r\n', '\r'])
    for (const value of cases) {
      const text = value.replaceAll('\n', ending)
      assert.deepEqual(
        extents(text),
        fresh(text),
        JSON.stringify({ value, ending }),
      )
    }
})

test('pending edits split and join crlf without retaining stale code rows or widths', () => {
  const snippets = [
    'text\n\n',
    '~~~js\na\tb\n~~~\n\n',
    ticks + '\nbody\n' + ticks + '\n\n',
    '> ~~~\n> first\n> last\n> ~~~\n\n',
    '- item\n\n      code\n\n',
    '    indented\n\n',
    '~~~\n' + 'long\tline\n'.repeat(140) + '~~~\n\n',
  ]
  const inserts = [
    'x',
    '',
    '\n',
    '\r',
    '\r\n',
    '~',
    '~~~\n',
    ticks,
    '> ',
    '\t',
    '\n    x\n',
  ]
  for (let seed = 1; seed <= 48; seed++) {
    let state = seed
    const random = (limit) => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return Math.floor((state * limit) / 4294967296)
    }
    let text = Array.from(
      { length: 10 },
      () => snippets[random(snippets.length)],
    ).join('')
    if (seed % 3) text = text.replaceAll('\n', seed % 3 === 1 ? '\r\n' : '\r')
    const store = new SourceStore(text, {
      tabId: 'queued-extents',
      revision: 0,
    })
    const index = new MarkdownBoundaryIndex(store.snapshot(), config)
    let known = [],
      acknowledged
    const check = () => {
      drain(index)
      const expected = fresh(text)
      for (const page of index.pages(0, acknowledged))
        if (page.code) {
          const patch = page.code
          known = known.filter(
            (record) => record.to <= patch.from || record.from >= patch.to,
          )
          known.push(...patch.records)
        }
      known.sort((a, b) => a.from - b.from)
      assert.deepEqual(known, expected, JSON.stringify({ seed, text }))
      assert.deepEqual(collect(index), expected)
      index.acknowledgeCode(index.version)
      acknowledged = index.version
    }
    for (let step = 0; step < 15; step++) {
      if (step % 3 === 0) check()
      const source = store.snapshot()
      let from = random(text.length + 1),
        to = Math.min(text.length, from + random(9))
      while (!source.isEditBoundary(from)) from--
      while (!source.isEditBoundary(to)) to++
      let insert = inserts[random(inserts.length)]
      if (text.slice(from, to) === insert) insert += 'x'
      const prepared = prepare(store, [{ from, to, insert }])
      const changes = editorChangesFromSource(
        prepared.before,
        prepared.operation.changes,
      )
      for (const change of [...changes].reverse()) {
        const offset = change.insert.length - (change.to - change.from)
        known = known
          .filter(
            (record) => record.to < change.from || record.from > change.to,
          )
          .map((record) =>
            record.from > change.to
              ? {
                  ...record,
                  from: record.from + offset,
                  to: record.to + offset,
                  contentFrom: record.contentFrom + offset,
                  contentTo: record.contentTo + offset,
                }
              : record,
          )
      }
      index.apply(prepared)
      text = text.slice(0, from) + insert + text.slice(to)
      for (let advance = 0; advance < random(3); advance++) index.advance()
    }
    check()
  }
})

test('unconsumed indexed versions preserve repairs against the acknowledged code base', () => {
  const unit = '~~~\na\tb\n~~~\n\n    indented\n\n'
  const store = new SourceStore(unit.repeat(100), {
    tabId: 'code-ack',
    revision: 0,
  })
  const index = new MarkdownBoundaryIndex(store.snapshot(), config)
  drain(index)
  assert.equal(collect(index).length, 200)
  index.acknowledgeCode(0)
  index.apply(prepare(store, [{ from: 4, to: 5, insert: 'longword' }]))
  drain(index)
  const at = unit.length * 70 + 7 + 4
  index.apply(prepare(store, [{ from: at, to: at + 1, insert: 'longword' }]))
  drain(index)
  index.acknowledgeCode(1)
  const patches = [...index.pages(0, 0)].flatMap(
    (page) => page.code?.records ?? [],
  )
  assert.equal(patches.length, 2)
  assert.ok(patches.every((record) => record.contentColumns === 13))
  index.acknowledgeCode(2)
  assert.deepEqual(
    [...index.pages(0, 2)].flatMap((page) => page.code?.records ?? []),
    [],
  )
  store.counters(true)
  assert.equal(collect(index).length, 200)
  assert.equal(store.counters().sourceUnitsRead, 0)
  assert.equal(store.counters().materializations, 0)
})

test('a storage-only crlf join still ends an empty repair and keeps the cached code coverage', () => {
  const store = new SourceStore('~~~\ra\rb\r~~~\r', {
    tabId: 'code-ending',
    revision: 0,
  })
  const index = new MarkdownBoundaryIndex(store.snapshot(), config)
  drain(index)
  const initial = collect(index)
  index.acknowledgeCode(0)
  index.apply(prepare(store, [{ from: 4, to: 4, insert: '\n' }]))
  drain(index)
  const pages = [...index.pages(0, 0)]
  assert.equal(pages.length, 1)
  assert.equal(pages[0].done, true)
  assert.deepEqual(pages[0].records, [])
  assert.equal(pages[0].code, undefined)
  assert.deepEqual(collect(index), initial)
})

test('a coverage query includes complete blocks crossing either edge', () => {
  const text = 'before\n\n> ~~~\n> a\tb\n> last\n> ~~~\n\nafter'
  const store = new SourceStore(text, { tabId: 'code-edges', revision: 0 })
  const index = new MarkdownCodeExtents(store.snapshot())
  index.scan(parser.parse(text), 0, 0, text.length)
  const records = [...index.records()]
  assert.equal(records.length, 1)
  const from = records[0].contentFrom + 3,
    to = records[0].contentTo - 2
  const pages = [...index.pages(from, to)]
  assert.equal(pages.length, 1)
  assert.equal(pages[0].from, from)
  assert.equal(pages[0].to, to)
  assert.deepEqual(pages[0].records, records)
  assert.ok(records[0].from < from && records[0].to > to)
  assert.deepEqual([...index.records(records[0].to, text.length)], [])
})
