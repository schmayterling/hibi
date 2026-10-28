import type { ChangedRange, Input, SyntaxNode, Tree } from '@lezer/common'
import type { CodeBlockExtent } from './markdown-boundary-syntax.ts'
import type { SourceSnapshot } from './source-buffer.ts'
import { normalizedSource } from './source-projection.ts'

export type CodeExtentInput = Input & {
  line(at: number): { number: number; from: number; to: number; next: number }
}

type Columns = { from: number; to: number; columns: number; prefix: number }
type Entry = Columns | CodeBlockExtent
type Node = {
  value: Entry
  left: Node | null
  right: Node | null
  height: number
  count: number
  first: number
  last: number
  maximum: number
  shift: number
}
const height = (node: Node | null) => node?.height ?? 0
const count = (node: Node | null) => node?.count ?? 0
function move(node: Node | null, offset: number) {
  if (!node || !offset) return
  const value = node.value
  node.value =
    'contentFrom' in value
      ? {
          ...value,
          from: value.from + offset,
          to: value.to + offset,
          contentFrom: value.contentFrom + offset,
          contentTo: value.contentTo + offset,
        }
      : { ...value, from: value.from + offset, to: value.to + offset }
  node.first += offset
  node.last += offset
  node.shift += offset
}
function push(node: Node) {
  move(node.left, node.shift)
  move(node.right, node.shift)
  node.shift = 0
}
function pull(node: Node) {
  node.height = 1 + Math.max(height(node.left), height(node.right))
  node.count = 1 + count(node.left) + count(node.right)
  node.first = node.left?.first ?? node.value.from
  node.last = node.right?.last ?? node.value.to
  node.maximum = Math.max(
    'columns' in node.value ? node.value.columns : 0,
    node.left?.maximum ?? 0,
    node.right?.maximum ?? 0,
  )
  return node
}
function make(value: Entry): Node {
  return pull({
    value,
    left: null,
    right: null,
    height: 1,
    count: 1,
    first: value.from,
    last: value.to,
    maximum: 0,
    shift: 0,
  })
}
function rotate(node: Node, left: boolean) {
  push(node)
  const child = (left ? node.right : node.left)!
  push(child)
  if (left) {
    node.right = child.left
    child.left = pull(node)
  } else {
    node.left = child.right
    child.right = pull(node)
  }
  return pull(child)
}
function balance(node: Node) {
  pull(node)
  if (height(node.left) > height(node.right) + 1) {
    push(node.left!)
    if (height(node.left!.right) > height(node.left!.left))
      node.left = rotate(node.left!, true)
    return rotate(node, false)
  }
  if (height(node.right) > height(node.left) + 1) {
    push(node.right!)
    if (height(node.right!.left) > height(node.right!.right))
      node.right = rotate(node.right!, false)
    return rotate(node, true)
  }
  return node
}
function join(left: Node | null, right: Node | null): Node | null {
  if (!left) return right
  if (!right) return left
  push(left)
  push(right)
  if (height(left) >= height(right)) {
    left.right = join(left.right, right)
    return balance(left)
  }
  right.left = join(left, right.left)
  return balance(right)
}
/** Split by block/row starts; offsets of the untouched suffix stay lazy. */
function split(
  node: Node | null,
  at: number,
  inclusive = false,
): [Node | null, Node | null] {
  if (!node) return [null, null]
  push(node)
  if (node.value.from < at || (inclusive && node.value.from === at)) {
    const [left, right] = split(node.right, at, inclusive)
    const before = node.left
    node.left = node.right = null
    return [join(join(before, pull(node)), left), right]
  }
  const [left, right] = split(node.left, at, inclusive)
  const after = node.right
  node.left = node.right = null
  return [left, join(join(right, pull(node)), after)]
}
function edge(node: Node, last: boolean): Entry {
  push(node)
  const child = last ? node.right : node.left
  return child ? edge(child, last) : node.value
}
function pop(node: Node, last: boolean): Node | null {
  push(node)
  if (last) {
    if (!node.right) return node.left
    node.right = pop(node.right, true)
  } else {
    if (!node.left) return node.right
    node.left = pop(node.left, false)
  }
  return balance(node)
}
/** Each width run has the same width on every complete source line in it. */
function cutColumns(root: Node | null, at: number): [Node | null, Node | null] {
  let [left, right] = split(root, at)
  const value = left && (edge(left, true) as Columns | null)
  if (value && value.to > at) {
    left = join(pop(left!, true), make({ ...value, to: at }))
    right = join(make({ ...value, from: at }), right)
  }
  return [left, right]
}
function joinColumns(left: Node | null, right: Node | null): Node | null {
  const a = left && (edge(left, true) as Columns | null)
  const b = right && (edge(right, false) as Columns | null)
  if (
    a &&
    b &&
    a.to === b.from &&
    a.columns === b.columns &&
    a.prefix === b.prefix
  )
    return join(
      join(pop(left!, true), make({ ...a, to: b.to })),
      pop(right!, false),
    )
  return join(left, right)
}
function replaceColumns(
  root: Node | null,
  from: number,
  to: number,
  rows: readonly Columns[],
  offset = 0,
) {
  const [left, tail] = cutColumns(root, from)
  const [, right] = cutColumns(tail, to)
  move(right, offset)
  let middle: Node | null = null
  for (const row of rows) middle = joinColumns(middle, make(row))
  return joinColumns(joinColumns(left, middle), right)
}
function maximum(node: Node | null, from: number, to: number): number {
  if (!node || from >= to || node.last <= from || node.first >= to) return 0
  if (from <= node.first && node.last <= to) return node.maximum
  push(node)
  return Math.max(
    node.value.from < to && node.value.to > from && 'columns' in node.value
      ? node.value.columns
      : 0,
    maximum(node.left, from, to),
    maximum(node.right, from, to),
  )
}
function* between(
  node: Node | null,
  from: number,
  to: number,
): Generator<CodeBlockExtent> {
  if (!node || from >= to || node.last <= from || node.first >= to) return
  push(node)
  yield* between(node.left, from, to)
  if (
    node.value.to > from &&
    node.value.from < to &&
    'contentFrom' in node.value
  )
    yield node.value
  yield* between(node.right, from, to)
}

