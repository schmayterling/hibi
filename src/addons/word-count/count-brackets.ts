import type {
  PreparedSourceOperation,
  SourceSnapshot,
} from '../../shared/source-buffer.ts'
import type { RawEdit } from '../../shared/source-operations.ts'
import { SourceOwners } from '../../shared/source-owners.ts'

const eof = -1
const marker = /[[\]\\]/g

type Read = { valid: boolean; dependencies: Set<number> }
type Row = { kind: string; length: number }

/** structural lookahead for marked labels, without owning their intervening paragraphs. */
export class CountBrackets {
  #source: SourceSnapshot
  #markers: SourceOwners
  readonly #reads = new Map<number, Read>()
  readonly #readers = new Map<number, Set<number>>()
  #work = { readUnits: 0, markerVisits: 0, candidateQueries: 0 }

  constructor(source: SourceSnapshot) {
    this.#source = source
    const rows: Row[] = []
    let pending = 0
    for (const chunk of source.chunks()) {
      const scan = this.#scan(chunk, pending)
      rows.push(...scan.rows)
      pending = scan.pending
    }
    if (pending) rows.push({ kind: 'text', length: pending })
    this.#markers = new SourceOwners(rows)
    for (const _ of this.#markers.prepareLookup()) {
    }
  }
  #scan(text: string, prefix = 0) {
    this.#work.readUnits += text.length
    const rows: Row[] = []
    let end = 0
    for (const match of text.matchAll(marker)) {
      rows.push({ kind: match[0], length: prefix + match.index - end + 1 })
      prefix = 0
      end = match.index + 1
    }
    return { rows, pending: prefix + text.length - end }
  }
  #forget(slot: number) {
    for (const dependency of this.#reads.get(slot)?.dependencies ?? []) {
      const readers = this.#readers.get(dependency)
      readers?.delete(slot)
      if (!readers?.size) this.#readers.delete(dependency)
    }
    this.#reads.delete(slot)
  }
  #query(slot: number) {
    this.#forget(slot)
    const opener = this.#markers.bySlot(slot)
    if (opener?.owner.kind !== '[') return false
    this.#work.candidateQueries++
    const dependencies = new Set<number>()
    let position = opener.to,
      valid = false,
      ended = false
    for (const row of this.#markers.records(opener.index + 1)) {
      this.#work.markerVisits++
      if (row.owner.kind === 'text') break
      dependencies.add(row.owner.slot)
      if (row.to - 1 < position) continue
      if (row.owner.kind === '\\') {
        position = row.to + 1
        continue
      }
      if (row.owner.kind === ']') {
        const end = Math.min(this.#source.utf16Length, row.to + 1)
        this.#work.readUnits += end - row.to
        valid = this.#source.sliceRaw(row.to, end) === ':'
      }
      ended = true
      break
    }
    if (!ended) dependencies.add(eof)
    this.#reads.set(slot, { valid, dependencies })
    for (const dependency of dependencies) {
      let readers = this.#readers.get(dependency)
      if (!readers) {
        readers = new Set()
        this.#readers.set(dependency, readers)
      }
      readers.add(slot)
    }
    return valid
  }
  canClose(from: number) {
    const raw = this.#source.editorToRaw(from)
    const row = raw === null ? null : this.#markers.at(raw)
    return (
      !!row &&
      row.owner.kind === '[' &&
      row.to - 1 === raw &&
      this.#query(row.owner.slot)
    )
  }
  #edit(change: RawEdit, affected: Set<number>) {
    const { from, to, insert } = change
    let first = from < this.#markers.length ? this.#markers.at(from) : null
    // the last text row is a gap, not a marker. append into that gap.
    if (
      !first &&
      this.#markers.get(this.#markers.count - 1)?.owner.kind === 'text'
    )
      first = this.#markers.get(this.#markers.count - 1)
    const after = to < this.#markers.length ? this.#markers.at(to) : null
    const start = first?.index ?? this.#markers.count,
      end = after?.index ?? this.#markers.count
    const scan = this.#scan(insert, first ? from - first.from : 0)
    let structural = scan.rows.length > 0
    for (const row of this.#markers.records(start, end))
      if (row.owner.kind !== 'text') structural = true
    const collect = (slot: number) => {
      for (const reader of this.#readers.get(slot) ?? []) affected.add(reader)
    }
    if (structural) {
      for (const row of this.#markers.records(
        start,
        Math.min(end + 1, this.#markers.count),
      ))
        collect(row.owner.slot)
      collect(eof)
    }
    // even a non-marker edit immediately after ']' can create or remove ']:'.
    const previous = from ? this.#markers.at(from, -1) : null
    if (previous?.owner.kind === ']' && previous.to === from)
      collect(previous.owner.slot)
    for (const row of this.#markers.records(start, end))
      this.#forget(row.owner.slot)
    if (after)
      this.#markers = this.#markers
        .update(after.index, {
          kind: after.owner.kind,
          length: scan.pending + after.to - to,
        })
        .splice(start, end, scan.rows)
    else {
      if (scan.pending) scan.rows.push({ kind: 'text', length: scan.pending })
      this.#markers = this.#markers.splice(start, end, scan.rows)
    }
  }
  apply(prepared: PreparedSourceOperation): readonly number[] {
    if (prepared.before !== this.#source)
      throw new Error('Bracket index source operation is stale.')
    const affected = new Set<number>(),
      previous = new Map<number, boolean>()
    for (let at = prepared.operation.changes.length - 1; at >= 0; at--)
      this.#edit(prepared.operation.changes[at]!, affected)
    for (const slot of affected)
      previous.set(slot, this.#reads.get(slot)?.valid ?? false)
    this.#source = prepared.after
    const openers: number[] = []
    for (const slot of affected) {
      if (!this.#query(slot) || previous.get(slot)) continue
      const row = this.#markers.bySlot(slot)
      if (row) openers.push(row.to - 1)
    }
    return openers
  }
  counters(reset = false) {
    const result = { ...this.#work, owners: this.#markers.counters(reset) }
    if (reset)
      this.#work = { readUnits: 0, markerVisits: 0, candidateQueries: 0 }
    return result
  }
  dispose() {
    this.#reads.clear()
    this.#readers.clear()
  }
}
