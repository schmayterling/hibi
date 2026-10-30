import { ChangeSet } from '@codemirror/state'
import { NodeWeakMap, type SyntaxNode, type Tree } from '@lezer/common'
import {
  GFM,
  type MarkdownConfig,
  type MarkdownParser,
  parser,
} from '@lezer/markdown'
import { decodeHTML } from 'entities'
import type { Token } from 'marked'
import type { MarkdownExtension, MarkdownFlavor } from '../../addons/api'
import { blockMathSyntax } from '../../addons/math/formatted-syntax.ts'
import {
  builtInFlavors,
  fencedCodeFlavors,
} from '../../shared/built-in-grammar.ts'
import { trackReadAhead } from '../../shared/chunked-markdown.ts'
import { FrontmatterParser } from '../../shared/frontmatter-parser.ts'
import { protectMarkdownParser } from '../../shared/markdown-flavor-guard.ts'
import { markdownSourceParser } from '../../shared/markdown-source-references.ts'
import type {
  PreparedSourceOperation,
  SourceSnapshot,
  SourceStorageChange,
} from '../../shared/source-buffer.ts'
import {
  type FrontmatterRead,
  readSourceFrontmatter,
  reuseFrontmatterRead,
} from '../../shared/source-frontmatter.ts'
import { SourceOwners } from '../../shared/source-owners.ts'
import { SourceParserSession } from '../../shared/source-parser.ts'
import { normalizedSource } from '../../shared/source-projection.ts'
import type { ReferenceValue } from '../../shared/source-references.ts'
import { type OutlineLabelPart, outlineLabel } from './outline-label.ts'

export type SourceOutlineHeading = Readonly<{
  id: string
  label: string
  parts?: readonly OutlineLabelPart[]
  level: number
}>
export type SourceOutline = Readonly<{
  headings: readonly SourceOutlineHeading[]
  position: (index: number) => number
  at: (position: number) => SourceOutlineHeading | undefined
}>
export type SourceOutlineReference = Readonly<{ reference: string }>
export type SourceOutlineLabelRequest = {
  text: string
  level: number
  references: ReadonlyMap<string, ReferenceValue | null>
}
export type SourceOutlineLabelResult = {
  label: string | null
  parts?: readonly OutlineLabelPart[]
  references: string[]
  missing: string[]
}
export type SourceOutlineInput =
  | ReferenceValue
  | SourceOutlineLabelResult
  | null
  | undefined

type LabelRenderer = (
  tokens: readonly Token[],
  level: number,
) => string | readonly OutlineLabelPart[] | null

type Owned = { addonId?: string }
type LegacyExtension = {
  config?: { markdownTokenizer?: { level?: string } }
  parent?: LegacyExtension | null
}

/** Marked or Tiptap tokenizers that can start blocks only the visual editor reads. */
function legacyBlocks(flavor: MarkdownFlavor) {
  return (
    !!flavor.export?.extensions?.some(
      (extension) =>
        extension.tokenizer ||
        extension.hooks ||
        extension.extensions?.some(
          (entry) => 'level' in entry && entry.level !== 'inline',
        ),
    ) ||
    !!flavor.richExtensions?.some((extension) => {
      let entry = extension as LegacyExtension | null | undefined
      while (entry && !entry.config?.markdownTokenizer) entry = entry.parent
      const level = entry?.config?.markdownTokenizer?.level
      return level !== undefined && level !== 'inline'
    })
  )
}

/**
 * The outline grammar for the selected flavors and projections. Built-in
 * flavors the model was audited for set its options; other flavors' Lezer
 * syntax extends its parser, as in the source view. Inline syntax changes only
 * labels, which keep their Markdown text. `blocked` lists the addons whose
 * block structure the outline cannot follow: projections other than built-in
 * frontmatter and, with `legacy`, block syntax only the visual editor reads.
 */
