import type { SourceOwner, SourceOwners } from './source-owners.ts'
import { ownSourceText } from './source-text.ts'

export type ReferenceValue = Readonly<{ href: string; title?: string | null }>
export type ReferenceDefinitions = Readonly<Record<string, ReferenceValue>>
export type ReferenceRegion = Readonly<{
  owner: SourceOwner
  index: number
  from: number
  contentFrom: number
  to: number
}>
type Reader = (region: ReferenceRegion) => ReferenceDefinitions
type Candidate = Readonly<{ owner: SourceOwner; value: ReferenceValue }>

/** Indexed heap: removing a definition does not scan all duplicates of its name. */
class Candidates {
  readonly #items: Candidate[] = []
  readonly #positions = new Map<number, number>()
  readonly #before: (a: Candidate, b: Candidate) => boolean
  constructor(before: (a: Candidate, b: Candidate) => boolean) {
    this.#before = before
  }
  first() {
    return this.#items[0]
  }
  #swap(a: number, b: number) {
    const value = this.#items[a]!
    this.#items[a] = this.#items[b]!
    this.#items[b] = value
    this.#positions.set(this.#items[a]!.owner.slot, a)
    this.#positions.set(value.owner.slot, b)
  }
  #up(index: number) {
    while (index) {
      const parent = Math.floor((index - 1) / 2)
      if (!this.#before(this.#items[index]!, this.#items[parent]!)) break
      this.#swap(index, parent)
      index = parent
    }
    return index
  }
  add(value: Candidate) {
    this.#positions.set(value.owner.slot, this.#items.length)
    this.#items.push(value)
    this.#up(this.#items.length - 1)
  }
  remove(slot: number) {
    const index = this.#positions.get(slot)
    if (index === undefined) return
    const last = this.#items.pop()!
    this.#positions.delete(slot)
    if (index === this.#items.length) return
    this.#items[index] = last
    this.#positions.set(last.owner.slot, index)
    let at = this.#up(index)
    for (;;) {
      let child = at * 2 + 1
      if (child >= this.#items.length) break
      if (
        child + 1 < this.#items.length &&
        this.#before(this.#items[child + 1]!, this.#items[child]!)
      )
        child++
      if (!this.#before(this.#items[child]!, this.#items[at]!)) break
      this.#swap(at, child)
      at = child
    }
  }
}

/** Semantic reference environment; values and owner handles never authorize source edits. */
export class SourceReferences {
  #owners: SourceOwners | null
  readonly #definitions = new Map<number, Map<string, Candidate>>()
  readonly #candidates = new Map<string, Candidates>()
  readonly #winners = new Map<string, Candidate>()
  #labels = () => this.#winners.keys()
  #reading = false
  #ready = false
  #count = 0
  #work = { ownersRead: 0, definitionsRead: 0, comparisons: 0, scopeReads: 0 }
  constructor(owners: SourceOwners, read?: Reader) {
    if (owners.invalid())
      throw new Error('Reference definitions require complete source owners.')
    this.#owners = owners
    if (read) this.update(owners, read)
  }
  #region(owners: SourceOwners, slot: number): ReferenceRegion | null {
    const row = owners.bySlot(slot)
    if (!row || row.owner.kind === 'trivia') return null
    let from = row.from,
      to = row.to,
      at = row.index - 1
    for (
      let previous = owners.get(at);
      previous?.owner.kind === 'trivia';
      previous = owners.get(--at)
    )
      from = previous.from
    at = row.index + 1
    let next = owners.get(at)
    while (next?.owner.kind === 'trivia') {
      to = next.to
      next = owners.get(++at)
    }
    if (next) to = row.to
    return Object.freeze({ ...row, from, contentFrom: row.from, to })
  }
  #add(
    slot: number,
    definitions: Map<string, Candidate>,
    changed?: Set<string>,
  ) {
    this.#definitions.set(slot, definitions)
    this.#count += definitions.size
    for (const [label, value] of definitions) {
      let candidates = this.#candidates.get(label)
      if (!candidates) {
        candidates = new Candidates((a, b) => {
          this.#work.comparisons++
          return (
            this.#owners!.bySlot(a.owner.slot)!.index <
            this.#owners!.bySlot(b.owner.slot)!.index
          )
        })
        this.#candidates.set(label, candidates)
      }
      candidates.add(value)
      if (changed) changed.add(label)
      else this.#winners.set(label, candidates.first()!)
    }
  }
  #clear() {
    this.#definitions.clear()
    this.#candidates.clear()
    this.#winners.clear()
    this.#count = 0
  }
  *#replace(owners: SourceOwners, slots: Iterable<number>, read: Reader) {
    const cold = !this.#ready
    const ids = new Set<number>()
    const prepared = new Map<number, Map<string, Candidate>>()
    this.#reading = true
    if (cold) this.#owners = owners
    try {
      for (const slot of slots) {
        if (!cold) ids.add(slot)
        const region = this.#region(owners, slot)
        if (!region) {
          yield
          continue
        }
        this.#work.ownersRead++
        const values = read(region),
          definitions = new Map<string, Candidate>()
        for (const [label, value] of Object.entries(values)) {
          const href = value?.href,
            title = value?.title ?? null
          if (
            typeof href !== 'string' ||
            (title !== null && typeof title !== 'string')
          )
            throw new Error('Invalid reference definition.')
          this.#work.definitionsRead++
          const previous = this.#definitions.get(slot)?.get(label)
          definitions.set(
            ownSourceText(label),
            previous?.owner === region.owner &&
              previous.value.href === href &&
              previous.value.title === title
              ? previous
              : Object.freeze({
                  owner: region.owner,
                  value: Object.freeze({
                    href: ownSourceText(href),
                    title: title === null ? null : ownSourceText(title),
                  }),
                }),
          )
        }
        if (definitions.size) {
          if (cold) this.#add(slot, definitions)
          else prepared.set(slot, definitions)
        }
        yield
      }
      if (cold) {
        this.#ready = true
        return
      }
    } finally {
      this.#reading = false
      if (cold && !this.#ready) this.#clear()
    }
    const changed = new Set<string>()
    // Remove against the old order before switching the comparator's snapshot.
    for (const slot of ids) {
      const previous = this.#definitions.get(slot)
      if (!previous) continue
      for (const label of previous.keys()) {
        this.#candidates.get(label)!.remove(slot)
        changed.add(label)
      }
      this.#count -= previous.size
      this.#definitions.delete(slot)
    }
    this.#owners = owners
    for (const [slot, definitions] of prepared)
      this.#add(slot, definitions, changed)
    for (const label of changed) {
      const first = this.#candidates.get(label)?.first()
      if (first) this.#winners.set(label, first)
      else {
        this.#winners.delete(label)
        this.#candidates.delete(label)
      }
    }
    if (changed.size) this.#labels = () => this.#winners.keys()
    this.#ready = true
  }
  update(owners: SourceOwners, read: Reader) {
    for (const _ of this.updateWork(owners, read)) {
      /* Synchronous callers drain the same atomic preparation. */
    }
  }
  *updateWork(owners: SourceOwners, read: Reader): Generator<void> {
    if (!this.#owners || this.#reading)
      throw new Error('Reference index is disposed or already updating.')
    if (owners.invalid())
      throw new Error('Reference definitions require complete source owners.')
    const previous = this.#owners
    if (!this.#ready) {
      if (owners.epoch !== previous.epoch)
        throw new Error('Source owner snapshots belong to different arenas.')
      this.#reading = true
      try {
        yield* owners.prepareLookup()
      } finally {
        this.#reading = false
      }
    }
    const delta = owners.changesSince(previous)
    if (!this.#ready) {
      yield* this.#replace(
        owners,
        (function* () {
          for (const row of owners.records()) yield row.owner.slot
        })(),
        read,
      )
      return
    }
    const ids = new Set(
      [...delta.changed, ...delta.removed].map((owner) => owner.slot),
    )
    const following = (index: SourceOwners, slot: number) => {
      const row = index.bySlot(slot)
      if (row?.owner.kind !== 'trivia') return
      let at = row.index + 1,
        next = index.get(at)
      while (next?.owner.kind === 'trivia') next = index.get(++at)
      if (next) ids.add(next.owner.slot)
    }
    for (const owner of delta.changed) following(owners, owner.slot)
    for (const owner of delta.removed) following(previous, owner.slot)
    // EOF is part of the final region's input context, including trailing trivia.
    const last = (index: SourceOwners) => {
      let at = index.count - 1,
        row = index.get(at)
      while (row?.owner.kind === 'trivia') row = index.get(--at)
      return row
    }
    const oldLast = last(previous),
      newLast = last(owners)
    const oldTail = previous.get(previous.count - 1)?.owner,
      newTail = owners.get(owners.count - 1)?.owner
    if (
      oldLast?.owner.slot !== newLast?.owner.slot ||
      (newTail?.kind === 'trivia' && delta.changed.includes(newTail)) ||
      (oldTail?.kind === 'trivia' && delta.removed.includes(oldTail))
    ) {
      if (oldLast) ids.add(oldLast.owner.slot)
      if (newLast) ids.add(newLast.owner.slot)
    }
    yield* this.#replace(owners, ids, read)
  }
  scope(owners?: SourceOwners) {
    if (owners && owners !== this.#owners)
      throw new Error('Reference scope belongs to a different owner snapshot.')
    const reads = new Map<string, Candidate | undefined>()
    let mixed = false,
      retainedBytes = 0,
      labels: (() => IterableIterator<string>) | undefined
    const resolve = (name: string) => {
      if (!this.#owners) throw new Error('Reference index is disposed.')
      if (!this.#ready) throw new Error('Reference index is not ready.')
      this.#work.scopeReads++
      const current = this.#winners.get(name)
      if (reads.has(name)) mixed ||= reads.get(name) !== current
      else {
        reads.set(ownSourceText(name), current)
        // Conservative cache accounting, not a physical heap measurement.
        retainedBytes +=
          128 +
          2 *
            (name.length +
              (current?.value.href.length ?? 0) +
              (current?.value.title?.length ?? 0))
      }
      return current
    }
    const links = new Proxy(
      Object.create(null) as Record<string, ReferenceValue>,
      {
        get: (_target, name) => {
          // Batch readers share a label index; observing it tracks set changes.
          if (name === Symbol.iterator) {
            mixed ||= !!labels && labels !== this.#labels
            labels = this.#labels
            return labels
          }
          if (typeof name !== 'string') return undefined
          return resolve(name)?.value
        },
        set: () => {
          throw new Error(
            'Reference definitions must be indexed before semantic reads.',
          )
        },
      },
    )
    return Object.freeze({
      links,
      resolve,
      retainedBytes: () => retainedBytes,
      current: () => {
        if (
          !this.#owners ||
          !this.#ready ||
          mixed ||
          (labels && labels !== this.#labels)
        )
          return false
        for (const [name, value] of reads)
          if (this.#winners.get(name) !== value) return false
        return true
      },
    })
  }
  counters(reset = false) {
    const value = {
      ...this.#work,
      owners: this.#definitions.size,
      definitions: this.#count,
      labels: this.#winners.size,
    }
    if (reset)
      this.#work = {
        ownersRead: 0,
        definitionsRead: 0,
        comparisons: 0,
        scopeReads: 0,
      }
    return value
  }
  dispose() {
    if (this.#reading) throw new Error('Reference index is already updating.')
    this.#owners = null
    this.#ready = false
    this.#clear()
  }
}
