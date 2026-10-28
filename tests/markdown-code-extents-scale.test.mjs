import assert from 'node:assert/strict'
import test from 'node:test'
import { MarkdownBoundaryIndex } from '../src/shared/markdown-boundary-index.ts'
import { boundaryKey } from '../src/shared/markdown-boundary-syntax.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'

const config = {
  schema: 1,
  syntax: [],
  flavors: [],
  literal: [],
  opaque: ['FencedCode'],
  prefix: 0,
  chunkSize: 4096,
  groupSize: 64,
  giantBlock: 65536,
}
const probe = () => ({
  parsedChunks: 0,
  parsedUnits: 0,
  scannedUnits: 0,
  reusedNodes: 0,
  builtGroups: 0,
})
function prepare(store, changes) {
  const before = store.snapshot()
  const result = store.prepare({
    document: before.document,
    operationId: crypto.randomUUID(),
    baseVersion: before.version,
    contentVersion: before.version + 1,
    origin: 'source',
    historyGroup: 'code-scale',
    changes,
  })
  store.commit(result)
  return result
}
function drain(index, store) {
  let maximumAdvance = 0,
    previous = store.counters().sourceUnitsRead
  for (;;) {
    const done = index.advance(),
      next = store.counters().sourceUnitsRead
    maximumAdvance = Math.max(maximumAdvance, next - previous)
    previous = next
    if (done) return maximumAdvance
  }
}
function transferred(index, from = 0, base, codeOnly = false) {
  const syntax = codeOnly
    ? []
    : [...index.pages(from, base, base, false, false)]
  const coverage = index.parser.options.codeBlocks
    ? [...index.pages(0, undefined, base, true)]
    : []
  const pages = [...syntax, ...coverage]
  const code = pages.flatMap((page) => page.code?.records ?? [])
  const result = {
    pages: pages.length,
    syntaxPages: syntax.length,
    codePages: coverage.length,
    records: 0,
    codeRecords: code.length,
    bytes: 0,
    maximumRecords: 0,
    maximumUnits: 0,
  }
  for (const [offset, page] of pages.entries()) {
    const codePage = offset >= syntax.length
    const sequence = codePage ? offset - syntax.length : offset
    const records = page.records.length + (page.code?.records.length ?? 0)
    const wire = {
      type: 'boundaries',
      epoch: '00000000-0000-4000-8000-000000000000',
      id: codePage ? 2 : 1,
      version: index.version,
      key: boundaryKey(config),
      sequence,
      length: index.length,
      ...page,
    }
    const units = JSON.stringify(wire).length
    result.records += records
    result.bytes += Buffer.byteLength(JSON.stringify(wire))
    result.maximumRecords = Math.max(result.maximumRecords, records)
    result.maximumUnits = Math.max(result.maximumUnits, units)
    assert.ok(records <= 128, JSON.stringify(result))
    assert.ok(units < 17000, JSON.stringify(result))
  }
  assert.equal(pages.at(-1).done, true)
  index.acknowledgeCode(index.version)
  return { code, result }
}