export function sourceOutlineGrammar(
  flavors: readonly (MarkdownFlavor & Owned)[],
  projections: readonly (MarkdownExtension & Owned)[],
  { origin, legacy }: { origin: (addonId: string) => string; legacy: boolean },
) {
  const owned = (owner: string | undefined, addonId: string | undefined) =>
    owner !== undefined && owner === addonId && origin(owner) === 'built-in'
  const modeled = flavors.filter((flavor) =>
      owned(builtInFlavors.get(flavor.id)?.owner, flavor.addonId),
    ),
    ids = modeled.map((flavor) => flavor.id),
    blocked = new Set<string>()
  for (const flavor of flavors)
    if (
      legacy &&
      !modeled.includes(flavor) &&
      !flavor.syntax &&
      !owned(fencedCodeFlavors.get(flavor.id), flavor.addonId) &&
      legacyBlocks(flavor)
    )
      blocked.add(flavor.addonId ?? flavor.id)
  for (const projection of projections)
    if (
      projection.id !== 'frontmatter.metadata' ||
      !owned('frontmatter', projection.addonId)
    )
      blocked.add(projection.addonId ?? projection.id)
  return {
    options: {
      gfm: Object.assign(
        { gfm: false },
        ...flavors.map((flavor) => flavor.markedOptions),
      ).gfm as boolean,
      alerts: ids.includes('markdown.github'),
      textExtras: ids.includes('text-extras.text-extras'),
      math: ids.includes('math.latex'),
      frontmatter: projections.some(
        (projection) => projection.id === 'frontmatter.metadata',
      ),
    },
    /** Flavors whose label syntax the label renderer models. */
    labels: ids,
    /** Flavors whose Lezer syntax the source view also parses with. */
    syntax: flavors.filter(
      (flavor) => !modeled.includes(flavor) && flavor.syntax,
    ),
    blocked: [...blocked],
  }
}

/** The identical lexical read runs locally for short labels and in a worker for long ones. */
export function readSourceOutlineLabel(
  request: SourceOutlineLabelRequest,
  parser: ReturnType<typeof markdownSourceParser>,
  render: LabelRenderer,
): SourceOutlineLabelResult {
  const references = request.references,
    used = new Set<string>(),
    missing = new Set<string>(),
    lexer = new parser.Lexer({ ...parser.defaults, tokenizer: null })
  lexer.tokens.links = new Proxy(Object.create(null), {
    get: (_target, key) => {
      if (typeof key !== 'string') return undefined
      used.add(key)
      if (!references.has(key)) missing.add(key)
      return references.get(key) ?? undefined
    },
  })
  const tokens = lexer.inlineTokens(request.text)
  const rendered = missing.size ? null : render(tokens, request.level)
  return {
    label: null,
    ...(rendered !== null &&
      outlineLabel(typeof rendered === 'string' ? [rendered] : rendered)),
    references: [...used],
    missing: [...missing],
  }
}
type CachedHeading = {
  heading: SourceOutlineHeading
  references: readonly string[]
}

function rawPosition(source: SourceSnapshot, position: number) {
  const raw = source.editorToRaw(position)
  if (raw === null) throw new Error('Source heading is outside its snapshot.')
  return raw
}

function plainText(tokens: readonly Token[]): string {
  return tokens
    .map((token) => {
      if (token.type === 'html') return ''
      if ('tokens' in token && token.tokens) return plainText(token.tokens)
      if ('text' in token && typeof token.text === 'string')
        return token.type === 'codespan' ? token.text : decodeHTML(token.text)
      return token.type === 'br' ? ' ' : ''
    })
    .join('')
}

function headingText(source: SourceSnapshot, node: SyntaxNode) {
  const first = node.firstChild,
    last = node.lastChild,
    from =
      node.name.startsWith('ATX') && first?.name === 'HeaderMark'
        ? first.to
        : node.from,
    to = last?.name === 'HeaderMark' && last.from >= from ? last.from : node.to
  // The whole heading: the outline shortens long labels only on screen.
  return normalizedSource(
    source.sliceRaw(rawPosition(source, from), rawPosition(source, to)),
  )
    .replace(/\n[ \t]*(?:>[ \t]*)+/g, '\n')
    .trim()
}

