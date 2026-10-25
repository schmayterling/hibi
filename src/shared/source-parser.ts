import {
  type Input,
  type Parser,
  type PartialParse,
  type Tree,
  TreeFragment,
} from '@lezer/common'
import {
  acceptedStorageChange,
  type PreparedSourceOperation,
  type SourceSnapshot,
  type SourceStorageChange,
} from './source-buffer.ts'
import { safePosition } from './source-operations.ts'
import {
  editorChangesFromSource,
  normalizedSource,
} from './source-projection.ts'

export type ParserWork = {
  readCalls: number
  readUnits: number
  maximumRead: number
  fragmentVisits: number
  advances: number
  longestAdvanceMs: number
}
const emptyWork = (): ParserWork => ({
  readCalls: 0,
  readUnits: 0,
  maximumRead: 0,
  fragmentVisits: 0,
  advances: 0,
  longestAdvanceMs: 0,
})

/** Lezer sees normalized UTF-16 coordinates. Every chunk starts exactly at from. */
export function sourceParserInput(
  source: SourceSnapshot,
  work = emptyWork(),
): Input {
  const length = source.normalizedLength
  let cachedFrom = -1,
    cachedTo = -1,
    lineTo = -1,
    text = ''
  const range = (from: number, to: number) => {
    if (!safePosition(from) || !safePosition(to) || to < from || to > length)
      throw new Error('Parser input range is outside its source snapshot.')
  }
  const lineAt = (from: number) => {
    if (
      from >= cachedFrom &&
      (from < cachedTo || (from === length && lineTo === length))
    )
      return
    const raw = source.editorToRaw(from),
      line = raw === null ? null : source.lineAt(raw)
    if (!line)
      throw new Error('Parser input range is outside its source snapshot.')
    cachedFrom = source.rawToEditor(line.from)!
    // Lezer may scan a fragment boundary backwards one character at a time.
    // Keep that work on this snapshot's normalized line instead of the piece table.
    text = normalizedSource(source.sliceRaw(line.from, line.to))
    lineTo = cachedFrom + text.length
    if (line.number < source.lineCount) text += '\n'
    cachedTo = cachedFrom + text.length
  }
  const read = (from: number, to: number) => {
    range(from, to)
    work.readCalls++
    work.readUnits += to - from
    work.maximumRead = Math.max(work.maximumRead, to - from)
    // The unit before a cached line start is its normalized line break.
    if (from === cachedFrom - 1 && to === cachedFrom) return '\n'
    lineAt(from)
    if (to <= cachedTo) return text.slice(from - cachedFrom, to - cachedFrom)
    const rawFrom = source.editorToRaw(from),
      rawTo = source.editorToRaw(to)
    if (rawFrom === null || rawTo === null)
      throw new Error('Parser input range is outside its source snapshot.')
    return normalizedSource(source.sliceRaw(rawFrom, rawTo))
  }
  return Object.freeze({
    length,
    lineChunks: true,
    chunk: (from: number) => {
      range(from, from)
      lineAt(from)
      // ponytail: Markdown scanner needs whole physical lines. One long line can
      // allocate its full length; bounded chunks need scanner support for split lines.
      return read(from, from === lineTo && from < length ? from + 1 : lineTo)
    },
    read,
  })
}

export type SourceParseState = Readonly<{
  source: SourceSnapshot
  dialect: string
  complete: boolean
  tree: Tree | null
}>

/** Supported incremental-tree reuse, not a promise of serializable parser checkpoints. */
export class SourceParserSession {
  #parser: Parser
  #state: SourceParseState
  #fragments: readonly TreeFragment[] = []
  #pending: PartialParse | null = null
  #work = emptyWork()
  #disposed = false
  readonly #maximumFragments: number

  constructor(
    source: SourceSnapshot,
    parser: Parser,
    dialect: string,
    maximumFragments = 256,
  ) {
    if (
      !dialect ||
      !Number.isSafeInteger(maximumFragments) ||
      maximumFragments < 1 ||
      maximumFragments > 4096
    )
      throw new Error('Invalid parser session configuration.')
    this.#parser = parser
    this.#maximumFragments = maximumFragments
    this.#state = Object.freeze({
      source,
      dialect,
      complete: false,
      tree: null,
    })
  }
  state = () => this.#state
  adoptStorage(change: SourceStorageChange) {
    if (
      this.#disposed ||
      !acceptedStorageChange(change) ||
      change.before !== this.#state.source
    )
      throw new Error('Parser storage change is stale or untrusted.')
    this.#state = Object.freeze({ ...this.#state, source: change.after })
  }
  counters(reset = false) {
    const result = { ...this.#work, fragments: this.#fragments.length }
    if (reset) Object.assign(this.#work, emptyWork())
    return result
  }
  apply(prepared: PreparedSourceOperation) {
    if (this.#disposed || prepared.before !== this.#state.source)
      throw new Error('Parser source operation is stale.')
    let shift = 0
    const ranges = editorChangesFromSource(
      prepared.before,
      prepared.operation.changes,
    ).map((change) => {
      const range = {
        fromA: change.from,
        toA: change.to,
        fromB: change.from + shift,
        toB: change.from + shift + change.insert.length,
      }
      shift += change.insert.length - (change.to - change.from)
      return range
    })
    this.#work.fragmentVisits += this.#fragments.length
    const fragments = TreeFragment.applyChanges(this.#fragments, ranges)
    // A burst may outgrow useful reuse. Release that table; a background full
    // parse is preferable to retaining an unbounded edit-fragment directory.
    this.#fragments =
      fragments.length <= this.#maximumFragments ? fragments : []
    this.#pending = null
    this.#state = Object.freeze({
      ...this.#state,
      source: prepared.after,
      tree: null,
      complete: false,
    })
  }
  reconfigure(parser: Parser, dialect: string) {
    if (this.#disposed || !dialect)
      throw new Error('Parser session is disposed or has no dialect.')
    if (parser === this.#parser && dialect === this.#state.dialect) return
    this.#parser = parser
    this.#fragments = []
    this.#pending = null
    this.#state = Object.freeze({
      source: this.#state.source,
      dialect,
      complete: false,
      tree: null,
    })
  }
  /** One indivisible parser step. Schedule away from input; measure its real duration. */
  advance() {
    if (this.#disposed) throw new Error('Parser session is disposed.')
    if (this.#state.complete) return this.#state
    this.#pending ??= this.#parser.startParse(
      sourceParserInput(this.#state.source, this.#work),
      this.#fragments,
    )
    const start = performance.now()
    const tree = this.#pending.advance()
    this.#work.advances++
    this.#work.longestAdvanceMs = Math.max(
      this.#work.longestAdvanceMs,
      performance.now() - start,
    )
    if (tree) {
      if (
        this.#pending.stoppedAt !== null ||
        tree.length !== this.#state.source.normalizedLength
      )
        throw new Error(
          'An incomplete parser tree cannot be published as complete.',
        )
      this.#state = Object.freeze({ ...this.#state, tree, complete: true })
      this.#fragments = TreeFragment.addTree(tree)
      this.#pending = null
    }
    return this.#state
  }
  dispose() {
    this.#disposed = true
    this.#pending = null
    this.#fragments = []
    this.#state = Object.freeze({ ...this.#state, tree: null, complete: false })
  }
}
