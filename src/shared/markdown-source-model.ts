import type { Parser, Tree } from '@lezer/common'
import type {
  PreparedSourceOperation,
  SourceSnapshot,
  SourceStorageChange,
} from './source-buffer.ts'
import type { RawEdit } from './source-operations.ts'
import {
  type OwnerIndexOptions,
  type SourceOwner,
  SourceOwners,
} from './source-owners.ts'
import { SourceParserSession } from './source-parser.ts'

type Range = { from: number; to: number }
type Block = Range & { kind: string; tree?: Tree }
export type MarkdownSourceState = Readonly<{
  source: SourceSnapshot
  owners: SourceOwners | null
  complete: boolean
  dialect: string
}>
/** Bounded coarse membership data, never an authorization for visual inverse edits. */
export type SourceOwnerPage = Readonly<{
  version: number
  dialect: string
  epoch: string | null
  complete: boolean
  rows: readonly Readonly<{
    owner: SourceOwner
    index: number
    from: number
    to: number
  }>[]
  next: number | null
}>
const emptyWork = () => ({
  nodesVisited: 0,
  boundarySeeks: 0,
  ownersReused: 0,
  regions: 0,
  rowsWritten: 0,
  initialRows: 0,
})
const mergeRanges = (ranges: readonly Range[]): Range[] => {
  const merged: Range[] = []
  for (const range of [...ranges].sort(
    (a, b) => a.from - b.from || a.to - b.to,
  )) {
    if (range.from === range.to) continue
    const previous = merged.at(-1)
    if (previous && previous.to >= range.from)
      previous.to = Math.max(previous.to, range.to)
    else merged.push({ ...range })
  }
  return merged
}

