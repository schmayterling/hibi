import { FrontmatterSourceModel } from '../../shared/frontmatter-source-model.ts'
import { MarkdownSemanticCache } from '../../shared/markdown-semantic-cache.ts'
import type { SemanticRegion } from '../../shared/markdown-semantic-tokens.ts'
import {
  MarkdownSourceModel,
  metadataParsers,
} from '../../shared/markdown-worker-parser.ts'
import { BlockTokenizer } from '../../shared/marked-blocks.ts'
import type { SourceStore } from '../../shared/source-buffer.ts'
import type { SourceOperation } from '../../shared/source-operations.ts'
import { type SourceOwner, SourceOwners } from '../../shared/source-owners.ts'
import { SourceReferences } from '../../shared/source-references.ts'
import { blockMathSyntax } from '../math/formatted-syntax.ts'
import { countText } from './count.ts'
import { CountBrackets } from './count-brackets.ts'
import { countMarkdownSyntax } from './formatted-count-syntax.ts'
import {
  type CountSyntax,
  countParser,
  richText,
  richTokens,
} from './formatted-text.ts'
import { localCount, plainParagraph, plainSource } from './local-count.ts'

type Count = ReturnType<typeof countText>
type Entry = {
  count: Count
  carriage: boolean
  members: readonly number[]
  current: () => boolean
  plain: ReturnType<typeof plainParagraph>
}

