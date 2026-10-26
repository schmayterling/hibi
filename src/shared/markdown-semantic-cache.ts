import type { Marked } from 'marked'
import type { MarkdownReferenceSyntax } from './document-worker-protocol.ts'
import {
  MarkdownSemanticLexer,
  type SemanticTokens,
  semanticRegion,
} from './markdown-semantic-tokens.ts'
import type { SourceSnapshot } from './source-buffer.ts'
import type { SourceOwners } from './source-owners.ts'
import type { SourceReferences } from './source-references.ts'

/** Conservative retained payload accounting; runtime heap overhead is measured separately. */
function retainedBytes(value: SemanticTokens) {
  let bytes =
    256 +
    96 *
      (value.region.members.length +
        value.region.leading.length +
        value.region.trailing.length) +
    value.scope.retainedBytes()
  const pending: unknown[] = [value.tokens]
  while (pending.length) {
    const item = pending.pop()
    if (typeof item === 'string') bytes += 32 + item.length * 2
    else if (item && typeof item === 'object') {
      Object.freeze(item)
      bytes += 64
      for (const [key, child] of Object.entries(item)) {
        bytes += 32 + key.length * 2
        pending.push(child)
      }
    } else bytes += 8
  }
  return bytes
}

/** One grammar's bounded lexical payloads. Holds no source snapshot or owner-tree root. */
export class MarkdownSemanticCache {
  readonly #lexer: MarkdownSemanticLexer
  readonly #entries = new Map<
    number,
    { value: SemanticTokens; bytes: number }
  >()
  readonly #maximumEntries: number
  readonly #maximumBytes: number
  #epoch: string | null = null
  #bytes = 0
  #work = { hits: 0, reads: 0, evictions: 0, oversized: 0 }
  constructor(
    syntax: MarkdownReferenceSyntax,
    limits = { maximumEntries: 128, maximumBytes: 8 * 1024 * 1024 },
    parser?: Marked,
  ) {
    if (
      !Number.isSafeInteger(limits.maximumEntries) ||
      limits.maximumEntries < 1 ||
      !Number.isSafeInteger(limits.maximumBytes) ||
      limits.maximumBytes < 1
    )
      throw new Error('Invalid semantic cache limits.')
    this.#lexer = new MarkdownSemanticLexer(syntax, parser)
    this.#maximumEntries = limits.maximumEntries
    this.#maximumBytes = limits.maximumBytes
  }
  #remove(slot: number) {
    const entry = this.#entries.get(slot)
    if (!entry) return
    this.#entries.delete(slot)
    this.#bytes -= entry.bytes
  }
  region(source: SourceSnapshot, owners: SourceOwners, slot: number) {
    return semanticRegion(source, owners, slot)
  }
  read(
    source: SourceSnapshot,
    owners: SourceOwners,
    slot: number,
    references: Pick<SourceReferences, 'scope'>,
  ) {
    if (this.#epoch !== owners.epoch) {
      this.clear()
      this.#epoch = owners.epoch
    }
    const previous = this.#entries.get(slot),
      value = this.#lexer.read(
        source,
        owners,
        slot,
        references,
        previous?.value,
      )
    this.#remove(slot)
    if (!value) return null
    const hit = previous?.value.tokens === value.tokens
    if (hit) this.#work.hits++
    else this.#work.reads++
    const bytes = hit ? previous!.bytes : retainedBytes(value)
    if (bytes > this.#maximumBytes) {
      this.#work.oversized++
      return value
    }
    while (
      this.#entries.size >= this.#maximumEntries ||
      this.#bytes + bytes > this.#maximumBytes
    ) {
      this.#remove(this.#entries.keys().next().value!)
      this.#work.evictions++
    }
    this.#entries.set(slot, { value, bytes })
    this.#bytes += bytes
    return value
  }
  clear() {
    this.#entries.clear()
    this.#bytes = 0
    this.#epoch = null
  }
  counters(reset = false) {
    const value = {
      ...this.#work,
      entries: this.#entries.size,
      bytes: this.#bytes,
    }
    if (reset) this.#work = { hits: 0, reads: 0, evictions: 0, oversized: 0 }
    return value
  }
}