/** Structural source headings, independent of a mounted rich editor or its DOM. */
export class SourceOutlineModel {
  readonly #markdown: MarkdownParser
  readonly #session: SourceParserSession
  readonly #frontmatter: boolean
  readonly #disabled: ReadonlySet<string>
  readonly #labels: ReturnType<typeof markdownSourceParser>
  readonly #deferLabels: boolean
  readonly #renderLabel: LabelRenderer
  #frontmatterRead: FrontmatterRead | null = null
  #contentFrom = 0
  #epoch = 0
  #disposed = false
  #headings: readonly SourceOutlineHeading[] = []
  #snapshot: SourceOutline | null = null
  #nextId = 0
  #tree: Tree | null = null
  #directory = new SourceOwners([])
  #first = 0
  #pending: PreparedSourceOperation[] = []
  #ready = false
  #index = new NodeWeakMap<CachedHeading>()
  #references = new Map<string, ReferenceValue | null>()
  #work = { indexVisits: 0, labelsRead: 0, published: 0 }

  constructor(
    source: SourceSnapshot,
    options: {
      gfm: boolean
      frontmatter: boolean
      disabled?: readonly string[]
      alerts?: boolean
      textExtras?: boolean
      math?: boolean
      deferLabels?: boolean
      renderLabel?: LabelRenderer
      /** Addon Lezer syntax, so blocks it adds hide the `#` lines they contain. */
      syntax?: readonly MarkdownConfig[]
    },
  ) {
    this.#deferLabels = options.deferLabels ?? false
    this.#frontmatter = options.frontmatter
    this.#disabled = new Set(options.disabled)
    this.#labels = markdownSourceParser({
      gfm: options.gfm,
      alerts: options.alerts ?? false,
      textExtras: options.textExtras ?? false,
      math: options.math ?? false,
    })
    this.#renderLabel = options.renderLabel ?? ((tokens) => plainText(tokens))
    const markdown = parser.configure([
      ...(options.gfm ? GFM : []),
      ...(options.math ? [blockMathSyntax, { wrap: trackReadAhead }] : []),
      {
        defineNodes: [{ name: 'Frontmatter', block: true }],
        // Only block boundaries feed the outline. Labels have their own bounded
        // semantic reader; parsing inline trees here can take seconds per line.
        parseInline: [
          {
            name: 'OutlineText',
            before: 'Escape',
            parse: (context) => context.end,
          },
        ],
      },
    ])
    // Added after OutlineText, addon inline parsers never run here.
    this.#markdown = options.syntax?.length
      ? protectMarkdownParser(markdown, options.syntax)
      : markdown
    this.#session = new SourceParserSession(
      source,
      this.#markdown,
      options.gfm ? 'gfm' : 'commonmark',
    )
  }

  counters(reset = false) {
    const result = { ...this.#session.counters(reset), ...this.#work }
    if (reset) this.#work = { indexVisits: 0, labelsRead: 0, published: 0 }
    return result
  }

  apply(prepared: PreparedSourceOperation) {
    this.#session.apply(prepared)
    if (this.#tree) this.#pending.push(prepared)
    this.#epoch++
    this.#ready = false
    if (
      this.#frontmatterRead &&
      !reuseFrontmatterRead(this.#frontmatterRead, prepared.operation.changes)
    )
      this.#frontmatterRead = null
  }

  adoptStorage(change: SourceStorageChange) {
    this.#session.adoptStorage(change)
    this.#epoch++
    if (this.#ready) this.#publish(change.after)
  }

  *read(): Generator<
    undefined | SourceOutlineReference | { label: SourceOutlineLabelRequest },
    SourceOutline,
    SourceOutlineInput
  > {
    const epoch = this.#epoch,
      source = this.#session.state().source,
      current = () => {
        if (this.#disposed || epoch !== this.#epoch)
          throw new Error('Source outline work is disposed or stale.')
      }
    current()
    if (this.#ready && this.#snapshot) return this.#snapshot
    if (this.#frontmatter && !this.#frontmatterRead) {
      const work = readSourceFrontmatter(source)
      try {
        for (;;) {
          current()
          const step = work.next()
          if (step.done) {
            this.#frontmatterRead = step.value
            break
          }
          yield
        }
      } finally {
        work.return(undefined as never)
      }
      const from = source.rawToEditor(
        this.#frontmatterRead.bounds?.contentFrom ?? 0,
      )
      if (from === null)
        throw new Error('Frontmatter ends inside a normalized line ending.')
      if (from !== this.#contentFrom) {
        this.#contentFrom = from
        this.#session.reconfigure(
          from ? new FrontmatterParser(this.#markdown, from) : this.#markdown,
          this.#session.state().dialect,
        )
      }
    }
    while (!this.#session.state().complete) {
      current()
      this.#session.advance()
      yield
    }
    current()
    const tree = this.#session.state().tree
    if (!tree) throw new Error('Source outline requires a completed tree.')
    // Unchanged paragraph boundaries also exclude reference definitions.
    // Prove that before scheduling reference lookups for every cached label.
    if (this.#mapBody(tree)) {
      this.#tree = tree
      this.#pending = []
      return this.#publish(source)
    }
    const references = new Map<string, ReferenceValue | null>(),
      changed = new Set<string>()
    // Definitions may change outside a reused heading's subtree. Revalidate only
    // its reference dependencies before reusing the corresponding labels.
    for (const [reference, previous] of this.#references) {
      const value = ((yield { reference }) as ReferenceValue | null) ?? null
      current()
      references.set(reference, value)
      if (value?.href !== previous?.href || value?.title !== previous?.title)
        changed.add(reference)
    }
    const cursor = tree.cursor(),
      headings: SourceOutlineHeading[] = [],
      positions: number[] = [],
      dependencies = new Set<string>()
    for (;;) {
      const name = cursor.name,
        heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(name),
        disabled =
          (name === 'Blockquote' && this.#disabled.has('core.quotes')) ||
          (name === 'BulletList' && this.#disabled.has('core.bullet-lists')) ||
          (name === 'OrderedList' && this.#disabled.has('core.numbered-lists'))
      if (!heading && cursor.type.is('Heading'))
        throw new Error('Source outline cannot represent the active syntax.')
      if (heading && !this.#disabled.has(`core.heading-${heading[1]}`)) {
        let cached = this.#index.cursorGet(cursor)
        if (
          !cached?.references.every(
            (reference) => references.has(reference) && !changed.has(reference),
          )
        ) {
          const text = headingText(source, cursor.node),
            used = new Set<string>(),
            level = Number(heading[1])
          let label: string | null, parts: SourceOutlineHeading['parts']
          for (;;) {
            const request = { text, level, references },
              result =
                this.#deferLabels && text.length > 512
                  ? ((yield { label: request }) as SourceOutlineLabelResult)
                  : readSourceOutlineLabel(
                      request,
                      this.#labels,
                      this.#renderLabel,
                    )
            current()
            for (const reference of result.references) used.add(reference)
            if (!result.missing.length) {
              label = result.label
              parts = result.parts
              break
            }
            for (const reference of result.missing) {
              const value = (yield { reference }) as ReferenceValue | null
              current()
              references.set(reference, value ?? null)
            }
          }
          this.#work.labelsRead++
          if (label === null)
            throw new Error(
              'Source outline cannot represent the active syntax.',
            )
          cached = {
            heading: Object.freeze({
              id: `source:${this.#nextId++}`,
              label: label.replace(/\s+/g, ' ').trim() || 'Untitled heading',
              ...(parts && { parts }),
              level,
            }),
            references: [...used],
          }
          this.#index.cursorSet(cursor, cached)
          yield
          current()
        }
        headings.push(cached.heading)
        positions.push(cursor.from)
        for (const reference of cached.references) dependencies.add(reference)
      }
      if (++this.#work.indexVisits % 64 === 0) {
        yield
        current()
      }
      if (!disabled && !heading && cursor.firstChild()) continue
      while (!cursor.nextSibling()) {
        if (!cursor.parent()) {
          current()
          if (
            headings.length !== this.#headings.length ||
            headings.some((entry, i) => entry !== this.#headings[i])
          ) {
            this.#headings = Object.freeze(headings)
            this.#work.published += headings.length
          }
          this.#references = new Map(
            [...dependencies].map((reference) => [
              reference,
              references.get(reference) ?? null,
            ]),
          )
          this.#first = positions[0] ?? 0
          this.#directory = new SourceOwners(
            positions.map((from, i) => ({
              kind: 'heading',
              length:
                (positions[i + 1] ?? source.normalizedLength) - (i ? from : 0),
            })),
          )
          this.#tree = tree
          this.#pending = []
          return this.#publish(source)
        }
      }
    }
  }

  #publish(source: SourceSnapshot) {
    const directory = this.#directory,
      headings = this.#headings,
      first = this.#first
    this.#snapshot = Object.freeze({
      headings,
      position: (index: number) => {
        const entry = directory.get(index)
        if (!entry) throw new Error('Source heading is outside its snapshot.')
        return rawPosition(source, index ? entry.from : first)
      },
      at: (position: number) => {
        const at = source.rawToEditor(position)
        if (at === null || at < first) return undefined
        const entry = directory.at(at)
        return entry ? headings[entry.index] : undefined
      },
    })
    this.#ready = true
    return this.#snapshot
  }

  #mapBody(tree: Tree): boolean {
    const previous = this.#tree,
      firstChange = this.#pending[0]
    if (!previous || !firstChange) return false
    // Identical paragraph and ancestor boundaries prove the edit cannot change
    // headings. Update section lengths in the persistent index, without walking
    // or shifting the heading rows. Structural edits take the full syntax path.
    let changes = ChangeSet.empty(firstChange.before.normalizedLength)
    const edits: { from: number; to: number; insert: string }[][] = []
    for (const prepared of this.#pending) {
      const group: { from: number; to: number; insert: string }[] = []
      for (const change of prepared.operation.changes) {
        const from = prepared.before.rawToEditor(change.from),
          to = prepared.before.rawToEditor(change.to)
        if (from === null || to === null) return false
        group.push({ from, to, insert: normalizedSource(change.insert) })
      }
      const update = ChangeSet.of(group, prepared.before.normalizedLength)
      if (update.newLength !== prepared.after.normalizedLength) return false
      changes = changes.compose(update)
      edits.push(group)
    }
    let safe = true
    const paragraph = (tree: Tree, position: number) => {
      let node = tree.resolveInner(position, 1)
      for (const side of [1, -1] as const) {
        node = tree.resolveInner(position, side)
        while (node.parent && node.name !== 'Paragraph') node = node.parent
        if (node.name === 'Paragraph') return node
      }
      return node
    }
    changes.iterChangedRanges((from, to, nextFrom, nextTo) => {
      this.#work.indexVisits += 2
      const oldBlock = paragraph(previous, from),
        newBlock = paragraph(tree, nextFrom)
      if (
        oldBlock.name !== 'Paragraph' ||
        newBlock.name !== 'Paragraph' ||
        from < oldBlock.from ||
        to > oldBlock.to ||
        nextFrom < newBlock.from ||
        nextTo > newBlock.to ||
        changes.mapPos(oldBlock.from) !== newBlock.from ||
        changes.mapPos(oldBlock.to, 1) !== newBlock.to
      )
        safe = false
      let oldParent = oldBlock.parent,
        newParent = newBlock.parent
      while (oldParent && newParent) {
        this.#work.indexVisits += 2
        if (
          oldParent.name !== newParent.name ||
          changes.mapPos(oldParent.from) !== newParent.from ||
          changes.mapPos(oldParent.to, 1) !== newParent.to
        )
          safe = false
        oldParent = oldParent.parent
        newParent = newParent.parent
      }
      if (oldParent || newParent) safe = false
    })
    if (!safe) return false
    let directory = this.#directory,
      first = this.#first
    for (const group of edits) {
      let shift = 0
      for (const change of group) {
        const from = change.from + shift,
          delta = change.insert.length - (change.to - change.from),
          entry = directory.at(from)
        if (entry)
          directory = directory.update(entry.index, {
            kind: entry.owner.kind,
            length: entry.owner.length + delta,
          })
        if (from < first) first += delta
        shift += delta
      }
    }
    this.#directory = directory
    this.#first = first
    return true
  }

  dispose() {
    this.#disposed = true
    this.#epoch++
    this.#ready = false
    this.#headings = []
    this.#snapshot = null
    this.#tree = null
    this.#pending = []
    this.#directory = new SourceOwners([])
    this.#index = new NodeWeakMap()
    this.#references.clear()
    this.#frontmatterRead = null
    this.#session.dispose()
  }
}