/** Worker-owned counts. Unchanged blocks retain totals, not rich documents or source strings. */
export class FormattedCounter {
  readonly store: SourceStore
  readonly #syntax: CountSyntax
  readonly #brackets: CountBrackets
  readonly #model: MarkdownSourceModel
  readonly #cache: MarkdownSemanticCache
  readonly #entries = new Map<number, Entry>()
  readonly #members = new Map<number, Set<number>>()
  readonly #definitions = new Map<number, string>()
  readonly #literal = new Map<number, { owner: SourceOwner; count: Count }>()
  #references: SourceReferences | null = null
  #owners: SourceOwners | null = null
  #epoch: string | null = null
  #referencesDirty = false
  #plainOwners: SourceOwners | null = null
  readonly #plainCounts = new Map<Entry, Count>()
  #total: Count = { words: 0, characters: 0 }
  #visible: SourceOwners | null = null
  #carriages = 0
  #work = { countedRegions: 0, countedUnits: 0, referenceUnits: 0 }
  constructor(store: SourceStore, syntax: CountSyntax) {
    this.store = store
    this.#syntax = syntax
    this.#brackets = new CountBrackets(store.snapshot())
    const base = metadataParsers[syntax.gfm ? 'gfm' : 'commonmark'].configure(
      countMarkdownSyntax(
        syntax,
        (from) => this.#brackets.canClose(from),
        (from, end, title, complete) =>
          this.#brackets.canTitle(from, end, title, complete),
      ),
    )
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
    const [change] = operation.changes
    let row =
      this.#plainOwners && operation.changes.length === 1 && change
        ? this.#plainOwners.at(change.from)
        : null
    if (
      this.#plainOwners &&
      row &&
      change &&
      change.from === change.to &&
      row.from === change.from &&
      !this.#entries.get(row.owner.slot)?.plain
    )
      row = this.#plainOwners.at(change.from, -1)
    const entry = row && this.#entries.get(row.owner.slot)
    const delta =
      entry?.plain && row && change
        ? localCount(
            prepared.before,
            change.from,
            change.to,
            change.insert,
            row.from,
            entry.plain,
          )
        : null
    const openers = this.#brackets.apply(prepared)
    this.store.commit(prepared)
    this.#model.apply(prepared)
    let invalidated = false
    for (const from of openers)
      if (
        ['markdown:Paragraph', 'markdown:CountDefinition'].includes(
          this.#model.state().owners?.at(from)?.owner.kind ?? '',
        )
      ) {
        this.#model.invalidate(from, from + 1)
        invalidated = true
      }
    if (delta && row && entry && this.#plainOwners && !invalidated) {
      // retain proven paragraphs while the parser keeps boundary edits pending.
      this.#plainOwners = this.#plainOwners.update(row.index, {
        ...row.owner,
        length:
          typeof delta.spans === 'number' ? delta.spans : delta.spans.length,
      })
      entry.plain = delta.spans
      const previous = this.#plainCounts.get(entry) ?? entry.count
      this.#plainCounts.set(entry, {
        words: previous.words + delta.words,
        characters: previous.characters + delta.characters,
      })
      this.#work.countedRegions++
      this.#work.countedUnits += delta.units
    } else {
      this.#plainOwners = null
      this.#plainCounts.clear()
    }
  }
  #remove(slot: number) {
    const entry = this.#entries.get(slot)
    if (!entry) return
    this.#entries.delete(slot)
    this.#total.words -= entry.count.words
    this.#total.characters -= entry.count.characters
    this.#carriages -= Number(entry.carriage)
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
    this.#carriages += Number(entry.carriage)
    for (const member of entry.members) {
      let readers = this.#members.get(member)
      if (!readers) {
        readers = new Set()
        this.#members.set(member, readers)
      }
      readers.add(slot)
    }
  }
  #result(): Count {
    // Every nonempty region starts with a block separator. A trailing carriage
    // return joins the next separator into one grapheme, except at document end.
    const visible = this.#visible
    let from = 0,
      to = visible?.count ?? 0
    while (visible && from < to) {
      const middle = Math.floor((from + to) / 2)
      if (visible.invalid(middle, visible.count)) from = middle + 1
      else to = middle
    }
    const terminalCarriage =
      from > 0 && visible?.get(from - 1)?.owner.kind === 'carriage'
    return {
      words: this.#total.words,
      characters: Math.max(
        0,
        this.#total.characters - 1 - this.#carriages + Number(terminalCarriage),
      ),
    }
  }
  *read(): Generator<void, Count> {
    if (this.#plainOwners) {
      for (const [entry, count] of this.#plainCounts) {
        this.#total.words += count.words - entry.count.words
        this.#total.characters += count.characters - entry.count.characters
        entry.count = count
      }
      this.#plainCounts.clear()
      return this.#result()
    }
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
      this.#literal.clear()
      this.#owners = null
      this.#referencesDirty = false
      this.#total = { words: 0, characters: 0 }
      this.#visible = null
      this.#carriages = 0
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
      this.#literal.delete(owner.slot)
    }
    this.#references ??= new SourceReferences(owners)
    const parser = countParser(this.#syntax)
    yield* this.#references.updateWork(owners, (region) => {
      if (region.owner.kind === 'markdown:Frontmatter') return {}
      const { owner, contentFrom } = region
      if (owner.kind === 'markdown:Paragraph') {
        const cached = this.#literal.get(owner.slot)
        const count =
          cached?.owner === owner
            ? cached.count
            : plainSource(source, contentFrom, contentFrom + owner.length)
        if (count) {
          if (cached?.owner !== owner) this.#work.countedUnits += owner.length
          this.#literal.set(owner.slot, { owner, count })
          if (this.#definitions.has(owner.slot)) referencesChanged = true
          definitions.set(owner.slot, '')
          return {}
        }
      }
      this.#literal.delete(owner.slot)
      this.#work.referenceUnits += region.to - region.from
      const links = new parser.Lexer({
        ...parser.defaults,
        tokenizer: new BlockTokenizer(),
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
      const literal = this.#literal.get(slot)
      const region = literal && this.#cache.region(source, owners, slot)
      if (
        literal &&
        region?.members.length === 1 &&
        literal.owner === region.owner
      ) {
        const firstBody =
          owners.get(0)?.owner.kind === 'markdown:Frontmatter' ? 1 : 0
        const around =
          source.sliceRaw(region.from, region.contentFrom) +
          'x' +
          source.sliceRaw(region.contentFrom + region.owner.length, region.to)
        const count = countText(
          richText(around, this.#syntax, {
            before: region.index > firstBody + region.leading.length,
            after: !region.last,
          }),
        )
        this.#work.countedRegions++
        this.#work.countedUnits += around.length
        staged.set(slot, {
          count: {
            words: literal.count.words,
            characters: literal.count.characters + count.characters - 1,
          },
          carriage: false,
          members: members(region),
          current: () => true,
          plain: literal.owner.length,
        })
        yield
        continue
      }
      const value = this.#cache.read(source, owners, slot, this.#references)
      if (value) {
        const { region } = value
        // Frontmatter is opaque metadata, not a block preceding the body.
        const firstBody =
          owners.get(0)?.owner.kind === 'markdown:Frontmatter' ? 1 : 0
        const text = richTokens(value.tokens, this.#syntax, {
          references: value.scope.links,
          before: region.index > firstBody + region.leading.length,
          after: !region.last,
        })
        this.#work.countedRegions++
        this.#work.countedUnits += region.to - region.from
        staged.set(slot, {
          count: countText(text),
          carriage: text.endsWith('\r'),
          members: members(region),
          current: value.scope.current,
          plain: plainParagraph(value.tokens, region),
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
    const summary = (slot: number) => {
      const entry = this.#entries.get(slot)
      return {
        kind: entry?.carriage ? 'carriage' : 'text',
        length: 1,
        parsed: !entry?.count.characters,
      }
    }
    if (!this.#visible || !previous || !delta)
      this.#visible = new SourceOwners(
        [...owners.records()].map(({ owner }) => summary(owner.slot)),
      )
    else {
      const removed = delta.removed
        .flatMap((owner) => previous.bySlot(owner.slot)?.index ?? [])
        .sort((a, b) => b - a)
      for (const index of removed)
        this.#visible = this.#visible.splice(index, index + 1, [])
      const changed = delta.changed
        .flatMap((owner) => owners.bySlot(owner.slot) ?? [])
        .sort((a, b) => a.index - b.index)
      for (const { owner, index } of changed)
        if (!previous.bySlot(owner.slot))
          this.#visible = this.#visible.splice(index, index, [
            summary(owner.slot),
          ])
      for (const slot of dirty) {
        const row = owners.bySlot(slot)
        if (!row) continue
        const value = summary(slot)
        const current = this.#visible.get(row.index)?.owner
        if (current?.kind !== value.kind || current.parsed !== value.parsed)
          this.#visible = this.#visible.update(row.index, value)
      }
    }
    this.#owners = owners
    this.#referencesDirty = false
    this.#plainOwners = owners
    return this.#result()
  }
  counters(reset = false) {
    const result = {
      ...this.#work,
      source: this.store.counters(reset),
      brackets: this.#brackets.counters(reset),
      parser: this.#model.counters(reset),
      cache: this.#cache.counters(reset),
      visible: this.#visible?.counters(reset),
    }
    if (reset)
      this.#work = { countedRegions: 0, countedUnits: 0, referenceUnits: 0 }
    return result
  }
  dispose() {
    this.#references?.dispose()
    this.#cache.clear()
    this.#model.dispose()
    this.#brackets.dispose()
    this.#entries.clear()
    this.#members.clear()
    this.#plainCounts.clear()
    this.#plainOwners = null
    this.#visible = null
    this.#literal.clear()
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