/** Coarse Markdown CST ownership only; visual inverses require separate span/provenance proofs. */
export class MarkdownSourceModel {
  readonly #parser: SourceParserSession
  readonly #options: OwnerIndexOptions
  #state: MarkdownSourceState
  readonly #trees = new Map<number, Tree>()
  #work = emptyWork()
  constructor(
    source: SourceSnapshot,
    parser: Parser,
    dialect: string,
    options: OwnerIndexOptions = {},
  ) {
    this.#parser = new SourceParserSession(source, parser, dialect)
    this.#options = { ...options }
    this.#state = Object.freeze({
      source,
      owners: null,
      complete: false,
      dialect,
    })
  }
  state = () => this.#state
  page(from: number, to: number, limit = 128): SourceOwnerPage {
    const { source, owners, complete, dialect } = this.#state
    if (
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to) ||
      from < 0 ||
      to < from ||
      to > source.utf16Length ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 256
    )
      throw new Error('Invalid source owner page request.')
    const first = owners?.at(from),
      last = owners?.at(to, from === to ? 1 : -1)
    const end =
      first && last ? Math.min(last.index + 1, first.index + limit) : 0
    const rows = first && last ? [...owners!.records(first.index, end)] : []
    return Object.freeze({
      version: source.version,
      dialect,
      epoch: owners?.epoch ?? null,
      complete,
      rows: Object.freeze(rows),
      next: last && end <= last.index ? rows.at(-1)!.to : null,
    })
  }
  adoptStorage(change: SourceStorageChange) {
    this.#parser.adoptStorage(change)
    this.#state = Object.freeze({ ...this.#state, source: change.after })
  }
  counters(reset = false) {
    const result = {
      ...this.#work,
      parser: this.#parser.counters(reset),
      owners: this.#state.owners?.counters(reset),
    }
    if (reset) Object.assign(this.#work, emptyWork())
    return result
  }
  #edit(owners: SourceOwners, change: RawEdit) {
    const inserted = change.insert.length
    if (change.from === change.to) {
      if (!inserted) return owners
      const at = owners.at(change.from),
        previous = change.from ? owners.at(change.from, -1) : null
      if (!at || at.from === change.from || change.from === owners.length) {
        if (
          previous?.to === change.from &&
          !previous.owner.parsed &&
          previous.owner.kind === 'unparsed'
        )
          return owners.update(previous.index, {
            ...previous.owner,
            length: previous.owner.length + inserted,
            parsed: false,
          })
        return owners.splice(
          change.from === owners.length ? owners.count : at!.index,
          change.from === owners.length ? owners.count : at!.index,
          [{ kind: 'unparsed', length: inserted, parsed: false }],
        )
      }
      return owners.update(at.index, {
        ...at.owner,
        length: at.owner.length + inserted,
        parsed: false,
      })
    }
    const first = owners.at(change.from),
      last = owners.at(change.to, -1)
    if (!first || !last)
      throw new Error('Source edit is outside its owner index.')
    const length = last.to - first.from - (change.to - change.from) + inserted
    for (const row of owners.records(
      first.index + Number(length > 0),
      last.index + 1,
    ))
      this.#trees.delete(row.owner.slot)
    if (!length) {
      let next = owners.splice(first.index, last.index + 1, [])
      // Removing an entire separator can merge its neighboring blocks.
      const boundary = [next.at(change.from, -1), next.at(change.from)]
      const marked = new Set<number>()
      for (const row of boundary)
        if (row && !marked.has(row.index)) {
          next = next.update(row.index, { ...row.owner, parsed: false })
          marked.add(row.index)
        }
      return next
    }
    return owners
      .update(first.index, { ...first.owner, length, parsed: false })
      .splice(first.index + 1, last.index + 1, [])
  }
  apply(prepared: PreparedSourceOperation) {
    if (prepared.before !== this.#state.source)
      throw new Error('Markdown owner operation is stale.')
    let owners = this.#state.owners
    if (owners) {
      for (let at = prepared.operation.changes.length - 1; at >= 0; at--)
        owners = this.#edit(owners, prepared.operation.changes[at]!)
      if (owners.length !== prepared.after.utf16Length)
        throw new Error('Source and owner lengths disagree.')
    }
    this.#parser.apply(prepared)
    this.#state = Object.freeze({
      ...this.#state,
      source: prepared.after,
      owners,
      complete: false,
    })
  }
  /** grammar lookahead can change an earlier owner without editing its text. */
  invalidate(from: number, to: number) {
    this.#parser.invalidate(from, to)
    let owners = this.#state.owners
    const first = owners?.at(from),
      last = owners?.at(to, -1)
    if (owners && first && last)
      for (const row of owners.records(first.index, last.index + 1))
        owners = owners.update(row.index, { ...row.owner, parsed: false })
    this.#state = Object.freeze({ ...this.#state, owners, complete: false })
  }
  reconfigure(parser: Parser, dialect: string) {
    this.#parser.reconfigure(parser, dialect)
    this.#trees.clear()
    this.#state = Object.freeze({
      source: this.#state.source,
      owners: null,
      complete: false,
      dialect,
    })
  }
  #raw(position: number) {
    const raw = this.#state.source.editorToRaw(position)
    if (raw === null)
      throw new Error('Parser position is outside its source snapshot.')
    return raw
  }
  #blocks(tree: Tree, from: number, to: number): Block[] {
    const source = this.#state.source,
      blocks: Block[] = []
    const normalizedFrom = source.rawToEditor(from),
      normalizedTo = source.rawToEditor(to)
    if (normalizedFrom === null || normalizedTo === null)
      throw new Error('Owner boundary splits a line ending.')
    tree.iterate({
      from: normalizedFrom,
      to: normalizedTo,
      enter: (node) => {
        this.#work.nodesVisited++
        if (node.name === 'Document' || node.type.isAnonymous) return
        const start = this.#raw(node.from),
          end = this.#raw(node.to)
        if (start < to && end > from && start < end)
          blocks.push({
            from: start,
            to: end,
            kind: `markdown:${node.name}`,
            tree: node.node.toTree(),
          })
        return false
      },
    })
    return blocks
  }
  #rows(tree: Tree, from: number, to: number): Block[] {
    const rows: Block[] = []
    let position = from
    for (const block of this.#blocks(tree, from, to)) {
      if (block.from < from || block.to > to)
        throw new Error('A parser region cuts a source owner.')
      if (block.from > position)
        rows.push({ from: position, to: block.from, kind: 'trivia' })
      rows.push(block)
      position = block.to
    }
    if (position < to) rows.push({ from: position, to, kind: 'trivia' })
    return rows
  }
  #bounds(owners: SourceOwners, from: number, to: number) {
    const first = owners.at(from),
      last = owners.at(to, -1)
    return first && last && first.from === from && last.to === to
      ? { first, last }
      : null
  }
  #boundary(tree: Tree, raw: number, side: -1 | 1): Range | null {
    const position = this.#state.source.rawToEditor(raw)
    if (position === null)
      throw new Error('Owner boundary splits a line ending.')
    this.#work.boundarySeeks++
    let block = null
    for (
      let node = tree.resolve(position, side);
      node.parent;
      node = node.parent
    ) {
      this.#work.nodesVisited++
      if (!node.type.isAnonymous) block = node
    }
    return block
      ? { from: this.#raw(block.from), to: this.#raw(block.to) }
      : null
  }
  #expand(tree: Tree, range: Range, owners: SourceOwners): Range {
    let { from, to } = range
    for (;;) {
      const first = owners.at(from),
        last = owners.at(to, -1)
      const previous = first ? owners.get(first.index - 1) : null,
        next = last ? owners.get(last.index + 1) : null
      const start = Math.min(
          from,
          first?.from ?? from,
          previous?.owner.kind === 'trivia' ? previous.from : from,
        ),
        end = Math.max(
          to,
          last?.to ?? to,
          next?.owner.kind === 'trivia' ? next.to : to,
        )
      let nextFrom = start,
        nextTo = end
      // Only boundary blocks can extend coverage. Re-enumerating the growing
      // interior becomes quadratic when an inserted fence shifts later pairings.
      for (const block of [
        this.#boundary(tree, start, 1),
        this.#boundary(tree, end, -1),
      ])
        if (block && block.from < end && block.to > start) {
          nextFrom = Math.min(nextFrom, block.from)
          nextTo = Math.max(nextTo, block.to)
        }
      if (nextFrom === from && nextTo === to) return { from, to }
      from = nextFrom
      to = nextTo
    }
  }
  #unchanged(row: Block, owners: SourceOwners) {
    const bounds = this.#bounds(owners, row.from, row.to)
    if (
      !bounds ||
      bounds.first.index !== bounds.last.index ||
      !bounds.first.owner.parsed ||
      bounds.first.owner.kind !== row.kind
    )
      return false
    return row.tree
      ? this.#trees.get(bounds.first.owner.slot) === row.tree
      : row.kind === 'trivia'
  }
  #remember(owners: SourceOwners, rows: readonly Block[], from = 0) {
    let at = 0
    for (const row of owners.records(from, from + rows.length)) {
      const tree = rows[at++]!.tree
      if (tree) this.#trees.set(row.owner.slot, tree)
      else this.#trees.delete(row.owner.slot)
    }
  }
  #reconcile(tree: Tree): SourceOwners {
    let owners = this.#state.owners
    if (!owners) {
      const rows = this.#rows(tree, 0, this.#state.source.utf16Length)
      this.#work.initialRows += rows.length
      owners = new SourceOwners(
        rows.map((row) => ({ kind: row.kind, length: row.to - row.from })),
        this.#options,
      )
      this.#remember(owners, rows)
    } else {
      // These are coarse top-level Markdown boundaries, not semantic cache or
      // checkpoint proofs. Open containers are whole owners; inline reference
      // dependencies need their own invalidation domain before render reuse.
      const changed = [...owners.pending()],
        beforeCount = owners.count
      let replaced = 0
      const expanded = mergeRanges(
        mergeRanges(changed).map((range) => this.#expand(tree, range, owners!)),
      )
      for (const range of expanded.reverse()) {
        const rows = this.#rows(tree, range.from, range.to)
        let start = 0,
          end = rows.length
        while (start < end && this.#unchanged(rows[start]!, owners)) start++
        while (end > start && this.#unchanged(rows[end - 1]!, owners)) end--
        if (start === end) continue
        const from = rows[start]!.from,
          to = rows[end - 1]!.to,
          first = owners.at(from),
          last = owners.at(to, -1)
        if (!first || !last || first.from !== from || last.to !== to)
          throw new Error(
            'Parser reconciliation does not cover complete owners.',
          )
        const records = rows.slice(start, end).map((row) => ({
          kind: row.kind,
          length: row.to - row.from,
          parsed: true,
        }))
        this.#work.regions++
        this.#work.rowsWritten += records.length
        replaced += last.index - first.index + 1
        for (const row of owners.records(first.index, last.index + 1))
          this.#trees.delete(row.owner.slot)
        owners = owners
          .update(first.index, records[0]!)
          .splice(first.index + 1, last.index + 1, records.slice(1))
        this.#remember(owners, rows.slice(start, end), first.index)
      }
      this.#work.ownersReused += beforeCount - replaced
    }
    if (owners.length !== this.#state.source.utf16Length || owners.invalid())
      throw new Error('Parser coverage does not match source ownership.')
    return owners
  }
  /** Run on the parser service, never in an active input callback. */
  advance() {
    if (this.#state.complete) return this.#state
    const parsed = this.#parser.advance()
    if (parsed.complete && parsed.tree) {
      const owners = this.#reconcile(parsed.tree)
      this.#state = Object.freeze({ ...this.#state, owners, complete: true })
    }
    return this.#state
  }
  dispose() {
    this.#parser.dispose()
    this.#trees.clear()
    this.#state = Object.freeze({
      ...this.#state,
      owners: null,
      complete: false,
    })
  }
}
