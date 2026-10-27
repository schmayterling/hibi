import type { MarkdownManager } from '@tiptap/markdown'
import type { Node } from '@tiptap/pm/model'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import { ReplaceStep } from '@tiptap/pm/transform'
import { blockMarkdown } from '../../shared/marked-blocks.ts'
import { type SourceOwner, SourceOwners } from '../../shared/source-owners.ts'
import { preserveRichSource } from './rich-source-preservation.ts'
import { normalizeSource, sourceText } from './source-text.ts'

const maximumParagraphUnits = 16 * 1024

type Region = Readonly<{
  raw: string
  node?: Node
  serialized?: string
  envelope?: string
  indent?: string
}>
function paragraphRegion(raw: string, node: Node, manager: MarkdownManager) {
  const core = raw.replace(/(?:\r\n|\r|\n)+$/, '')
  const envelope = raw.slice(core.length)
  if (
    node.type.name !== 'paragraph' ||
    !core ||
    core.length > maximumParagraphUnits ||
    /[\r\n[<]|\$\$/.test(core)
  )
    return null
  return {
    raw,
    node,
    serialized: manager.serialize({
      type: node.type.schema.topNodeType.name,
      content: [node.toJSON()],
    }),
    envelope,
    indent: /^[ \t]*/.exec(core)?.[0] ?? '',
  }
}

/** A full-document parse already proved `document` matches `source`.
 * Region parsing proves that this grammar has no hidden cross-region nodes. */
export function createRichParagraphProof(
  source: string,
  document: Node,
  manager: MarkdownManager,
) {
  try {
    const original = sourceText(source)
    const lexer = () => {
      const tokenizer = Object.assign(
        new manager.instance.Tokenizer(),
        blockMarkdown.tokenizer,
      )
      return new manager.instance.Lexer({
        ...manager.instance.defaults,
        tokenizer,
      })
    }
    const tokens = lexer().lex(original.text)
    const regions: Region[] = []
    const blockRegions: number[] = []
    let cursor = 0
    let block = 0
    for (const token of tokens) {
      if (!token.raw || token.type === 'def') return null
      const end = cursor + token.raw.length
      const contentEnd = end - (/\n*$/.exec(token.raw)?.[0].length ?? 0)
      const isolated =
        (cursor === 0 || original.text.slice(cursor - 2, cursor) === '\n\n') &&
        (end === original.text.length ||
          original.text.slice(contentEnd, contentEnd + 2) === '\n\n')
      if (original.text.slice(cursor, end) !== token.raw) return null
      const raw = source.slice(
        original.toSource(cursor),
        original.toSource(end),
      )
      cursor = end
      const parsed =
        token.type === 'space'
          ? []
          : (manager.parse(normalizeSource(raw).replace(/\n+$/, '')).content ??
            [])
      if (block + parsed.length > document.childCount) return null
      for (const json of parsed) {
        if (!document.child(block).eq(document.type.schema.nodeFromJSON(json)))
          return null
        blockRegions.push(regions.length)
        block++
      }
      const node = parsed.length === 1 ? document.child(block - 1) : undefined
      regions.push(
        token.type === 'paragraph' && node && isolated
          ? (paragraphRegion(raw, node, manager) ?? { raw })
          : { raw },
      )
    }
    if (
      !regions.length ||
      cursor !== original.text.length ||
      block !== document.childCount
    )
      return null
    const owners = new SourceOwners(
      regions.map((region) => ({ kind: 'rich', length: region.raw.length })),
    )
    const payloads = new WeakMap<SourceOwner, Region>()
    for (const row of owners.records()) {
      const region = regions[row.index]
      if (!region) return null
      payloads.set(row.owner, region)
    }
    return new RichParagraphProof(
      source,
      document,
      manager,
      owners,
      payloads,
      blockRegions,
    )
  } catch {
    return null
  }
}

export class RichParagraphProof {
  readonly #source: string
  readonly #document: Node
  readonly #manager: MarkdownManager
  readonly #owners: SourceOwners
  readonly #payloads: WeakMap<SourceOwner, Region>
  readonly #blockRegions: readonly number[]

  constructor(
    source: string,
    document: Node,
    manager: MarkdownManager,
    owners: SourceOwners,
    payloads: WeakMap<SourceOwner, Region>,
    blockRegions: readonly number[],
  ) {
    this.#source = source
    this.#document = document
    this.#manager = manager
    this.#owners = owners
    this.#payloads = payloads
    this.#blockRegions = blockRegions
  }

  matches(source: string, document: Node) {
    return source === this.#source && document === this.#document
  }

  plan(
    state: EditorState,
    transaction: Transaction,
    nextDoc: Node,
    parse?: (source: string) => Node | null,
  ) {
    if (
      !this.matches(this.#source, state.doc) ||
      transaction.before !== state.doc ||
      transaction.doc !== nextDoc ||
      transaction.steps.length !== 1 ||
      nextDoc.childCount !== state.doc.childCount
    )
      return null
    const step = transaction.steps[0]
    if (
      !(step instanceof ReplaceStep) ||
      step.slice.openStart ||
      step.slice.openEnd ||
      step.slice.content.content.some((node) => !node.isInline) ||
      step.toJSON().structure
    )
      return null
    const start = state.doc.resolve(step.from)
    const end = state.doc.resolve(step.to)
    if (
      start.depth !== 1 ||
      end.depth !== 1 ||
      !start.sameParent(end) ||
      !start.parent.isTextblock ||
      start.parent.type.name !== 'paragraph'
    )
      return null
    const index = start.index(0)
    const regionIndex = this.#blockRegions[index]
    if (regionIndex === undefined) return null
    const row = this.#owners.get(regionIndex)
    const region = row && this.#payloads.get(row.owner)
    if (
      !row ||
      !region?.serialized ||
      region.envelope === undefined ||
      region.indent === undefined ||
      region.node !== start.parent
    )
      return null
    const { envelope, indent } = region
    const next = nextDoc.child(index)
    if (next.type.name !== 'paragraph') return null
    const after = this.#manager.serialize({
      type: nextDoc.type.name,
      content: [next.toJSON()],
    })
    const parseCandidate =
      parse ??
      ((source: string) =>
        nextDoc.type.schema.nodeFromJSON(this.#manager.parse(source)))
    const raw = preserveRichSource(
      region.raw,
      region.serialized,
      after,
      (candidate) => {
        const core = candidate.slice(0, candidate.length - envelope.length)
        if (
          !candidate.endsWith(envelope) ||
          !core ||
          core.length > maximumParagraphUnits ||
          /[\r\n[<]|\$\$/.test(core) ||
          (/^[ \t]*/.exec(core)?.[0] ?? '') !== indent
        )
          return false
        const normalized = normalizeSource(candidate)
        const tokens = new this.#manager.instance.Lexer({
          ...this.#manager.instance.defaults,
          tokenizer: null,
        }).lex(normalized)
        return (
          tokens.length === 1 &&
          tokens[0]?.type === 'paragraph' &&
          tokens[0]?.raw === normalized &&
          (() => {
            const parsed = parseCandidate(normalized)
            return (
              parsed?.childCount === 1 && parsed.firstChild?.eq(next) === true
            )
          })()
        )
      },
    )
    if (raw === null) return null
    const source =
      this.#source.slice(0, row.from) + raw + this.#source.slice(row.to)
    const replacement: Region = {
      raw,
      node: next,
      serialized: after,
      envelope,
      indent,
    }
    const owners = this.#owners.update(regionIndex, {
      kind: 'rich',
      length: raw.length,
    })
    const updatedRow = owners.get(regionIndex)
    if (!updatedRow) return null
    this.#payloads.set(updatedRow.owner, replacement)
    return {
      source,
      proof: new RichParagraphProof(
        source,
        nextDoc,
        this.#manager,
        owners,
        this.#payloads,
        this.#blockRegions,
      ),
    }
  }
}
