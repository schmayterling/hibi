import { Marked } from 'marked'
import { alertMarkdown } from '../addons/markdown/alerts.ts'
import { mathTokens } from '../addons/math/syntax.ts'
import { textExtrasMarkdown } from '../addons/text-extras/syntax.ts'
import type { MarkdownReferenceSyntax } from './document-worker-protocol.ts'
import type { SourceSnapshot } from './source-buffer.ts'
import type { SourceOwners } from './source-owners.ts'
import {
  type ReferenceDefinitions,
  type ReferenceRegion,
  SourceReferences,
} from './source-references.ts'

export function markdownSourceParser(syntax: MarkdownReferenceSyntax) {
  const parser = new Marked({ gfm: syntax.gfm, breaks: false })
  if (syntax.alerts) parser.use(alertMarkdown)
  if (syntax.textExtras) parser.use(textExtrasMarkdown)
  if (syntax.math) parser.use(mathTokens)
  return parser
}

/** Built-in Markdown definition semantics, loaded only on reference demand. */
export class MarkdownSourceReferences {
  readonly #parser: Marked
  readonly #math: boolean
  #index: SourceReferences | null = null
  #owners: SourceOwners | null = null
  #epoch: string | null = null
  readonly #markup = new Set<number>()
  #fallback: ReferenceDefinitions | null = null
  #fallbackWork = { fullParses: 0, sourceUnits: 0 }
  #semanticLifetime = {}
  constructor(syntax: MarkdownReferenceSyntax) {
    this.#parser = markdownSourceParser(syntax)
    this.#math = syntax.math ?? false
  }
  *update(source: SourceSnapshot, owners: SourceOwners): Generator<void> {
    if (owners === this.#owners) return
    if (!this.#index || this.#epoch !== owners.epoch) {
      this.#index?.dispose()
      this.#index = new SourceReferences(owners)
      this.#epoch = owners.epoch
      this.#owners = null
      this.#markup.clear()
      this.#fallback = null
    }
    const markup = new Map<number, boolean>()
    if (this.#owners) {
      const delta = owners.changesSince(this.#owners)
      for (const owner of [...delta.changed, ...delta.removed])
        markup.set(owner.slot, false)
    }
    const lex = (text: string) =>
      new this.#parser.Lexer({
        ...this.#parser.defaults,
        tokenizer: null,
      }).lex(text)
    const read = (region: ReferenceRegion) => {
      if (region.owner.kind === 'markdown:Frontmatter') return {}
      const text = source.sliceRaw(region.from, region.to)
      markup.set(
        region.owner.slot,
        text.includes('<') ||
          (this.#math && text.includes('$$')) ||
          /(?:^|[\r\n])[\t ]*["'(]|\[[^\r\n]*\]:[^\r\n]*["'(]/.test(text) ||
          region.from > source.lineAt(region.contentFrom)!.from ||
          region.to < source.lineAt(region.to)!.to,
      )
      return lex(text).links
    }
    try {
      yield* this.#index.updateWork(owners, read)
      let count = this.#markup.size
      for (const [slot, present] of markup)
        count += Number(present) - Number(this.#markup.has(slot))
      let fallback: ReferenceDefinitions | null = null
      if (count) {
        // Lezer and Marked disagree on HTML/container and multiline-title boundaries.
        // Navigation uses a full lexical read on demand for ambiguous syntax.
        const first = owners.get(0),
          from = first?.owner.kind === 'markdown:Frontmatter' ? first.to : 0
        const text = source.sliceRaw(from, source.utf16Length)
        this.#fallbackWork.fullParses++
        this.#fallbackWork.sourceUnits += text.length
        fallback = structuredClone(lex(text).links)
      }
      for (const [slot, present] of markup) {
        if (present) this.#markup.add(slot)
        else this.#markup.delete(slot)
      }
      this.#fallback = fallback
      if (fallback) this.#semanticLifetime = {}
      this.#owners = owners
    } catch (error) {
      this.dispose()
      throw error
    }
  }
  lookup(label: string) {
    if (this.#fallback)
      return Object.hasOwn(this.#fallback, label)
        ? this.#fallback[label]!
        : null
    return this.#index?.scope().resolve(label)?.value ?? null
  }
  semanticsAvailable() {
    return this.#owners !== null && this.#fallback === null
  }
  scope(owners?: SourceOwners) {
    if (!this.#index) throw new Error('Reference index is not ready.')
    if (this.#fallback)
      throw new Error(
        'Regional reference provenance is unavailable for this syntax.',
      )
    const scope = this.#index.scope(owners),
      lifetime = this.#semanticLifetime
    return Object.freeze({
      ...scope,
      current: () => lifetime === this.#semanticLifetime && scope.current(),
    })
  }
  counters(reset = false) {
    const value = {
      ...this.#index?.counters(reset),
      ...this.#fallbackWork,
      markupOwners: this.#markup.size,
    }
    if (reset) this.#fallbackWork = { fullParses: 0, sourceUnits: 0 }
    return value
  }
  dispose() {
    this.#index?.dispose()
    this.#index = null
    this.#owners = null
    this.#epoch = null
    this.#markup.clear()
    this.#fallback = null
    this.#semanticLifetime = {}
  }
}