test('a 50 mib code index retains giant width summaries and pushes only repaired blocks', (t) => {
  const unit =
    '# part\n\n' +
    'paragraph words\n\n'.repeat(32) +
    '~~~js\nsmall\tbody\n~~~\n\n    indented\n\n> ~~~\n> quote\n> ~~~\n\n- ~~~\n  list\n  ~~~\n\n'
  const prefix = unit.repeat(400),
    suffix = unit.repeat(400)
  const regular = 'body\t' + 'v'.repeat(251) + '\n'
  const lines = Math.ceil(
    (50 * 1024 * 1024 - prefix.length - suffix.length) / regular.length,
  )
  const first = Math.floor(lines / 2)
  const peak = prefix.length + 6 + first * regular.length
  const body =
    regular.repeat(first) +
    'X'.repeat(1100) +
    '\n' +
    regular.repeat(lines - first) +
    'Y'.repeat(900) +
    '\n'
  const text = prefix + '~~~js\n' + body + '~~~\n\n' + suffix
  assert.ok(text.length >= 50 * 1024 * 1024)
  const store = new SourceStore(text, { tabId: 'code-scale', revision: 0 })
  const work = probe(),
    index = new MarkdownBoundaryIndex(store.snapshot(), config, work, true)
  store.counters(true)
  const coldAdvance = drain(index, store)
  const cold = transferred(index)
  assert.equal(cold.code.length, 3201)
  const giant = cold.code.find((record) => record.from === prefix.length)
  assert.equal(giant.contentColumns, 1100)
  assert.equal(giant.contentLines, lines + 2)
  assert.ok(
    index.codeWork.readUnits < text.length * 2,
    JSON.stringify(index.codeWork),
  )
  assert.ok(index.codeWork.maximumRead <= 4096, JSON.stringify(index.codeWork))
  assert.ok(
    index.codeWork.maximumWindow <= 65536,
    JSON.stringify(index.codeWork),
  )
  assert.ok(coldAdvance < 1024 * 1024, String(coldAdvance))
  assert.equal(store.counters().materializations, 0)
  const initial = {
    ...cold.result,
    codeRead: index.codeWork.readUnits,
    widthRuns: index.codeWork.widthRuns,
    maximumAdvance: coldAdvance,
  }

  const syntaxOnly = new MarkdownBoundaryIndex(store.snapshot(), config)
  assert.equal(syntaxOnly.parser.options.codeBlocks, undefined)
  store.counters(true)
  const syntaxAdvance = drain(syntaxOnly, store)
  const syntaxTransfer = transferred(syntaxOnly)
  assert.equal(syntaxTransfer.code.length, 0)
  assert.equal(syntaxOnly.codeWork.readUnits, 0)
  assert.equal(store.counters().materializations, 0)
  const noListeners = {
    ...syntaxTransfer.result,
    codeRead: syntaxOnly.codeWork.readUnits,
    maximumAdvance: syntaxAdvance,
  }

  index.apply(prepare(store, [{ from: peak, to: peak + 1100, insert: 'tiny' }]))
  index.codeWork.readUnits = 0
  work.scannedUnits = 0
  store.counters(true)
  const repairAdvance = drain(index, store)
  const repair = transferred(index, peak, 0, true)
  const repaired = repair.code.find((record) => record.from === prefix.length)
  assert.equal(repaired.contentColumns, 900)
  assert.equal(repaired.contentLines, lines + 2)
  assert.equal(repair.code.length, 1)
  assert.equal(repair.result.records, 1)
  assert.ok(
    index.codeWork.readUnits < 256 * 1024,
    JSON.stringify(index.codeWork),
  )
  assert.ok(work.scannedUnits < 1024 * 1024, JSON.stringify(work))
  assert.ok(repairAdvance < 1024 * 1024, String(repairAdvance))
  const repairedWork = {
    ...repair.result,
    codeRead: index.codeWork.readUnits,
    scanned: work.scannedUnits,
    maximumAdvance: repairAdvance,
  }

  const at = prefix.length + 6 + 10 * regular.length + 5
  index.apply(prepare(store, [{ from: at, to: at, insert: '\r' }]))
  index.apply(prepare(store, [{ from: at + 1, to: at + 1, insert: '\n' }]))
  index.codeWork.readUnits = 0
  work.scannedUnits = 0
  store.counters(true)
  drain(index, store)
  const pending = transferred(index, at, 1, true)
  const joined = pending.code.find((record) => record.from === prefix.length)
  assert.equal(joined.contentLines, lines + 3)
  assert.equal(joined.contentColumns, 900)
  assert.equal(index.length, text.length - 1095)
  assert.equal(pending.code.length, 1)
  assert.equal(pending.result.records, 1)
  assert.ok(
    index.codeWork.readUnits < 256 * 1024,
    JSON.stringify(index.codeWork),
  )
  assert.ok(work.scannedUnits < 1024 * 1024, JSON.stringify(work))
  const pendingWork = {
    ...pending.result,
    codeRead: index.codeWork.readUnits,
    scanned: work.scannedUnits,
  }

  store.counters(true)
  transferred(index)
  assert.equal(store.counters().sourceUnitsRead, 0)
  assert.equal(store.counters().materializations, 0)
  t.diagnostic(
    JSON.stringify({
      length: text.length,
      initial,
      noListeners,
      repaired: repairedWork,
      pending: pendingWork,
    }),
  )
})

