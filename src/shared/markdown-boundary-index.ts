import { type Input, type Tree, TreeFragment } from '@lezer/common'
import {
  boundaryRecords,
  boundaryStart,
  ChunkedMarkdownParser,
  type ChunkedMarkdownProbe,
  type ChunkedPartialParse,
} from './chunked-markdown.ts'
import {
  type BoundaryConfig,
  boundaryKey,
  boundaryParser,
} from './markdown-boundary-syntax.ts'
import type {
  PreparedSourceOperation,
  SourceSnapshot,
} from './source-buffer.ts'
import { sourceParserInput } from './source-parser.ts'
import { editorChangesFromSource } from './source-projection.ts'

/** Cache normalized ranges so short lines do not each seek the rope. */
function boundaryInput(source: SourceSnapshot): Input {
  const input = sourceParserInput(source)
  let from = -1,
    text = ''
  const read = (start: number, end: number) => {
    if (end - start > 16384) return input.read(start, end)
    if (start < from || end > from + text.length) {
      from = Math.max(0, start - 4096)
      text = input.read(
        from,
        Math.min(input.length, Math.max(end, from + 16384)),
      )
    }
    return text.slice(start - from, end - from)
  }
  return {
    length: input.length,
    lineChunks: false,
    chunk: (start) => read(start, Math.min(input.length, start + 4096)),
    read,
  }
}

/** A metadata-only index of the canonical normalized rope, using the formatted view's scanner. */
export class MarkdownBoundaryIndex {
  readonly key: string
  readonly parser: ChunkedMarkdownParser
  private parse: ChunkedPartialParse
  private tree: Tree | null = null
  private fragments: readonly TreeFragment[] = []
  private advanced = false
  private source: SourceSnapshot
  readonly config: BoundaryConfig
  constructor(
    source: SourceSnapshot,
    config: BoundaryConfig,
    probe?: ChunkedMarkdownProbe,
  ) {
    this.config = config
    const base = boundaryParser(config)
    if (!base || config.prefix > source.normalizedLength)
      throw new Error('Could not read a document worker reply.')
    this.key = boundaryKey(config)
    this.parser = new ChunkedMarkdownParser(base, base, {
      chunkSize: config.chunkSize,
      groupSize: config.groupSize,
      giantBlock: config.giantBlock,
      opaque: new Set(config.opaque),
      ...(probe ? { probe } : {}),
    })
    this.source = source
    this.parse = this.parser.startBoundaryParse(
      boundaryInput(source),
      [],
      config.prefix,
    )
  }
  get version() {
    return this.source.version
  }
  get length() {
    return this.source.normalizedLength
  }
  advance() {
    this.tree = this.parse.advance()
    this.advanced = true
    return this.tree !== null
  }
  apply(prepared: PreparedSourceOperation) {
    const tree = this.tree ?? (this.advanced ? this.parse.snapshot() : null)
    let offset = 0
    const changes = editorChangesFromSource(
      prepared.before,
      prepared.operation.changes,
    ).map((change) => {
      const result = {
        fromA: change.from,
        toA: change.to,
        fromB: change.from + offset,
        toB: change.from + offset + change.insert.length,
      }
      offset += change.insert.length - (change.to - change.from)
      return result
    })
    // An unadvanced replacement parse has no verified progress to retain.
    this.fragments = TreeFragment.applyChanges(
      tree ? TreeFragment.addTree(tree) : this.fragments,
      changes,
    )
    this.source = prepared.after
    this.tree = null
    this.advanced = false
    this.parse = this.parser.startBoundaryParse(
      boundaryInput(prepared.after),
      this.fragments,
      this.config.prefix,
    )
  }
  *pages(from = 0) {
    const records = this.records(from)
    const start = boundaryStart(this.tree!, from)
    let next = records.next()
    while (!next.done) {
      const page = []
      let units = 0
      while (!next.done && page.length < 128) {
        const size = JSON.stringify(next.value).length
        if (units + size > 16384 && page.length) break
        units += size
        page.push(next.value)
        next = records.next()
      }
      yield { from: start, records: page, done: !!next.done }
    }
    if (!this.length) yield { from: 0, records: [], done: true }
  }
  records(from = 0) {
    if (!this.tree) throw new Error('Could not read a document worker reply.')
    return boundaryRecords(this.tree, from)
  }
}
