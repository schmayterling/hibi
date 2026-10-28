import {
  type Input,
  type PartialParse,
  type SyntaxNode,
  type Tree,
  TreeFragment,
} from '@lezer/common'
import { ChunkedMarkdownParser, parsedChunks } from './chunked-markdown.ts'
import {
  formattedTableRow,
  formattedTextEffects,
} from './formatted-text-effects.ts'
import {
  type FormattedTextInput,
  formattedMarkerRanges,
  textFeatures,
} from './formatted-text-rules.ts'
import { FormattedTextMask } from './formatted-text-runs.ts'
import {
  type BoundaryConfig,
  boundaryInlineParser,
  boundaryParser,
} from './markdown-boundary-syntax.ts'
import {
  createPlainTextRunExtension,
  plainInlineText,
} from './markdown-plain-text-runs.ts'
import { cellContent } from './markdown-table-source.ts'
import {
  type RenderedChunk,
  type RenderedRange,
  type RenderedRun,
  renderedRange,
} from './rendered-range.ts'
import {
  type RenderedEdit,
  type RenderedReplacement,
  renderedReplacementCandidate,
} from './rendered-replace.ts'
import { type SourceSnapshot, SourceStore } from './source-buffer.ts'
import {
  normalizedSource,
  sourceChangesFromEditor,
} from './source-projection.ts'
import type { SourceMatch } from './source-search.ts'

export type { RenderedRange } from './rendered-range.ts'
export { renderedRange } from './rendered-range.ts'

export type RenderedContainer = Readonly<{
  kind: 'mark' | 'link'
  open: RenderedRange
  close: RenderedRange
  visible: RenderedRange
  autolink?: true
}>
export type RenderedCode = RenderedRange & Readonly<{ width: number }>
export type RenderedMatchContext = Readonly<{
  lineFrom: number
  linePrefix: string
  after: string
  block: RenderedRange
  code:
    | (RenderedCode & Readonly<{ leftTicks: number; rightTicks: number }>)
    | null
}>
const page = 4096,
  batch = 1024
type Frame = ReturnType<typeof parsedChunks>[number]
type Window = { from: number; to: number; frames: Frame[]; nodes: number }
type ProofStyle = RenderedRange & { key: string }
type PositionMap = (position: number, side?: -1 | 1) => number
const markNames = new Set([
  'InlineCode',
  'Emphasis',
  'StrongEmphasis',
  'Strikethrough',
  'Highlight',
  'Subscript',
  'Link',
  'WikiLink',
  'Autolink',
])
type DetailFrame = RenderedRange & {
  tree: Tree
  start: (position: number) => number
  end: (position: number) => number
  local: (position: number) => number
}

/** The parser reads bounded normalized pages, including on a single huge line. */
class Reader {
  source: SourceSnapshot
  pages: { from: number; text: string }[] = []
  reads = 0
  units = 0
  maximum = 0
  requestMaximum = 0
  constructor(source: SourceSnapshot) {
    this.source = source
  }
  chunk(at: number) {
    if (at >= this.source.normalizedLength) return ''
    const from = Math.floor(at / page) * page
    let found = this.pages.find((value) => value.from === from)
    if (!found) {
      const end = Math.min(from + page, this.source.normalizedLength)
      const rawFrom = this.source.editorToRaw(from)!,
        rawTo = this.source.editorToRaw(end)!
      found = {
        from,
        text: normalizedSource(this.source.sliceRaw(rawFrom, rawTo)),
      }
      this.pages.push(found)
      if (this.pages.length > 2) this.pages.shift()
      this.reads++
      this.units += rawTo - rawFrom
      this.maximum = Math.max(this.maximum, rawTo - rawFrom)
    }
    return found.text.slice(at - from)
  }
  read(from: number, to: number) {
    if (from < 0 || to < from || to > this.source.normalizedLength)
      throw new Error('Find selection is outside its source snapshot.')
    this.requestMaximum = Math.max(this.requestMaximum, to - from)
    const parts: string[] = []
    while (from < to) {
      const part = this.chunk(from).slice(0, to - from)
      if (!part.length) throw new Error('Find coverage is incomplete.')
      parts.push(part)
      from += part.length
    }
    return parts.join('')
  }
}

export class UnsupportedRenderedFind extends Error {
  constructor() {
    super('Formatted find configuration is unsupported.')
  }
}

/**
 * The formatted parser owns syntax. Packed masks, shared boundary metadata
 * survive a build. Navigation lazily retains two windows; counts retain no matches.
 */
