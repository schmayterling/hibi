import type { Lexer, Marked, MarkedOptions, Token, TokensList } from 'marked'
import type { MarkdownReferenceSyntax } from './document-worker-protocol.ts'
import { markdownSourceParser } from './markdown-source-references.ts'
import { BlockTokenizer } from './marked-blocks.ts'
import type { SourceSnapshot } from './source-buffer.ts'
import type { SourceOwner, SourceOwners } from './source-owners.ts'
import type { ReferenceValue, SourceReferences } from './source-references.ts'

export type SemanticRegion = Readonly<{
  owner: SourceOwner
  index: number
  endIndex: number
  members: readonly SourceOwner[]
  from: number
  contentFrom: number
  to: number
  leading: readonly SourceOwner[]
  trailing: readonly SourceOwner[]
  first: boolean
  last: boolean
}>

const opaque = (owner: SourceOwner) => owner.kind === 'markdown:Frontmatter'
const hardBoundary = (owner: SourceOwner) =>
  /^markdown:(ATXHeading[1-6]|FencedCode|HorizontalRule)$/.test(owner.kind)

function separated(
  source: SourceSnapshot,
  end: number,
  start: number,
  before: SourceOwner,
  after: SourceOwner,
) {
  const previous = source.lineAt(end)!,
    next = source.lineAt(start)!
  // Some concrete nodes include their final line ending.
  const line = previous.number - Number(end > 0 && previous.from === end)
  return (
    next.number - line > 1 ||
    (next.from >= end && (hardBoundary(before) || hardBoundary(after)))
  )
}

/** Supported non-markup blocks split at blank lines or unambiguous block boundaries. */
export function semanticRegion(
  source: SourceSnapshot,
  owners: SourceOwners,
  slot: number,
): SemanticRegion | null {
  if (owners.invalid() || source.utf16Length !== owners.length)
    throw new Error(
      'Semantic regions require matching, complete source owners.',
    )
  const row = owners.bySlot(slot)
  if (!row || opaque(row.owner)) return null
  if (row.owner.kind === 'trivia') {
    const first = owners.get(0),
      start = first && opaque(first.owner) ? 1 : 0
    if (row.index !== start) return null
    const members: SourceOwner[] = []
    for (const next of owners.records(start)) {
      if (next.owner.kind !== 'trivia') return null
      members.push(next.owner)
    }
    return Object.freeze({
      ...row,
      endIndex: owners.count - 1,
      contentFrom: row.from,
      to: source.utf16Length,
      members: Object.freeze(members),
      leading: Object.freeze([]),
      trailing: Object.freeze([]),
      first: true,
      last: true,
    })
  }
  const leading: SourceOwner[] = [],
    trailing: SourceOwner[] = [],
    members: SourceOwner[] = [row.owner]
  let before = owners.get(row.index - 1),
    after = owners.get(row.index + 1),
    at = row.index - 1,
    end = row
  while (before?.owner.kind === 'trivia') {
    leading.push(before.owner)
    before = owners.get(--at)
  }
  if (
    before &&
    !opaque(before.owner) &&
    !separated(source, before.to, row.from, before.owner, row.owner)
  )
    return null
  at = row.index + 1
  for (;;) {
    while (after?.owner.kind === 'trivia') {
      trailing.push(after.owner)
      after = owners.get(++at)
    }
    if (
      !after ||
      opaque(after.owner) ||
      separated(source, end.to, after.from, end.owner, after.owner)
    )
      break
    members.push(...trailing, after.owner)
    trailing.length = 0
    end = after
    after = owners.get(++at)
  }
  return Object.freeze({
    ...row,
    endIndex: end.index,
    members: Object.freeze(members),
    from: before ? Math.max(before.to, source.lineAt(row.from)!.from) : 0,
    contentFrom: row.from,
    to: after
      ? Math.max(end.to, source.lineAt(after.from)!.from)
      : source.utf16Length,
    leading: Object.freeze(leading),
    trailing: Object.freeze(trailing),
    first: !before,
    last: !after,
  })
}