function* columnRuns(
  node: Node | null,
  from: number,
  to: number,
): Generator<Columns> {
  if (!node || node.last <= from || node.first >= to) return
  push(node)
  yield* columnRuns(node.left, from, to)
  if ('columns' in node.value && node.value.from < to && node.value.to > from)
    yield node.value
  yield* columnRuns(node.right, from, to)
}

/** Worker-only code rows and width runs. Edits split summaries; they never reread a retained body. */
export class MarkdownCodeExtents {
  #source: SourceSnapshot
  #input: CodeExtentInput | undefined
  #dirty: { from: number; to: number }[] | null = null
  #baseVersion: number | null = null
  #blocks: Node | null = null
  #columns: Node | null = null
  #widthDirty: { from: number; to: number }[] = []
  readonly work = {
    readUnits: 0,
    maximumRead: 0,
    maximumWindow: 0,
    recordsWritten: 0,
    widthRuns: 0,
    reuseMisses: 0,
  }
  constructor(source: SourceSnapshot, input?: CodeExtentInput) {
    this.#source = source
    this.#input = input
  }
  get baseVersion() {
    return this.#baseVersion
  }
  acknowledge(version: number) {
    if (version !== this.#source.version) return
    this.#baseVersion = version
    this.#dirty = []
  }
  #line(at: number) {
    if (this.#input) return this.#input.line(at)
    const source = this.#source
    const line = source.lineAt(source.editorToRaw(at)!)!
    return {
      number: line.number,
      from: source.rawToEditor(line.from)!,
      to: source.rawToEditor(line.to)!,
      next:
        line.number < source.lineCount
          ? source.rawToEditor(source.lineStart(line.number + 1)!)!
          : source.normalizedLength,
    }
  }
  #read(from: number, to: number) {
    this.work.readUnits += to - from
    this.work.maximumRead = Math.max(this.work.maximumRead, to - from)
    if (this.#input) return this.#input.read(from, to)
    return normalizedSource(
      this.#source.sliceRaw(
        this.#source.editorToRaw(from)!,
        this.#source.editorToRaw(to)!,
      ),
    )
  }
  #changed(from: number, to: number) {
    if (!this.#dirty) return
    const output: { from: number; to: number }[] = []
    let pending = { from, to }
    for (const range of this.#dirty) {
      if (range.to < pending.from) output.push(range)
      else if (pending.to < range.from) {
        output.push(pending)
        pending = range
      } else
        pending = {
          from: Math.min(pending.from, range.from),
          to: Math.max(pending.to, range.to),
        }
    }
    output.push(pending)
    this.#dirty = output
  }
  #eraseStarts(from: number, to: number, keep?: ReadonlySet<number>) {
    if (keep) {
      const stale = [...this.records(from, to)].filter(
        (record) => record.from >= from && !keep.has(record.from),
      )
      for (const record of stale) {
        const [left, tail] = split(this.#blocks, record.from)
        const [, right] = split(tail, record.from, true)
        this.#blocks = join(left, right)
        this.#changed(record.from, record.to)
      }
      return
    }
    const [left, tail] = split(this.#blocks, from)
    const [removed, right] = split(tail, to)
    this.#blocks = join(left, right)
    if (removed) this.#changed(removed.first, removed.last)
  }
  canReuse(from: number, to: number) {
    if (this.#widthDirty.some((range) => range.from < to && range.to > from)) {
      this.work.reuseMisses++
      return false
    }
    return true
  }
  finish() {
    this.#widthDirty = []
  }
  #verified(from: number, to: number) {
    this.#widthDirty = this.#widthDirty.flatMap((range) =>
      range.to <= from || range.from >= to
        ? [range]
        : [
            ...(range.from < from ? [{ from: range.from, to: from }] : []),
            ...(range.to > to ? [{ from: to, to: range.to }] : []),
          ],
    )
  }
  clear(from: number, to: number) {
    this.#eraseStarts(from, to)
    this.#verified(from, to)
    this.#columns = replaceColumns(this.#columns, from, to, [])
    this.work.widthRuns = count(this.#columns)
  }
  apply(
    before: SourceSnapshot,
    after: SourceSnapshot,
    changes: readonly ChangedRange[],
    input?: CodeExtentInput,
  ) {
    const lines: { from: number; to: number; offset: number }[] = []
    for (const change of changes) {
      const a = before.lineAt(before.editorToRaw(change.fromA)!)!,
        b = before.lineAt(
          before.editorToRaw(Math.max(change.fromA, change.toA - 1))!,
        )!
      const from = before.rawToEditor(a.from)!
      const to =
        b.number < before.lineCount
          ? before.rawToEditor(before.lineStart(b.number + 1)!)!
          : before.normalizedLength
      const offset = change.toB - change.fromB - (change.toA - change.fromA)
      const last = lines.at(-1)
      if (last && last.to >= from) {
        last.to = Math.max(last.to, to)
        last.offset += offset
      } else lines.push({ from, to, offset })
    }
    for (const change of [...changes].reverse()) {
      const offset = change.toB - change.fromB - (change.toA - change.fromA)
      const mapped = (at: number, end: boolean) =>
        at < change.fromA || (at === change.fromA && !end)
          ? at
          : at >= change.toA
            ? at + offset
            : change.fromA + (end ? change.toB - change.fromB : 0)
      this.#widthDirty = this.#widthDirty.map((range) => ({
        from: mapped(range.from, false),
        to: mapped(range.to, true),
      }))
      if (this.#dirty)
        this.#dirty = this.#dirty.map((range) => ({
          from: mapped(range.from, false),
          to: mapped(range.to, true),
        }))
      let [left, tail] = split(this.#blocks, change.fromA)
      let first: Entry | null = null
      if (left && edge(left, true).to >= change.fromA) {
        first = edge(left, true)
        left = pop(left, true)
      }
      const [touched, right] = split(tail, change.toA, true)
      let retained: Node | null = null
      const records = [
        ...(first ? [first as CodeBlockExtent] : []),
        ...between(touched, -1, Infinity),
      ]
      // Projected edits can touch a reused next line. Keep its record until a
      // verified scan replaces or clears it, including edits at either edge.
      for (const record of records) {
        const next = {
          ...record,
          from: mapped(record.from, false),
          to: mapped(record.to, true),
          contentFrom: mapped(record.contentFrom, false),
          contentTo: mapped(record.contentTo, true),
        }
        if (next.to > next.from) retained = join(retained, make(next))
      }
      if (first || touched)
        this.#changed(
          mapped(
            Math.min(first?.from ?? Infinity, touched?.first ?? Infinity),
            false,
          ),
          mapped(Math.max(first?.to ?? -1, touched?.last ?? -1), true),
        )
      move(right, offset)
      this.#blocks = join(join(left, retained), right)
    }
    const project = (at: number, end: boolean) => {
      let offset = 0
      for (const change of changes) {
        if (at < change.fromA || (at === change.fromA && !end))
          return at + offset
        if (at <= change.toA)
          return at === change.toA || end ? change.toB : change.fromB
        offset = change.toB - change.toA
      }
      return at + offset
    }
    for (const line of lines)
      this.#widthDirty.push({
        from: project(line.from, false),
        to: project(line.to, true),
      })
    for (const line of lines.reverse())
      this.#columns = replaceColumns(
        this.#columns,
        line.from,
        line.to,
        [],
        line.offset,
      )
    this.#source = after
    this.#input = input
    this.work.widthRuns = count(this.#columns)
  }
  #put(record: CodeBlockExtent) {
    let [left, tail] = split(this.#blocks, record.from)
    const existing = tail && edge(tail, false)
    if (
      existing &&
      existing.from === record.from &&
      'contentFrom' in existing &&
      (Object.keys(record) as (keyof CodeBlockExtent)[]).every(
        (key) => record[key] === existing[key],
      )
    ) {
      this.#blocks = join(left, tail)
      return
    }
    let first: Entry | null = null
    if (left && edge(left, true).to >= record.from) {
      first = edge(left, true)
      left = pop(left, true)
    }
    const [removed, right] = split(tail, record.to, true)
    this.#blocks = join(join(left, make(record)), right)
    this.#changed(
      Math.min(
        record.from,
        first?.from ?? Infinity,
        removed?.first ?? Infinity,
      ),
      Math.max(record.to, first?.to ?? -1, removed?.last ?? -1),
    )
    this.work.recordsWritten++
  }
  #record(
    start: number,
    end: number,
    kind: CodeBlockExtent['kind'],
    closed: boolean,
    close = end,
  ) {
    const first = this.#line(start),
      last = this.#line(Math.max(start, end - 1))
    const to = last.to
    const body = kind === 'fenced' ? first.next : start
    const contentFrom = Math.min(body, to)
    const contentTo = closed && kind === 'fenced' ? this.#line(close).from : to
    const contentLines =
      kind === 'indented'
        ? last.number - first.number + 1
        : closed
          ? this.#line(close).number - first.number - 1
          : end > body
            ? last.number - first.number
            : 0
    this.#put({
      from: first.from,
      to,
      kind,
      contentFrom,
      contentTo,
      contentLines,
      contentColumns: maximum(this.#columns, contentFrom, contentTo),
      closed,
    })
  }
  #cached(from: number, to: number, firstEnd: number, prefix: number) {
    const rows: Columns[] = []
    let at = from
    for (const run of columnRuns(this.#columns, from, to)) {
      if (
        run.from > at ||
        (at < firstEnd && run.prefix !== prefix) ||
        (Math.min(run.to, to) > firstEnd && run.prefix !== 0)
      )
        return null
      const end = Math.min(to, run.to)
      rows.push({ ...run, from: at, to: end })
      at = end
      if (at === to) return rows
    }
    return null
  }
  scan(tree: Tree, base: number, from: number, to: number) {
    if (to <= from) return
    this.work.maximumWindow = Math.max(this.work.maximumWindow, to - from)
    const starts = new Set<number>()
    const rows: Columns[] = [],
      blocks: SyntaxNode[] = []
    const row = (from: number, to: number, columns: number, prefix: number) => {
      if (to <= from) return
      const last = rows.at(-1)
      if (last && last.from === from) {
        last.to = Math.max(last.to, to)
        last.columns = Math.max(last.columns, columns)
      } else if (
        last &&
        last.to === from &&
        last.columns === columns &&
        last.prefix === prefix
      )
        last.to = to
      else rows.push({ from, to, columns, prefix })
    }
    tree.iterate({
      from: Math.max(0, from - base),
      to: to - base,
      enter: (ref) => {
        if (ref.name !== 'FencedCode' && ref.name !== 'CodeBlock')
          return ref.type.is('LeafBlock') ? false : undefined
        const node = ref.node
        starts.add(this.#line(base + node.from).from)
        for (const text of node.getChildren('CodeText')) {
          const start = Math.max(from, base + text.from),
            end = Math.min(to, base + text.to)
          if (start >= end) continue
          const first = this.#line(start),
            last = this.#line(end - 1)
          const cached = this.#cached(
            first.from,
            last.next,
            first.next,
            start - first.from,
          )
          if (cached) {
            for (const run of cached)
              row(run.from, run.to, run.columns, run.prefix)
            continue
          }
          let line = first.from,
            prefix = start - first.from,
            columns = 0,
            at = start
          while (at < end) {
            const value = this.#read(at, Math.min(end, at + 4096))
            for (let i = 0; i < value.length; i++) {
              if (value[i] === '\n') {
                row(line, at + i + 1, columns, prefix)
                line = at + i + 1
                columns = 0
                prefix = 0
              } else columns += value[i] === '\t' ? 4 - (columns % 4) : 1
            }
            at += value.length
          }
          if (line < end && end >= last.to)
            row(line, last.next, columns, prefix)
        }
        if (base + node.to <= to) blocks.push(node)
        return false
      },
    })
    this.#eraseStarts(from, to, starts)
    const ending = this.#line(to)
    const widthTo = ending.from === to ? to : ending.next
    this.#columns = replaceColumns(this.#columns, from, widthTo, rows)
    this.#verified(from, to)
    this.work.widthRuns = count(this.#columns)
    for (const node of blocks) {
      const close = node.lastChild
      const fenced = node.name === 'FencedCode'
      const closed =
        !fenced || (close?.name === 'CodeMark' && close.from > node.from)
      this.#record(
        base + node.from,
        base + node.to,
        fenced ? 'fenced' : 'indented',
        closed,
        base + (close?.from ?? node.to),
      )
    }
  }
  leaf(key: string, start: number, end: number) {
    if (key === 'CodeBlock') {
      this.#record(start, end, 'indented', true)
      return
    }
    if (!key.startsWith('FencedCode ')) return
    const marker = key.slice('FencedCode '.length),
      first = this.#line(start),
      last = this.#line(Math.max(start, end - 1))
    let closed = last.number > first.number,
      indent = 0,
      marks = 0,
      tail = false
    for (let at = last.from; closed && at < last.to; ) {
      const text = this.#read(at, Math.min(last.to, at + 4096))
      for (const character of text) {
        if (!marks && (character === ' ' || character === '\t')) {
          indent += character === '\t' ? 4 - (indent % 4) : 1
          if (indent >= 4) {
            closed = false
            break
          }
        } else if (!tail && character === marker[0]) marks++
        else if (marks && (character === ' ' || character === '\t')) tail = true
        else {
          closed = false
          break
        }
      }
      at += text.length
    }
    closed &&= marks >= marker.length
    this.#record(start, end, 'fenced', closed, last.from)
  }
  *records(from = 0, to = this.#source.normalizedLength) {
    yield* between(this.#blocks, from, to)
  }
  *pages(from: number, to: number, changed = false) {
    if (!changed || this.#dirty === null) {
      yield* this.#pagesInRange(from, to)
      return
    }
    for (const range of this.#dirty) {
      const start = Math.max(from, range.from),
        end = Math.min(to, range.to)
      if (start <= end) yield* this.#pagesInRange(start, end)
    }
  }
  *#pagesInRange(from: number, to: number) {
    let start = from,
      records: CodeBlockExtent[] = [],
      units = 0
    for (const record of this.records(from, to)) {
      const size = JSON.stringify(record).length
      if (records.length && (records.length === 64 || units + size > 7680)) {
        const end = records.at(-1)!.to
        yield { from: start, to: end, records, done: false }
        start = end
        records = []
        units = 0
      }
      records.push(record)
      units += size
    }
    yield { from: start, to, records, done: true }
  }
}