export class RenderedTextIndex {
  #source: SourceSnapshot
  readonly #reader: Reader
  readonly #parser: ChunkedMarkdownParser
  readonly #inline: NonNullable<ReturnType<typeof boundaryInlineParser>>
  readonly #config: BoundaryConfig
  readonly #input: Input & FormattedTextInput
  readonly #mask: FormattedTextMask
  #syntaxInput: Input
  #plainTail: RenderedRange | null = null
  #maximumYieldRead = 0
  #fragments: readonly TreeFragment[] = []
  #windows: Window[] = []
  #definitions = new Set<string>()
  #complete = false
  #building: Generator<void> | null = null
  #operations = 0
  #pending = 0
  #steps = 0
  #maximum = 0
  #parses = 0
  #maximumAdvanceRead = 0
  readonly prefix: number
  constructor(source: SourceSnapshot, prefix = 0, config?: BoundaryConfig) {
    if (
      !config ||
      !Array.isArray(config.textFeatures) ||
      config.textSyntax === null ||
      config.prefix !== prefix ||
      config.textFeatures.some((id) => !textFeatures.has(id))
    )
      throw new Error('Formatted find configuration is unsupported.')
    const base = boundaryParser({
      ...config,
      syntax: config.textSyntax ?? config.syntax,
    })
    const inline = boundaryInlineParser(config)
    if (!base || !inline)
      throw new Error('Formatted find configuration is unsupported.')
    this.#source = source
    this.prefix = prefix
    this.#config = config
    this.#reader = new Reader(source)
    this.#inline = inline
    const runs = createPlainTextRunExtension()
    const full = base.configure(runs.extension)
    runs.allow(full)
    this.#parser = new ChunkedMarkdownParser(full, base, {
      chunkSize: config.chunkSize,
      groupSize: config.groupSize,
      giantBlock: config.giantBlock,
      opaque: new Set(config.opaque),
      trackReadAhead: false,
    })
    this.#input = {
      length: source.normalizedLength,
      lineChunks: false,
      chunk: (at) => this.#reader.chunk(at),
      read: (from, to) => this.#reader.read(from, to),
      lineAt: (at) => {
        const line = this.#source.lineAt(this.#source.editorToRaw(at)!)!
        return {
          from: this.#source.rawToEditor(line.from)!,
          to: this.#source.rawToEditor(line.to)!,
        }
      },
    }
    this.#syntaxInput = this.#input
    this.#mask = new FormattedTextMask(this.#input, (units) =>
      this.#tick(units),
    )
  }
  get length() {
    return this.#source.normalizedLength
  }
  get config() {
    return this.#config
  }
  adoptSource(source: SourceSnapshot) {
    this.#source = source
    this.#reader.source = source
  }
  validStart(position: number) {
    const raw = this.#source.editorToRaw(position)
    return raw !== null && this.#source.isEditBoundary(raw)
  }
  counters() {
    return {
      steps: this.#steps,
      operations: this.#operations,
      maximumStep: this.#maximum,
      sourceReads: this.#reader.reads,
      sourceUnits: this.#reader.units,
      maximumRead: this.#reader.maximum,
      maximumYieldRead: this.#maximumYieldRead,
      plainTailUnits: this.#plainTail
        ? this.#plainTail.to - this.#plainTail.from
        : 0,
      maximumInputRequest: this.#reader.requestMaximum,
      maximumAdvanceRead: this.#maximumAdvanceRead,
      parses: this.#parses,
      maskBytes: this.#mask.counters().maskBytes,
      retainedWindows: this.#windows.length,
      retainedNodes: this.#windows.reduce(
        (sum, window) => sum + window.nodes,
        0,
      ),
      complete: this.#complete,
    }
  }
  #tick(units = 1) {
    this.#operations += units
    this.#pending += units
    if (this.#pending < batch) return false
    this.#maximum = Math.max(this.#maximum, this.#pending)
    this.#pending = 0
    this.#steps++
    return true
  }
  *#advance(parse: PartialParse): Generator<void, Tree> {
    this.#parses++
    for (;;) {
      const before = this.#reader.units,
        tree = parse.advance()
      this.#maximumAdvanceRead = Math.max(
        this.#maximumAdvanceRead,
        this.#reader.units - before,
      )
      yield
      if (tree) return tree
    }
  }
  *#window(at: number): Generator<void, Window> {
    if (at >= this.#syntaxInput.length)
      return { from: at, to: this.length, frames: [], nodes: 0 }
    const width = this.#config.chunkSize * this.#config.groupSize
    const from = Math.floor(at / width) * width,
      to = Math.min(this.#syntaxInput.length, from + width)
    const found = this.#windows.find(
      (value) => value.from <= from && value.to >= to,
    )
    if (found) return found
    const tree = yield* this.#advance(
      this.#parser.startChunkedParse(
        this.#syntaxInput,
        this.#fragments,
        { from, to },
        this.prefix,
      ),
    )
    const frames = parsedChunks(tree, { from, to })
    let coveredTo = to
    for (const frame of frames)
      for (const covered of frame.covered)
        if (covered.from <= to && covered.to > coveredTo) coveredTo = covered.to
    let nodes = 0
    for (const frame of frames) {
      const cursor = frame.chunk.cursor()
      do {
        nodes++
        if (this.#tick()) yield
      } while (cursor.next())
    }
    const result = { from, to: coveredTo, frames, nodes }
    this.#windows.push(result)
    if (this.#windows.length > 2) this.#windows.shift()
    return result
  }
  #scope(tree: Tree, from: number, to: number) {
    let node = tree.resolveInner(from, 1)
    while (
      node.parent &&
      (node.from > from || node.to < to || !node.type.is('LeafBlock'))
    )
      node = node.parent
    return node
  }

  *#projectFrames(
    frames: readonly Frame[],
    requested: RenderedRange,
    resolveFootnotes: boolean,
    definitions = this.#definitions,
    apply = true,
  ) {
    for (const frame of frames) {
      const range = {
        from: Math.max(requested.from, frame.from),
        to: Math.min(requested.to, frame.from + frame.chunk.length),
      }
      if (range.to <= range.from) continue
      for (const effect of formattedTextEffects(
        this.#scope(
          frame.chunk,
          range.from - frame.from,
          range.to - frame.from,
        ),
        frame.from,
        this.#input,
        range,
        this.#config,
        this.#inline,
        definitions,
        resolveFootnotes,
        false,
        () => {
          throw new UnsupportedRenderedFind()
        },
      )) {
        if (effect && apply) yield* this.#mask.effect(effect, range)
        if (this.#tick()) yield
      }
    }
  }

  *#project(resolveFootnotes: boolean) {
    this.#mask.resetLeaves()
    const width = this.#config.chunkSize * this.#config.groupSize
    for (let from = 0; from < this.#syntaxInput.length; from += width) {
      const window = yield* this.#window(from)
      yield* this.#projectFrames(
        window.frames,
        {
          from,
          to: Math.min(from + width, this.#syntaxInput.length),
        },
        resolveFootnotes,
      )
    }
    if (this.#plainTail) {
      yield* this.#mask.effect(
        { kind: 'leaf', ...this.#plainTail },
        { from: 0, to: this.length },
      )
      yield* this.#mask.effect(
        { kind: 'hide', from: this.#plainTail.to, to: this.length },
        { from: 0, to: this.length },
      )
    }
  }
  *build(): Generator<void> {
    if (this.#complete) return
    this.#building ??= this.#build()
    for (;;) {
      const before = this.#reader.units
      const next = this.#building.next()
      this.#maximumYieldRead = Math.max(
        this.#maximumYieldRead,
        this.#reader.units - before,
      )
      if (next.done) return
      yield
    }
  }
  /**
   * Prove a final root paragraph with the configured grammar, then use the
   * existing plain-run predicate to avoid lezer flattening its physical line.
   * ponytail: the grammar proof's prefix fits one scan window; other long
   * lines keep the formatted parser's path until it exposes retained contexts.
   */
  *#preparePlainTail(): Generator<void> {
    const tail = this.text(
      Math.max(this.prefix, this.length - batch),
      this.length,
    )
    const trailing = /\n*$/.exec(tail)![0].length
    if (this.#tick(tail.length)) yield
    if (trailing === tail.length) return
    const range = this.#input.lineAt(this.length - trailing)
    if (
      range.from < this.prefix ||
      range.to - range.from < this.#config.giantBlock ||
      range.from - this.prefix > this.#config.giantBlock
    )
      return
    const last = this.text(Math.max(range.from, range.to - batch), range.to)
    if (!plainInlineText(last)) return
    if (this.#tick(last.length)) yield
    for (let at = range.from; at < range.to; ) {
      let to = Math.min(range.to, at + batch)
      if (!this.validStart(to)) to--
      const text = this.text(Math.max(range.from, at - 3), to)
      if (!plainInlineText(text)) return
      at = to
      if (this.#tick(text.length)) yield
    }
    yield* this.#certifyPlainTail(range)
  }
  *#certifyPlainTail(range: RenderedRange): Generator<void, boolean> {
    if (range.from - this.prefix > this.#config.giantBlock) return false
    const headTo = Math.min(range.to, range.from + batch)
    const text = this.text(this.prefix, headTo)
    let tree: Tree
    try {
      tree = yield* this.#advance(this.#parser.full.startParse(text))
    } catch {
      return false
    }
    const node = tree.resolveInner(range.from - this.prefix, 1)
    if (
      node.name !== 'Paragraph' ||
      node.from + this.prefix !== range.from ||
      node.parent?.name !== 'Document'
    )
      return false
    this.#plainTail = range
    const length = range.from
    this.#syntaxInput = {
      length,
      lineChunks: false,
      chunk: (at) => this.#input.chunk(at).slice(0, Math.max(0, length - at)),
      read: (from, to) =>
        this.#input.read(Math.min(from, length), Math.min(to, length)),
    }
    return true
  }

  *#build(): Generator<void> {
    yield* this.#preparePlainTail()
    const boundaries = yield* this.#advance(
      this.#parser.startBoundaryParse(this.#syntaxInput, [], this.prefix),
    )
    this.#fragments = TreeFragment.addTree(boundaries)
    yield* this.#project(false)
    if (this.#definitions.size) yield* this.#project(true)
    yield* this.#mask.effect(
      { kind: 'hide', from: 0, to: this.prefix },
      { from: 0, to: this.length },
    )
    this.#maximum = Math.max(this.#maximum, this.#pending)
    this.#windows = []
    this.#complete = true
  }
  text(from: number, to: number) {
    return this.#reader.read(from, to)
  }
  *runs(from = 0): Generator<RenderedRun> {
    if (!this.#complete) throw new Error('Find coverage is incomplete.')
    yield* this.#mask.runs(from)
  }
  *range(
    from: number,
    to: number,
    options: { blockSeparator?: string } = {},
  ): Generator<RenderedChunk> {
    yield* renderedRange(this.runs(from), from, to, this.#input, options)
  }
  *#details(
    window: Window,
    from: number,
    to: number,
  ): Generator<DetailFrame | null> {
    for (const frame of window.frames) {
      const source = (position: number) => frame.from + position
      yield {
        from: frame.from,
        to: frame.from + frame.chunk.length,
        tree: frame.chunk,
        start: source,
        end: source,
        local: (position) => position - frame.from,
      }
      if (!this.#config.textFeatures?.includes('markdown.tables')) continue
      const cursor = frame.chunk.cursor()
      let descend = true
      do {
        const node = cursor.node,
          start = source(node.from),
          end = source(node.to)
        descend =
          start < to && end > from && !this.#config.literal.includes(node.name)
        if (!descend || node.name !== 'Table') continue
        descend = false
        for (
          let at = this.#input.lineAt(Math.max(from, start)).from;
          at < Math.min(to, end);
        ) {
          const bounds = this.#input.lineAt(at)
          const row = formattedTableRow(node, frame.from, this.#input, at)
          for (const cell of row?.cells ?? []) {
            if (cell.from >= to || cell.to <= from) continue
            const content = cellContent(this.text(cell.from, cell.to))
            const start = (position: number) =>
              cell.from + (content.source[position] ?? cell.to - cell.from)
            const end = (position: number) =>
              position > content.text.length
                ? cell.to
                : position
                  ? cell.from + content.source[position - 1]! + 1
                  : start(0)
            yield {
              ...cell,
              tree: this.#inline.parse(content.text),
              start,
              end,
              local(position) {
                let low = 0,
                  high = content.text.length
                while (low < high) {
                  const mid = (low + high) >>> 1
                  if (start(mid) < position) low = mid + 1
                  else high = mid
                }
                return low
              },
            }
          }
          if (this.#tick()) yield null
          at = bounds.to + 1
        }
      } while (cursor.next(descend))
    }
  }

  *containers(from: number, to: number): Generator<RenderedContainer | null> {
    const work = this.#window(from)
    let next = work.next()
    while (!next.done) {
      yield null
      next = work.next()
    }
    const window = next.value
    const seen = new Set<string>(),
      containers: RenderedContainer[] = []
    for (const frame of this.#details(window, from, to)) {
      if (!frame) {
        yield null
        continue
      }
      const read = (a: number, b: number) =>
        this.text(
          Math.max(0, frame.start(a)),
          Math.min(this.length, frame.end(b)),
        )
      const cursor = frame.tree.cursor()
      let descend = true
      do {
        const node = cursor.node,
          start = frame.start(node.from),
          end = frame.end(node.to)
        descend =
          start < to &&
          end > from &&
          !this.#config.literal.includes(node.name) &&
          node.name !== 'Table'
        if (!descend) continue
        const hidden = formattedMarkerRanges(node, read)
        if (hidden.length !== 2 || !markNames.has(node.name)) continue
        const open = {
            from: frame.start(hidden[0]!.from),
            to: frame.end(hidden[0]!.to),
          },
          close = {
            from: frame.start(hidden[1]!.from),
            to: frame.end(hidden[1]!.to),
          }
        const key = open.from + ':' + close.to
        if (seen.has(key)) continue
        seen.add(key)
        // Whole visible coverage is checked against retained masks, never marker text.
        let before = false,
          after = false,
          opaque = false,
          first = -1,
          last = -1
        for (const run of this.runs(open.to)) {
          if (run.from >= close.from) break
          if (run.barrier) {
            opaque = true
            break
          }
          if (run.text === '') continue
          const a = Math.max(open.to, run.from),
            b = Math.min(close.from, run.to)
          if (a >= b) continue
          if (first < 0) first = a
          last = b
          before ||= a < from
          after ||= b > to
          if (this.#tick()) yield null
        }
        if (
          (!opaque && !before && !after && first >= 0) ||
          node.name === 'Autolink'
        )
          containers.push({
            kind: ['Link', 'WikiLink', 'Autolink'].includes(node.name)
              ? 'link'
              : 'mark',
            open,
            close,
            visible: { from: first, to: last },
            ...(node.name === 'Autolink' ? { autolink: true as const } : {}),
          })
        if (this.#tick()) yield null
      } while (cursor.next(descend))
    }
    const compact: RenderedContainer[] = []
    for (const container of containers) {
      const previous = compact.at(-1)
      if (
        container.kind === 'mark' &&
        previous?.kind === 'mark' &&
        container.visible.from === previous.visible.from &&
        container.visible.to === previous.visible.to &&
        container.open.from === previous.open.to &&
        container.close.to === previous.close.from
      )
        compact[compact.length - 1] = {
          ...previous,
          open: { from: previous.open.from, to: container.open.to },
          close: { from: container.close.from, to: previous.close.to },
        }
      else compact.push(container)
    }
    yield* compact
  }

  /** Cooperative proof over an immutable fork, with the exact same grammar and features. */
  *prepareReplacement(
    match: SourceMatch,
    replacement: string,
  ): Generator<void, RenderedReplacement> {
    const result = (
      edits: readonly RenderedEdit[] | null,
    ): RenderedReplacement =>
      Object.freeze({
        from: match.from,
        to: match.to,
        text: replacement,
        edits,
      })
    if (typeof replacement !== 'string' || /[\uD800-\uDFFF]/u.test(replacement))
      return result(null)
    const raw = renderedReplacementCandidate(match, replacement)
    if (!raw) return result(null)
    const verified = yield* this.#verifies(match, replacement, raw)
    if (verified === null) return result(null)
    if (verified) return result(raw)
    const escaped = renderedReplacementCandidate(match, replacement, true)
    if (
      !escaped ||
      JSON.stringify(raw) === JSON.stringify(escaped) ||
      !(yield* this.#verifies(match, replacement, escaped))
    )
      return result(null)

    // Remove unnecessary escapes from the existing literal helper's output.
    // A removed slash survives only after the same rendered-text proof passes.
    let minimal = escaped
    const inserted = minimal.findIndex((edit) => !!edit.insert)
    if (inserted >= 0) {
      let at = 0
      while (at < minimal[inserted]!.insert.length) {
        const text = minimal[inserted]!.insert
        if (text[at] !== '\\') {
          at++
          continue
        }
        const candidate = minimal.map((edit, index) =>
          index === inserted
            ? { ...edit, insert: text.slice(0, at) + text.slice(at + 1) }
            : edit,
        )
        if (yield* this.#verifies(match, replacement, candidate))
          minimal = candidate
        else at += 2
      }
    }
    return result(minimal)
  }
  #proofRange(edits: readonly RenderedEdit[]): RenderedRange | null {
    const lo = edits[0]!.from,
      hi = edits.at(-1)!.to
    let from = Math.max(this.prefix, lo - page),
      to = Math.min(this.length, hi + page)
    // Include neighboring visible content so a window retains semantic gaps.
    const gap = (at: number) =>
      (this.#mask.code(at) === 1 || this.#mask.code(at) === 4) &&
      /^[ \t\n]$/.test(this.text(at, at + 1))
    const left = Math.max(this.prefix, from - page),
      right = Math.min(this.length, to + page)
    while (from > left && gap(from)) from--
    while (to < right && gap(to - 1)) to++
    if ((from > this.prefix && gap(from)) || (to < this.length && gap(to - 1)))
      return null
    if (!this.validStart(from)) from--
    if (!this.validStart(to)) to++
    const first = this.runs(from).next().value
    if (first?.text !== undefined) from = Math.min(from, first.from)
    const last = this.runs(Math.max(from, to - 1)).next().value
    if (last?.text !== undefined) to = Math.max(to, last.to)
    return { from, to }
  }

  *#proofWindow(range: RenderedRange): Generator<void, Window> {
    const frames: Frame[] = []
    for (let at = range.from; at < range.to; ) {
      const window = yield* this.#window(at)
      for (const frame of window.frames)
        if (
          !frames.some(
            (value) => value.from === frame.from && value.chunk === frame.chunk,
          )
        )
          frames.push(frame)
      at = Math.max(at + 1, window.to)
    }
    return { ...range, frames, nodes: 0 }
  }

  *#partial(range: RenderedRange, fragments: readonly TreeFragment[]) {
    const tree = yield* this.#advance(
      this.#parser.startChunkedParse(
        this.#syntaxInput,
        fragments,
        range,
        this.prefix,
      ),
    )
    const window: Window = {
      ...range,
      frames: parsedChunks(tree, range),
      nodes: 0,
    }
    this.#fragments = TreeFragment.addTree(tree)
    const definitions = new Set<string>()
    yield* this.#projectFrames(window.frames, range, false, definitions)
    if (this.#definitions.size) {
      this.#mask.resetLeaves()
      yield* this.#projectFrames(window.frames, range, true)
    }
    if (this.#plainTail)
      yield* this.#mask.effect({ kind: 'leaf', ...this.#plainTail }, range)
    this.#complete = true
    return { window, definitions }
  }

  #boundary(
    window: Window,
    position: number,
    side: -1 | 1,
    map: PositionMap = (position) => position,
  ) {
    for (const frame of window.frames) {
      if (
        position < frame.from ||
        position > frame.from + frame.chunk.length ||
        (position === frame.from && side < 0) ||
        (position === frame.from + frame.chunk.length && side > 0)
      )
        continue
      const names: string[] = []
      for (
        let node: SyntaxNode | null = frame.chunk.resolveInner(
          position - frame.from,
          side,
        );
        node;
        node = node.parent
      )
        if (
          markNames.has(node.name) ||
          node.type.is('LeafBlock') ||
          [
            'Document',
            'Blockquote',
            'BulletList',
            'OrderedList',
            'ListItem',
            'FootnoteDefinition',
            'Table',
            'Task',
            'Subtext',
            'AlertTitle',
            'BlockMath',
          ].includes(node.name)
        )
          names.push(
            node.name +
              ':' +
              map(frame.from + node.from, -1) +
              '-' +
              map(frame.from + node.to, 1),
          )
      return names.join('/')
    }
    return null
  }

  *#styles(
    window: Window,
    range: RenderedRange,
    map: PositionMap,
    edits: readonly RenderedEdit[] = [],
    match?: SourceMatch,
  ): Generator<void, ProofStyle[] | null> {
    const styles: ProofStyle[] = [],
      seen = new Set<string>()
    for (const frame of this.#details(window, range.from, range.to)) {
      if (!frame) {
        yield
        continue
      }
      const read = (a: number, b: number) =>
        this.text(
          Math.max(0, frame.start(a)),
          Math.min(this.length, frame.end(b)),
        )
      const cursor = this.#scope(
        frame.tree,
        frame.local(Math.max(range.from, frame.from)),
        frame.local(Math.min(range.to, frame.to)),
      ).cursor()
      let descend = true
      do {
        const node = cursor.node,
          from = frame.start(node.from),
          to = frame.end(node.to)
        descend =
          from < range.to &&
          to > range.from &&
          !this.#config.literal.includes(node.name) &&
          node.name !== 'Table'
        if (!descend) continue
        const code = node.name === 'FencedCode' || node.name === 'CodeBlock'
        if (!markNames.has(node.name) && !code) continue
        const link = ['Link', 'WikiLink', 'Autolink'].includes(node.name)
        const hidden = formattedMarkerRanges(node, read)
        const container = match?.containers?.find(
          (value) =>
            value.kind === 'link' &&
            value.open.from === from &&
            value.close.to === to,
        )
        const visible =
          container?.visible ??
          (hidden.length === 2
            ? {
                from: frame.end(hidden[0]!.to),
                to: frame.start(hidden[1]!.from),
              }
            : { from, to })
        // A fully replaced link loses its destination, as the deletion helper specifies.
        if (
          link &&
          match &&
          match.from <= visible.from &&
          match.to >= visible.to
        )
          continue
        let key = code ? 'CodeBlock' : node.name
        const target = link
          ? (node.getChild('URL') ?? node.getChild('WikiTarget'))
          : code
            ? node.getChild('CodeInfo')
            : null
        if (target) {
          const a = frame.start(target.from),
            b = frame.end(target.to)
          if (edits.some((edit) => edit.from < b && edit.to > a)) return null
          // Equal mapped ranges refer to the same unchanged source, without reading a long href.
          key += '@' + map(a, -1) + ':' + map(b, 1)
        }
        const id = from + ':' + to + ':' + key
        if (!seen.has(id)) {
          seen.add(id)
          styles.push({ from, to, key })
        }
        if (this.#tick()) yield
      } while (cursor.next(descend))
    }
    return styles
  }

  *#tokens(
    range: RenderedRange,
    styles: readonly ProofStyle[],
    map: PositionMap,
  ): Generator<string> {
    const events = styles
      .flatMap((style) => [
        { at: style.from, key: style.key, delta: 1 },
        { at: style.to, key: style.key, delta: -1 },
      ])
      .sort((a, b) => a.at - b.at || a.delta - b.delta)
    const active = new Map<string, number>()
    let event = 0,
      signature = ''
    const marked = (at: number, text: string) => {
      let changed = false
      while (event < events.length && events[event]!.at <= at) {
        const value = events[event++]!,
          count = (active.get(value.key) ?? 0) + value.delta
        if (count) active.set(value.key, count)
        else active.delete(value.key)
        changed = true
      }
      if (changed) signature = [...active.keys()].sort().join('|')
      return 'T' + signature + '\u0000' + text
    }
    for (const run of this.runs(range.from)) {
      if (run.from >= range.to) break
      const start = Math.max(range.from, run.from),
        end = Math.min(range.to, run.to)
      if (end <= start || run.text === '') continue
      if (run.barrier) {
        yield 'B' + map(start, -1) + ':' + map(end, 1)
        continue
      }
      if (run.text !== undefined) {
        for (const scalar of run.text) yield marked(run.from, scalar)
        continue
      }
      for (let at = start; at < end; ) {
        let stop = Math.min(end, at + page)
        if (!this.validStart(stop)) stop--
        const text = this.text(at, stop)
        for (const scalar of text) {
          yield marked(at, scalar)
          at += scalar.length
        }
      }
    }
  }

  *#plainProof(
    match: SourceMatch,
    replacement: string,
    edits: readonly RenderedEdit[],
  ): Generator<void, boolean | null> {
    const tail = this.#plainTail!
    let from = Math.max(tail.from, edits[0]!.from - page),
      to = Math.min(tail.to, edits.at(-1)!.to + page)
    if (!this.validStart(from)) from--
    if (!this.validStart(to)) to++
    // The complete surrounding root was already proved free of inline starts.
    // Plain guards retain mid-line flanking and detect new links crossing the seam.
    const prefix = from > tail.from ? 'x' : '',
      suffix = to < tail.to ? 'x' : ''
    const text = prefix + this.text(from, to) + suffix,
      shift = prefix.length - from
    const source = new SourceStore(text, {
      tabId: 'rendered-proof',
      revision: 0,
    })
    const local = new RenderedTextIndex(source.snapshot(), 0, {
      ...this.#config,
      prefix: 0,
    })
    local.#definitions = this.#definitions
    yield* local.#partial({ from: 0, to: text.length }, [])
    const moved = (range: RenderedRange) => ({
      from: range.from + shift,
      to: range.to + shift,
    })
    return yield* local.#verifies(
      {
        ...match,
        ...moved(match),
        ...(match.segments ? { segments: match.segments.map(moved) } : {}),
        containers: [],
        context: { ...match.context!, block: { from: 0, to: text.length } },
      },
      replacement,
      edits.map((edit) => ({ ...edit, ...moved(edit) })),
    )
  }

  *#verifies(
    match: SourceMatch,
    replacement: string,
    edits: readonly RenderedEdit[],
  ): Generator<void, boolean | null> {
    if (
      this.#plainTail &&
      edits.every(
        (edit) =>
          edit.from >= this.#plainTail!.from && edit.to <= this.#plainTail!.to,
      )
    )
      return yield* this.#plainProof(match, replacement, edits)
    const fork = SourceStore.fromSnapshot(this.#source)
    const changes = sourceChangesFromEditor(fork.snapshot(), edits)
    let snapshot = fork.snapshot()
    if (
      changes.some(
        (edit) => snapshot.sliceRaw(edit.from, edit.to) !== edit.insert,
      )
    )
      snapshot = fork.prepare({
        document: snapshot.document,
        operationId: 'rendered-replace',
        historyGroup: 'replace',
        origin: 'source',
        baseVersion: snapshot.version,
        contentVersion: snapshot.version + 1,
        changes,
      }).after
    let shift = 0
    const mapped = edits.map((edit) => {
      const fromB = edit.from + shift,
        toB = fromB + normalizedSource(edit.insert).length
      shift = toB - edit.to
      return { fromA: edit.from, toA: edit.to, fromB, toB }
    })
    const map: PositionMap = (position, side = -1) => {
      let shift = 0
      for (const edit of mapped) {
        if (position <= edit.fromA) break
        if (position === edit.toA && position > edit.fromA) return edit.toB
        if (position <= edit.toA) return side < 0 ? edit.fromB : edit.toB
        shift = edit.toB - edit.toA
      }
      return position + shift
    }
    const range = this.#proofRange(edits)
    if (!range) return false
    const old = yield* this.#proofWindow(range)
    const local = new Set<string>()
    yield* this.#projectFrames(old.frames, range, false, local, false)
    const next = new RenderedTextIndex(snapshot, this.prefix, this.#config)
    next.#definitions = this.#definitions
    if (this.#plainTail) {
      if (
        !(yield* next.#certifyPlainTail({
          from: map(this.#plainTail.from, -1),
          to: map(this.#plainTail.to, 1),
        }))
      )
        return false
    }
    const nextRange = { from: map(range.from, -1), to: map(range.to, 1) }
    let partial: { window: Window; definitions: Set<string> }
    try {
      partial = yield* next.#partial(
        nextRange,
        TreeFragment.applyChanges(this.#fragments, mapped),
      )
    } catch (error) {
      return error instanceof UnsupportedRenderedFind ? null : false
    }
    if (
      local.size !== partial.definitions.size ||
      [...local].some((id) => !partial.definitions.has(id))
    )
      return false
    if (
      range.from > this.prefix &&
      this.#boundary(old, range.from, -1, map) !==
        next.#boundary(partial.window, nextRange.from, -1)
    )
      return false
    if (
      range.to < this.length &&
      this.#boundary(old, range.to, 1, map) !==
        next.#boundary(partial.window, nextRange.to, 1)
    )
      return false
    const styles = yield* this.#styles(old, range, map, edits, match)
    const actualStyles = yield* next.#styles(
      partial.window,
      nextRange,
      (position) => position,
    )
    if (!styles || !actualStyles) return false
    const inherited = [
      ...new Set(
        styles
          .filter((style) => style.from <= match.from && match.from < style.to)
          .map((style) => style.key),
      ),
    ]
      .sort()
      .join('|')
    const original = this
    const expected = (function* () {
      yield* original.#tokens({ from: range.from, to: match.from }, styles, map)
      for (const scalar of normalizedSource(replacement))
        yield 'T' + inherited + '\u0000' + scalar
      yield* original.#tokens({ from: match.to, to: range.to }, styles, map)
    })()
    const actual = next.#tokens(nextRange, actualStyles, (position) => position)
    let work = 0
    for (;;) {
      const a = expected.next(),
        b = actual.next()
      if (a.done || b.done) return a.done === b.done
      if (a.value !== b.value) return false
      if (++work === batch) {
        work = 0
        yield
      }
    }
  }

  *context(
    from: number,
    to: number,
    firstTo: number,
  ): Generator<void, RenderedMatchContext> {
    const window = yield* this.#window(from)
    let found: SyntaxNode | null = null,
      start = (position: number) => position,
      end = start
    for (const frame of this.#details(window, from, to)) {
      if (!frame) {
        yield
        continue
      }
      if (from >= frame.from && from < frame.to) {
        found = frame.tree.resolveInner(frame.local(from), 1)
        start = frame.start
        end = frame.end
      }
    }
    let code: RenderedCode | null = null
    let block = {
      from: this.#input.lineAt(from).from,
      to: this.#input.lineAt(to).to,
    }
    for (let node = found; node; node = node.parent) {
      if (this.#config.literal.includes(node.name)) {
        code = null
        break
      }
      if (node.name === 'InlineCode') {
        const open = node.firstChild!,
          close = node.lastChild!
        code = {
          from: end(open.to),
          to: start(close.from),
          width: open.to - open.from,
        }
      } else if (node.name === 'CodeBlock' || node.name === 'FencedCode')
        code ??= { from: start(node.from), to: end(node.to), width: 0 }
      if (
        [
          'Paragraph',
          'Task',
          'CodeBlock',
          'FencedCode',
          'Subtext',
          'HTMLBlock',
        ].includes(node.name) ||
        /Heading/.test(node.name)
      )
        block = { from: start(node.from), to: end(node.to) }
    }
    const physical = this.#input.lineAt(from).from,
      lineFrom = Math.max(physical, Math.min(block.from, from))
    let leftTicks = 0,
      rightTicks = 0
    if (code?.width) {
      for (
        let at = from - 1;
        at >= code.from && this.text(at, at + 1) === '`';
        at--
      ) {
        leftTicks++
        if (this.#tick()) yield
      }
      for (let at = to; at < code.to && this.text(at, at + 1) === '`'; at++) {
        rightTicks++
        if (this.#tick()) yield
      }
    }
    return {
      lineFrom,
      linePrefix: this.text(lineFrom, Math.min(from, lineFrom + 12)),
      after: this.text(firstTo, Math.min(this.length, firstTo + 34)),
      block,
      code: code ? { ...code, leftTicks, rightTicks } : null,
    }
  }
}