export function sameSemanticInput(a: SemanticRegion, b: SemanticRegion) {
  return (
    a.owner === b.owner &&
    a.members.length === b.members.length &&
    a.members.every((value, index) => value === b.members[index]) &&
    a.first === b.first &&
    a.last === b.last &&
    a.contentFrom - a.from === b.contentFrom - b.from &&
    a.to - a.contentFrom === b.to - b.contentFrom &&
    a.leading.length === b.leading.length &&
    a.leading.every((value, index) => value === b.leading[index]) &&
    a.trailing.length === b.trailing.length &&
    a.trailing.every((value, index) => value === b.trailing[index])
  )
}

type Scope = ReturnType<SourceReferences['scope']>
type Context = { scope: Scope; owners: SourceOwners; region: SemanticRegion }
export type SemanticTokens = Readonly<{
  region: SemanticRegion
  tokens: readonly Token[]
  scope: Scope
  nonSpace: boolean
}>

/** Built-in lexical semantics only; native schema/HTML conversion remains separate. */
export class MarkdownSemanticLexer {
  readonly #options: MarkedOptions
  readonly #Lexer: new (
    options?: MarkedOptions,
  ) => Lexer
  #context: Context | null = null
  constructor(
    syntax: MarkdownReferenceSyntax,
    parser: Marked = markdownSourceParser(syntax),
  ) {
    const context = () => this.#context!
    this.#options = { ...parser.defaults }
    delete this.#options.tokenizer
    this.#Lexer = class extends parser.Lexer {
      #blockDepth = 0
      override blockTokens(
        source: string,
        tokens?: Token[],
        lastParagraphClipped?: boolean,
      ): Token[]
      override blockTokens(
        source: string,
        tokens?: TokensList,
        lastParagraphClipped?: boolean,
      ): TokensList
      override blockTokens(
        source: string,
        tokens?: Token[],
        lastParagraphClipped?: boolean,
      ) {
        this.#blockDepth++
        try {
          return super.blockTokens(source, tokens, lastParagraphClipped)
        } finally {
          this.#blockDepth--
        }
      }
      override inlineTokens(...args: Parameters<Lexer['inlineTokens']>) {
        if (this.#blockDepth) return super.inlineTokens(...args)
        const previous = this.tokens.links
        this.tokens.links = context().scope.links
        try {
          return super.inlineTokens(...args)
        } finally {
          this.tokens.links = previous
        }
      }
      override lex(source: string) {
        const { scope, owners, region } = context()
        this.tokens.links = new Proxy(
          Object.create(null) as Record<string, ReferenceValue>,
          {
            get: (local, name) => {
              if (typeof name !== 'string') return undefined
              if (Object.hasOwn(local, name)) return local[name]
              const winner = scope.resolve(name)
              return winner &&
                owners.bySlot(winner.owner.slot)!.index < region.index
                ? winner.value
                : undefined
            },
            set: (local, name, value) => {
              if (typeof name !== 'string') return false
              local[name] = value
              return true
            },
          },
        )
        return super.lex(source)
      }
    }
  }
  read(
    source: SourceSnapshot,
    owners: SourceOwners,
    slot: number,
    references: Pick<SourceReferences, 'scope'>,
    previous?: SemanticTokens,
  ): SemanticTokens | null {
    if (this.#context) throw new Error('Semantic lexer is already reading.')
    const region = semanticRegion(source, owners, slot)
    if (!region) return null
    const scope = references.scope(owners)
    if (
      previous &&
      sameSemanticInput(previous.region, region) &&
      previous.scope.current()
    )
      return Object.freeze({ ...previous, region })
    this.#context = { scope, owners, region }
    try {
      const lexer = new this.#Lexer({
        ...this.#options,
        tokenizer: new BlockTokenizer(),
      })
      // Own strings and omit the live links proxy before caching or transport.
      const tokens = structuredClone([
        ...lexer.lex(source.sliceRaw(region.from, region.to)),
      ])
      if (!scope.current())
        throw new Error('Semantic references changed during parsing.')
      return Object.freeze({
        region,
        tokens,
        scope,
        nonSpace: tokens.some((token) => token.type !== 'space'),
      })
    } finally {
      this.#context = null
    }
  }
}

/** Context tokens affect implicit paragraphs but produce no native schema node. */
export function contextualTokens(
  tokens: readonly Token[],
  before: boolean,
  after: boolean,
): Token[] {
  const result = [...tokens]
  if (before) result.unshift({ type: 'hibiSemanticContext', raw: '' })
  if (after) result.push({ type: 'hibiSemanticContext', raw: '' })
  return result
}
