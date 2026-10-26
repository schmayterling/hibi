import { FrontmatterSourceModel } from '../../shared/frontmatter-source-model.ts'
import { MarkdownSemanticCache } from '../../shared/markdown-semantic-cache.ts'
import type { SemanticRegion } from '../../shared/markdown-semantic-tokens.ts'
import {
  MarkdownSourceModel,
  metadataParsers,
} from '../../shared/markdown-worker-parser.ts'
import type { SourceStore } from '../../shared/source-buffer.ts'
import type { SourceOperation } from '../../shared/source-operations.ts'
import type { SourceOwners } from '../../shared/source-owners.ts'
import { SourceReferences } from '../../shared/source-references.ts'
import { blockMathSyntax } from '../math/formatted-syntax.ts'
import { countText } from './count.ts'
import { type CountSyntax, countParser, richTokens } from './formatted-text.ts'

type Count = ReturnType<typeof countText>
type Entry = {
  count: Count
  members: readonly number[]
  current: () => boolean
}

/** Worker-owned counts. Unchanged blocks retain totals, not rich documents or source strings. */
export class FormattedCounter {
  readonly store: SourceStore
  readonly #syntax: CountSyntax
  readonly #model: MarkdownSourceModel
  readonly #cache: MarkdownSemanticCache
  readonly #entries = new Map<number, Entry>()
  readonly #members = new Map<number, Set<number>>()
  readonly #definitions = new Map<number, string>()
  #references: SourceReferences | null = null
  #owners: SourceOwners | null = null
  #epoch: string | null = null
  #referencesDirty = false
  #total: Count = { words: 0, characters: 0 }
  #work = { countedRegions: 0, countedUnits: 0, referenceUnits: 0 }
  constructor(store: SourceStore, syntax: CountSyntax) {
    this.store = store
    this.#syntax = syntax
    const base = metadataParsers[syntax.gfm ? 'gfm' : 'commonmark']
    const parser = syntax.math ? base.configure(blockMathSyntax) : base
    this.#model = syntax.frontmatter
      ? new FrontmatterSourceModel(store.snapshot(), parser, 'word-count')
      : new MarkdownSourceModel(store.snapshot(), parser, 'word-count')
    this.#cache = new MarkdownSemanticCache(
      { ...syntax, alerts: !!syntax.alerts, textExtras: !!syntax.textExtras },
      undefined,
      countParser(syntax),
    )
  }
  apply(operation: SourceOperation) {
    const prepared = this.store.prepare(operation)
    this.store.commit(prepared)
    this.#model.apply(prepared)
  }
  #remove(slot: number) {
    const entry = this.#entries.get(slot)
    if (!entry) return
    this.#entries.delete(slot)
    this.#total.words -= entry.count.words
    this.#total.characters -= entry.count.characters
    for (const member of entry.members) {
      const readers = this.#members.get(member)
      readers?.delete(slot)
      if (!readers?.size) this.#members.delete(member)
    }
  }
  #add(slot: number, entry: Entry) {
    this.#entries.set(slot, entry)
    this.#total.words += entry.count.words
    this.#total.characters += entry.count.characters
    for (const member of entry.members) {
      let readers = this.#members.get(member)
      if (!readers) {
        readers = new Set()
        this.#members.set(member, readers)
      }
      readers.add(slot)
    }
  }
  *read(): Generator<void, Count> {
    while (!this.#model.state().complete) {
      this.#model.advance()
      yield
    }
    const { source, owners } = this.#model.state()
    if (!owners) return { words: 0, characters: 0 }
    if (this.#epoch !== owners.epoch) {
      this.#references?.dispose()
      this.#references = null
      this.#cache.clear()
      this.#entries.clear()
      this.#members.clear()
      this.#definitions.clear()
      this.#owners = null
      this.#referencesDirty = false
      this.#total = { words: 0, characters: 0 }
      this.#epoch = owners.epoch
    }
    const previous = this.#owners
    const delta = previous ? owners.changesSince(previous) : null
    const dirty = new Set<number>()
    const around = (slot: number) => {
      const row = owners.bySlot(slot)
      if (!row) return
      dirty.add(slot)
      for (const direction of [-1, 1]) {
        let at = row.index + direction
        for (let next = owners.get(at); next; next = owners.get(at)) {
          dirty.add(next.owner.slot)
          for (const reader of this.#members.get(next.owner.slot) ?? [])
            dirty.add(reader)
          if (next.owner.kind !== 'trivia') break
          at += direction
        }
      }
    }
    if (delta) {
      for (const owner of [...delta.changed, ...delta.removed]) {
        dirty.add(owner.slot)
        for (const reader of this.#members.get(owner.slot) ?? [])
          dirty.add(reader)
        around(owner.slot)
      }
    }
    let referencesChanged = false
    const definitions = new Map<number, string>()
    for (const owner of delta?.removed ?? []) {
      if (this.#definitions.get(owner.slot)) referencesChanged = true
      definitions.set(owner.slot, '')
    }
    this.#references ??= new SourceReferences(owners)
    const parser = countParser(this.#syntax)
    yield* this.#references.updateWork(owners, (region) => {
      if (region.owner.kind === 'markdown:Frontmatter') return {}
      this.#work.referenceUnits += region.to - region.from
      const links = new parser.Lexer({
        ...parser.defaults,
        tokenizer: null,
      }).lex(source.sliceRaw(region.from, region.to)).links
      const key = Object.keys(links).length ? JSON.stringify(links) : ''
      if ((this.#definitions.get(region.owner.slot) ?? '') !== key)
        referencesChanged = true
      definitions.set(region.owner.slot, key)
      return links
    })
    for (const [slot, key] of definitions) {
      if (key) this.#definitions.set(slot, key)
      else this.#definitions.delete(slot)
    }
    this.#referencesDirty ||= referencesChanged
    if (this.#referencesDirty)
      for (const [slot, entry] of this.#entries)
        if (!entry.current()) dirty.add(slot)
    const slots = delta
      ? dirty
      : (function* () {
          for (const row of owners.records()) yield row.owner.slot
        })()
    const staged = new Map<number, Entry>()
    for (const slot of slots) {
      const value = this.#cache.read(source, owners, slot, this.#references)
      if (value) {
        const { region } = value
        // Frontmatter is opaque metadata, not a block preceding the body.
        const firstBody =
          owners.get(0)?.owner.kind === 'markdown:Frontmatter' ? 1 : 0
        const text = richTokens(value.tokens, this.#syntax, {
          before: region.index > firstBody + region.leading.length,
          after: !region.last,
        })
        this.#work.countedRegions++
        this.#work.countedUnits += region.to - region.from
        staged.set(slot, {
          count: countText(text),
          members: members(region),
          current: value.scope.current,
        })
      }
      yield
    }
    // Commit only completed generations. A cancelled read keeps previous displayed totals.
    for (const slot of dirty) this.#remove(slot)
    for (const [slot, entry] of staged) {
      this.#remove(slot)
      this.#add(slot, entry)
    }
    this.#owners = owners
    this.#referencesDirty = false
    return {
      words: this.#total.words,
      characters: Math.max(0, this.#total.characters - 1),
    }
  }
  counters(reset = false) {
    const result = {
      ...this.#work,
      source: this.store.counters(reset),
      parser: this.#model.counters(reset),
      cache: this.#cache.counters(reset),
    }
    if (reset)
      this.#work = { countedRegions: 0, countedUnits: 0, referenceUnits: 0 }
    return result
  }
  dispose() {
    this.#references?.dispose()
    this.#cache.clear()
    this.#model.dispose()
    this.#entries.clear()
    this.#members.clear()
  }
}
function members(region: SemanticRegion) {
  return [
    ...new Set(
      [...region.members, ...region.leading, ...region.trailing].map(
        (owner) => owner.slot,
      ),
    ),
  ]
}
