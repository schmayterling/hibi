import { Lexer } from 'marked'
import { endsReferenceTitle } from '../../shared/marked-blocks.ts'
import type {
  PreparedSourceOperation,
  SourceSnapshot,
} from '../../shared/source-buffer.ts'
import type { RawEdit } from '../../shared/source-operations.ts'
import { SourceOwners } from '../../shared/source-owners.ts'
import {
  countDefinition,
  pendingDefinitionTitle,
} from './formatted-count-syntax.ts'

const eof = -1
const marker = /[[\]\\"'()]/g

type Read = {
  valid: boolean
  dependencies: Set<number>
  headers: Set<number>
  headerLines: Set<number>
  closing: number | null
  watchedTitle: boolean
}
type Row = { kind: string; length: number }

/** structural lookahead for marked labels, without owning their intervening paragraphs. */
export class CountBrackets {
  #source: SourceSnapshot
  #markers: SourceOwners
  readonly #reads = new Map<number, Read>()
  readonly #readers = new Map<number, Set<number>>()
  readonly #headerReaders = new Map<number, Set<number>>()
  #work = { readUnits: 0, markerVisits: 0, candidateQueries: 0 }
  readonly #gfm: boolean

  constructor(source: SourceSnapshot, gfm = false) {
    this.#source = source
    this.#gfm = gfm
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
    const read = this.#reads.get(slot)
    for (const [map, dependencies] of [
      [this.#readers, read?.dependencies],
      [this.#headerReaders, read?.headers],
    ] as const)
      for (const dependency of dependencies ?? []) {
        const readers = map.get(dependency)
        readers?.delete(slot)
        if (!readers?.size) map.delete(dependency)
      }
    this.#reads.delete(slot)
  }
  #read(
    from: number,
    to: number,
    headers?: Set<number>,
    lines?: Set<number>,
    baseLine = 0,
  ) {
    this.#work.readUnits += to - from
    const first = headers && this.#markers.at(from),
      last = headers && this.#markers.at(to, -1)
    if (headers && first && last)
      for (const row of this.#markers.records(first.index, last.index + 1))
        headers.add(row.owner.slot)
    if (headers && to === this.#source.utf16Length) headers.add(eof)
    lines?.add(this.#source.lineAt(from)!.number - baseLine)
    return this.#source.sliceRaw(from, to)
  }
  #title(
    from: number,
    title: string,
    dependencies: Set<number>,
    headers: Set<number>,
    lines: Set<number>,
    baseLine: number,
    initial: number | null = null,
  ): number | null {
    const first = from < this.#markers.length ? this.#markers.at(from) : null,
      rule = Lexer.rules.block[this.#gfm ? 'gfm' : 'normal'].def
    let number = this.#source.lineAt(from)!.number + 1,
      actual = initial
    for (const row of this.#markers.records(
      first?.index ?? this.#markers.count,
    )) {
      dependencies.add(row.owner.slot)
      this.#work.markerVisits++
      if (row.owner.kind !== (title === '(' ? ')' : title)) continue
      const last = this.#source.lineAt(row.to - 1)!.number
      for (; number <= last; number++) {
        const start = this.#source.lineStart(number)!,
          end = this.#source.lineAt(start)!.to,
          text = this.#read(
            start,
            end,
            this.#gfm ? headers : undefined,
            this.#gfm ? lines : undefined,
            baseLine,
          ),
          prefix = `[count]: /x ${title}x`,
          probe = `${prefix}\n${text}`,
          match = rule.exec(`${probe}\n`)
        const next =
          this.#gfm && !match?.[3] ? this.#source.lineStart(number + 1) : null
        const continuation =
          next === null
            ? text
            : `${text}\n${this.#read(next, this.#source.lineAt(next)!.to, headers, lines, baseLine)}`
        if (
          endsReferenceTitle(
            continuation,
            Lexer.rules.block[this.#gfm ? 'gfm' : 'normal'].paragraph,
          )
        ) {
          this.#read(start, end, headers, lines, baseLine)
          return actual
        }
        if (match?.[3] && countDefinition(`${probe}\n`, this.#gfm)) actual = end
        const pending = pendingDefinitionTitle(rule, probe, this.#gfm)
        if (number === last || !pending)
          this.#read(start, end, headers, lines, baseLine)
        if (!pending) return actual
      }
    }
    // an escaped closer can finish now and remain body if a later closer appears.
    dependencies.add(eof)
    return actual
  }
  #header(
    closing: NonNullable<ReturnType<SourceOwners['get']>>,
    headers: Set<number>,
    dependencies: Set<number>,
    lines: Set<number>,
    baseLine: number,
  ) {
    const rule = Lexer.rules.block[this.#gfm ? 'gfm' : 'normal'].def
    const line = this.#source.lineAt(closing.to - 1)!
    const read = (from: number, to: number) => {
      this.#work.readUnits += to - from
      const first = this.#markers.at(from),
        last = this.#markers.at(to, -1)
      if (first && last)
        for (const row of this.#markers.records(first.index, last.index + 1))
          if (row.owner.slot !== closing.owner.slot) headers.add(row.owner.slot)
      if (to === this.#source.utf16Length) headers.add(eof)
      lines.add(this.#source.lineAt(from)!.number - baseLine)
      return this.#source.sliceRaw(from, to)
    }
    const prefix = `[count${read(closing.to - 1, line.to)}`
    const match = countDefinition(`${prefix}\n`, this.#gfm)
        ? rule.exec(`${prefix}\n`)
        : null,
      title = pendingDefinitionTitle(rule, prefix, this.#gfm)
    if (title)
      return (
        this.#title(
          line.to,
          title,
          dependencies,
          headers,
          lines,
          baseLine,
          match?.[3] ? line.to : null,
        ) !== null
      )
    if (match) return true
    // only inspect another destination line if the exact rule can accept one.
    if (!countDefinition(`${prefix}\n/x\n`, this.#gfm)) return false
    const next = this.#source.lineStart(line.number + 1)
    if (next === null) return false
    const end = this.#source.lineAt(next)!.to
    const probe = `${prefix}\n${read(next, end)}`
    const nextMatch = countDefinition(`${probe}\n`, this.#gfm)
        ? rule.exec(`${probe}\n`)
        : null,
      nextTitle = pendingDefinitionTitle(rule, probe, this.#gfm)
    if (nextTitle)
      return (
        this.#title(
          end,
          nextTitle,
          dependencies,
          headers,
          lines,
          baseLine,
          nextMatch?.[3] ? end : null,
        ) !== null
      )
    return !!nextMatch
  }
  #query(slot: number, reuseClosing = false) {
    const previous = this.#reads.get(slot)
    this.#forget(slot)
    const opener = this.#markers.bySlot(slot)
    if (opener?.owner.kind !== '[') return false
    this.#work.candidateQueries++
    let closing =
      reuseClosing && previous?.closing
        ? this.#markers.bySlot(previous.closing)
        : null
    const dependencies = new Set<number>(closing ? previous?.dependencies : []),
      headers = new Set<number>(),
      headerLines = new Set<number>()
    let position = opener.to,
      ended = !!closing
    for (const row of closing ? [] : this.#markers.records(opener.index + 1)) {
      this.#work.markerVisits++
      if (row.owner.kind === 'text') break
      dependencies.add(row.owner.slot)
      if (row.to - 1 < position) continue
      if (row.owner.kind === '\\') {
        position = row.to + 1
        continue
      }
      if (row.owner.kind !== '[' && row.owner.kind !== ']') continue
      if (row.owner.kind === ']') closing = row
      ended = true
      break
    }
    if (!ended) dependencies.add(eof)
    const valid =
      !!closing &&
      this.#header(
        closing,
        headers,
        dependencies,
        headerLines,
        this.#source.lineAt(opener.to - 1)!.number,
      )
    this.#remember(slot, {
      valid,
      dependencies,
      headers,
      closing: closing?.owner.slot ?? null,
      headerLines,
      watchedTitle: false,
    })
    return valid
  }
  #remember(slot: number, read: Read) {
    this.#reads.set(slot, read)
    const { dependencies, headers } = read
    for (const [map, reads] of [
      [this.#readers, dependencies],
      [this.#headerReaders, headers],
    ] as const)
      for (const dependency of reads) {
        let readers = map.get(dependency)
        if (!readers) {
          readers = new Set()
          map.set(dependency, readers)
        }
        readers.add(slot)
      }
  }
  canTitle(from: number, end: number, title: string, complete = false) {
    const raw = this.#source.editorToRaw(from),
      tail = this.#source.editorToRaw(end),
      row = raw === null ? null : this.#markers.at(raw),
      previous = row && this.#reads.get(row.owner.slot)
    if (!row || !previous || tail === null) return null
    const dependencies = new Set(previous.dependencies),
      headers = new Set(previous.headers),
      headerLines = new Set(previous.headerLines),
      valid = this.#title(
        tail,
        title,
        dependencies,
        headers,
        headerLines,
        this.#source.lineAt(row.to - 1)!.number,
        complete ? tail : null,
      )
    this.#forget(row.owner.slot)
    this.#remember(row.owner.slot, {
      ...previous,
      dependencies,
      headers,
      headerLines,
      watchedTitle: true,
    })
    return valid === null ? null : this.#source.rawToEditor(valid)
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
  #edit(change: RawEdit, affected: Set<number>, rescan: Set<number>) {
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
    let structural =
      scan.rows.length > 0 ||
      /[\r\n]/.test(insert) ||
      this.#source.lineAt(from)?.number !== this.#source.lineAt(to)?.number
    for (const row of this.#markers.records(start, end))
      if (row.owner.kind !== 'text') structural = true
    const collect = (slot: number, labels: boolean) => {
      for (const reader of this.#headerReaders.get(slot) ?? []) {
        if (!structural) {
          const read = this.#reads.get(reader),
            opener = this.#markers.bySlot(reader),
            base = opener && this.#source.lineAt(opener.to - 1)!.number,
            first = this.#source.lineAt(from)!.number - (base ?? 0),
            last = this.#source.lineAt(to)!.number - (base ?? 0)
          if (
            !read ||
            ![...read.headerLines].some((line) => line >= first && line <= last)
          )
            continue
        }
        affected.add(reader)
      }
      if (labels)
        for (const reader of this.#readers.get(slot) ?? []) {
          affected.add(reader)
          rescan.add(reader)
        }
    }
    for (const row of this.#markers.records(
      start,
      Math.min(end + 1, this.#markers.count),
    ))
      collect(row.owner.slot, structural)
    if (structural || to === this.#markers.length) collect(eof, structural)
    // the unit after a closer or escape determines header and escape semantics.
    const previous = from ? this.#markers.at(from, -1) : null
    if (
      previous?.to === from &&
      (previous.owner.kind === ']' || previous.owner.kind === '\\')
    )
      for (const reader of this.#readers.get(previous.owner.slot) ?? []) {
        affected.add(reader)
        if (previous.owner.kind === '\\') rescan.add(reader)
      }
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
      rescan = new Set<number>(),
      previous = new Map<number, Read | undefined>()
    for (let at = prepared.operation.changes.length - 1; at >= 0; at--)
      this.#edit(prepared.operation.changes[at]!, affected, rescan)
    for (const slot of affected) previous.set(slot, this.#reads.get(slot))
    this.#source = prepared.after
    const openers: number[] = []
    for (const slot of affected) {
      const valid = this.#query(slot, !rescan.has(slot)),
        before = previous.get(slot)
      if (!before?.watchedTitle && (!valid || before?.valid)) continue
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
    this.#headerReaders.clear()
  }
}
