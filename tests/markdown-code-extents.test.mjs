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
  const index = new MarkdownBoundaryIndex(
    store.snapshot(),
    config,
    undefined,
    true,
  )
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
    const index = new MarkdownBoundaryIndex(
      store.snapshot(),
      config,
      undefined,
      true,
    )
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
  const index = new MarkdownBoundaryIndex(
    store.snapshot(),
    config,
    undefined,
    true,
  )
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
  const index = new MarkdownBoundaryIndex(
    store.snapshot(),
    config,
    undefined,
    true,
  )
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

const production = {
  ...config,
  syntax: ['table@1', 'tasks@1'],
  opaque: ['Table'],
  chunkSize: 4096,
  groupSize: 64,
  giantBlock: 65536,
}

test('giant fence closers match only the opening fence character', () => {
  for (const open of [
    '~~~' + ticks[0] + 'js',
    ticks + '~',
    ticks + ticks[0] + '~~~~',
  ]) {
    const close = /^(`+|~+)/.exec(open)[0]
    const text =
      open + '\n' + 'code line\n'.repeat(20000) + close + '\n\nafter\n'
    const store = new SourceStore(text, { tabId: 'code-marker', revision: 0 })
    const index = new MarkdownBoundaryIndex(
      store.snapshot(),
      production,
      undefined,
      true,
    )
    drain(index)
    assert.deepEqual(collect(index), fresh(text), open)
  }
})

test('editing a giant closer retains the reused block on the next line and its consumer patch', () => {
  const head = ticks + '\n' + 'code line\n'.repeat(8000) + ticks
  for (const settings of [
    production,
    { ...production, syntax: [], opaque: ['FencedCode'] },
  ])
    for (const next of [
      '~~~\nnext\n~~~\n',
      '    indented\n',
      '> ~~~\n> q\n> ~~~\n',
    ])
      for (const insert of [' ', ticks[0]]) {
        const text = head + '\n' + next + '\npara\n'.repeat(20)
        const store = new SourceStore(text, { tabId: 'code-next', revision: 0 })
        const index = new MarkdownBoundaryIndex(
          store.snapshot(),
          settings,
          undefined,
          true,
        )
        drain(index)
        const initial = collect(index)
        index.acknowledgeCode(0)
        index.apply(
          prepare(store, [{ from: head.length, to: head.length, insert }]),
        )
        drain(index)
        const expected = fresh(
          text.slice(0, head.length) + insert + text.slice(head.length),
        )
        assert.equal(expected.length, 2)
        const pages = [...index.pages(0, undefined, 0, true)]
        let consumer = initial.map((record) =>
          record.from > head.length
            ? {
                ...record,
                from: record.from + insert.length,
                to: record.to + insert.length,
                contentFrom: record.contentFrom + insert.length,
                contentTo: record.contentTo + insert.length,
              }
            : record,
        )
        for (const { code } of pages) {
          if (!code) continue
          consumer = consumer.filter(
            (record) => record.to <= code.from || record.from >= code.to,
          )
          consumer.push(...code.records)
        }
        consumer.sort((a, b) => a.from - b.from)
        assert.deepEqual(
          consumer,
          expected,
          JSON.stringify({ next, insert, settings }),
        )
        assert.deepEqual(collect(index), expected)
      }
})

test('splitting a line above a retained giant width maximum keeps the unvisited neighbour summary', () => {
  const lengths = [
    5747, 6515, 5402, 4095, 1384, 6923, 7488, 2368, 6599, 28, 2, 56, 9800, 4495,
    4611,
  ]
  const prefix = 'intro\n\n~~~\n'
  const text =
    prefix + lengths.map((n) => 'w'.repeat(n)).join('\n') + '\n~~~\n\nafter\n'
  const store = new SourceStore(text, {
    tabId: 'code-width-neighbour',
    revision: 0,
  })
  const index = new MarkdownBoundaryIndex(
    store.snapshot(),
    production,
    undefined,
    true,
  )
  drain(index)
  assert.equal(collect(index)[0].contentColumns, 9800)
  index.acknowledgeCode(0)
  const at =
    prefix.length + lengths.slice(0, 11).reduce((sum, n) => sum + n + 1, 0) + 1
  index.apply(prepare(store, [{ from: at, to: at, insert: '\n' }]))
  drain(index)
  const patch = [...index.pages(0, undefined, 0, true)].flatMap(
    (page) => page.code?.records ?? [],
  )
  assert.equal(patch[0].contentColumns, 9800)
  assert.deepEqual(
    collect(index),
    fresh(text.slice(0, at) + '\n' + text.slice(at)),
  )
})

test('long physical container code lines stay one block across input chunks and edits', () => {
  for (const [open, prefix, close] of [
    ['> ~~~\n', '> ', '> ~~~\n'],
    ['- ~~~\n', '  ', '  ~~~\n'],
    ['> - ~~~\n', '>   ', '>   ~~~\n'],
  ]) {
    const text =
      open +
      prefix +
      'a\n' +
      prefix +
      'v'.repeat(5000) +
      '\n' +
      prefix +
      'b\n' +
      close
    const store = new SourceStore(text, {
      tabId: 'code-container-long',
      revision: 0,
    })
    const index = new MarkdownBoundaryIndex(
      store.snapshot(),
      production,
      undefined,
      true,
    )
    drain(index)
    assert.deepEqual(collect(index), fresh(text))
    const at = open.length + prefix.length + 2 + prefix.length + 4100
    index.apply(prepare(store, [{ from: at, to: at, insert: '\t' }]))
    drain(index)
    assert.deepEqual(
      collect(index),
      fresh(text.slice(0, at) + '\t' + text.slice(at)),
    )
  }
})

test('giant reuse waits until both halves of a split source line have width summaries', () => {
  for (const settings of [config, production])
    for (const insert of ['\n', '\n\n', 'Z'.repeat(300), '\t'.repeat(10)]) {
      const head = '~~~\n' + 'body\n'.repeat(settings === config ? 100 : 3000)
      const long = 'x'.repeat(settings === config ? 200 : 12000)
      const text = head + long + '\n' + head.slice(4) + '~~~\n'
      const store = new SourceStore(text, {
        tabId: 'code-split-width',
        revision: 0,
      })
      const index = new MarkdownBoundaryIndex(
        store.snapshot(),
        settings,
        undefined,
        true,
      )
      drain(index)
      const at = head.length + 40
      index.apply(prepare(store, [{ from: at, to: at, insert }]))
      drain(index)
      assert.deepEqual(
        collect(index),
        fresh(text.slice(0, at) + insert + text.slice(at)),
        JSON.stringify({ settings, insert }),
      )
    }
})

test('a reused tiny giant fence keeps the longer half of an edited crlf body line', () => {
  const text =
    '>\t~~~\r\n>\tx\ty   ~~~\r\n\tx\r\n   ~~~~  \r\n> - ~~~\r\n>   a\r\n>   ~~~\r\n$$\r\nmath\r\n$$\r\n- ```\r\n  a\tb\r\n  ```\r\n> > ~~~\r\n\r\n > nested\r\n> ~~~\r\n|  | b |\r\n| - | - |\r\n| 1 | 2 |\r\n~~~`~~~\r\n```\r\nxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx````xxxxxxxx`xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxzxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx```xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n\nxxxxxxxxxxxxxxx1. xxxxxxxxxxxxxxxxxxxxxxx- xxxxxxxxxxxxxx> ```\r\nunclosed body\r\n> > ~~~\r\n>    \r\n>\t~~````\r\n>\tx\ty\r\npar\rline\r\n~~~js\ta\tb\r\n~~~\r\n```\r\ncode\r\n```\r\n1. ~~~\r\n   x\r\n\r\n   y\r\n  \n    x\n~\r\n'
  const store = new SourceStore(text, { tabId: 'code-tiny-width', revision: 0 })
  const index = new MarkdownBoundaryIndex(
    store.snapshot(),
    {
      ...production,
      syntax: ['table@1'],
      chunkSize: 32,
      groupSize: 2,
      giantBlock: 128,
    },
    undefined,
    true,
  )
  drain(index)
  const changes = [{ from: 261, to: 262, insert: '\n\n' }]
  index.apply(prepare(store, changes))
  drain(index)
  const change = changes[0]
  assert.deepEqual(
    collect(index),
    fresh(text.slice(0, change.from) + change.insert + text.slice(change.to)),
  )
})

test('pending giant-line splits compare with fresh parsing using high-bit random choices', (t) => {
  let checks = 0,
    reuseMisses = 0
  for (let seed = 1; seed <= 40; seed++) {
    let state = seed
    const random = () => {
      state = (state + 0x6d2b79f5) >>> 0
      let value = state
      value = Math.imul(value ^ (value >>> 15), value | 1)
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296
    }
    random()
    let body = ''
    while (body.length < 90000) {
      const length =
        random() < 0.3
          ? 1000 + Math.floor(random() * 9000)
          : Math.floor(random() * 60)
      body += 'w'.repeat(length) + '\n'
    }
    let text = 'intro\n\n~~~\n' + body + '~~~\n\nafter\n'
    const store = new SourceStore(text, {
      tabId: 'code-random-width',
      revision: 0,
    })
    const index = new MarkdownBoundaryIndex(
      store.snapshot(),
      production,
      undefined,
      true,
    )
    drain(index)
    for (let step = 0; step < 25; step++) {
      let at = Math.floor(random() * text.length)
      if (random() < 0.7) {
        let longest = 0,
          start = 0,
          position = 0
        for (const line of text.split('\n')) {
          if (line.length > longest) {
            longest = line.length
            start = position
          }
          position += line.length + 1
        }
        at =
          random() < 0.5
            ? start + 1 + Math.floor(random() * 20)
            : Math.max(0, start - 1 - Math.floor(random() * 3))
      }
      const choice = random()
      const insert =
        choice < 0.4
          ? '\n'
          : choice < 0.6
            ? '\n\n'
            : choice < 0.8
              ? 'Q'.repeat(900)
              : '\t'.repeat(300)
      index.apply(prepare(store, [{ from: at, to: at, insert }]))
      text = text.slice(0, at) + insert + text.slice(at)
      if (random() < 0.5) drain(index)
      else
        for (let n = Math.floor(random() * 3); n > 0; n--)
          if (index.advance()) break
      if (random() < 0.3 || step === 24) {
        drain(index)
        checks++
        assert.deepEqual(
          collect(index),
          fresh(text),
          JSON.stringify({ seed, step }),
        )
      }
    }
    reuseMisses += index.codeWork.reuseMisses
  }
  assert.ok(checks >= 300)
  assert.ok(reuseMisses > 0)
  t.diagnostic(
    JSON.stringify({
      giantWidthFuzz: { seeds: 40, edits: 1000, checks, reuseMisses },
    }),
  )
})
