import { type Tree, TreeFragment } from '@lezer/common'
import {
  boundaryRecords,
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

/** A metadata-only index of the canonical normalized rope, using the formatted view's scanner. */
export class MarkdownBoundaryIndex {
  readonly key: string
  readonly parser: ChunkedMarkdownParser
  private parse: ChunkedPartialParse
  private tree: Tree | null = null
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
      sourceParserInput(source),
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
    return this.tree !== null
  }
  apply(prepared: PreparedSourceOperation) {
    const tree = this.tree ?? this.parse.snapshot()
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
    const fragments = TreeFragment.applyChanges(
      TreeFragment.addTree(tree),
      changes,
    )
    this.source = prepared.after
    this.tree = null
    this.parse = this.parser.startBoundaryParse(
      sourceParserInput(prepared.after),
      fragments,
      this.config.prefix,
    )
  }
  *pages() {
    const records = this.records()
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
      yield { records: page, done: !!next.done }
    }
    if (!this.length) yield { records: [], done: true }
  }
  records() {
    if (!this.tree) throw new Error('Could not read a document worker reply.')
    return boundaryRecords(this.tree)
  }
}