test('giant container code reuses unchanged widths when the scanner replays its context', (t) => {
  const prefix = '>   ',
    regular = prefix + 'body\t' + 'v'.repeat(120) + '\n'
  const opening = '> - ~~~\n'
  const peak = opening.length + 2000 * regular.length + prefix.length
  const text =
    opening +
    regular.repeat(2000) +
    prefix +
    'X'.repeat(1100) +
    '\n' +
    regular.repeat(2000) +
    prefix +
    'Y'.repeat(900) +
    '\n>   ~~~\n'
  const store = new SourceStore(text, { tabId: 'container-code', revision: 0 })
  const work = probe(),
    index = new MarkdownBoundaryIndex(store.snapshot(), config, work, true)
  drain(index, store)
  assert.equal(transferred(index).code[0].contentColumns, 1100)
  index.apply(prepare(store, [{ from: peak, to: peak + 1100, insert: 'tiny' }]))
  index.codeWork.readUnits = 0
  work.scannedUnits = 0
  drain(index, store)
  const repair = transferred(index, peak, 0, true)
  assert.equal(repair.code.length, 1)
  assert.equal(repair.code[0].contentColumns, 900)
  assert.equal(repair.code[0].contentLines, 4002)
  assert.ok(index.codeWork.readUnits < 8192, JSON.stringify(index.codeWork))
  t.diagnostic(
    JSON.stringify({
      container: {
        ...repair.result,
        widthRead: index.codeWork.readUnits,
        scanned: work.scannedUnits,
      },
    }),
  )
})

test('code geometry derives line positions from scanner windows instead of seeking each block', (t) => {
  const unit =
    '# part\n\n' +
    'paragraph words\n\n'.repeat(32) +
    '~~~js\nsmall\tbody\n~~~\n\n    indented\n\n> ~~~\n> quote\n> ~~~\n\n- ~~~\n  list\n  ~~~\n\n'
  const text = unit.repeat(Math.ceil(1048576 / unit.length))
  const store = new SourceStore(text, { tabId: 'code-seeks', revision: 0 })
  const prototype = Object.getPrototypeOf(store.snapshot())
  const counts = {
    lineAt: 0,
    lineStart: 0,
    editorToRaw: 0,
    rawToEditor: 0,
    sliceRaw: 0,
  }
  for (const name of Object.keys(counts)) {
    const original = prototype[name]
    t.mock.method(prototype, name, function (...args) {
      counts[name]++
      return original.apply(this, args)
    })
  }
  const indexed = new MarkdownBoundaryIndex(
    store.snapshot(),
    config,
    undefined,
    true,
  )
  while (!indexed.advance()) {}
  assert.equal(
    [...indexed.code.records()].length,
    4 * Math.ceil(1048576 / unit.length),
  )
  const withCode = { ...counts }
  for (const name of Object.keys(counts)) counts[name] = 0
  const plain = new MarkdownBoundaryIndex(store.snapshot(), config)
  while (!plain.advance()) {}
  assert.ok(
    withCode.rawToEditor <= counts.rawToEditor * 3,
    JSON.stringify({ withCode, withoutCode: counts }),
  )
  assert.ok(
    withCode.sliceRaw <= counts.sliceRaw * 3,
    JSON.stringify({ withCode, withoutCode: counts }),
  )
  t.diagnostic(
    JSON.stringify({ geometrySeeks: { withCode, withoutCode: counts } }),
  )
})
