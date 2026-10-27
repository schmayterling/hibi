import { type Input, type Tree, TreeFragment } from '@lezer/common'
import {
  boundaryRecords,
  boundaryRejoin,
  boundaryStart,
  ChunkedMarkdownParser,
  type ChunkedMarkdownProbe,
  type ChunkedPartialParse,
  unindexedFrom,
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
import { editorChangesFromSource, mappedPrefix } from './source-projection.ts'

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
  private retained: {
    version: number
    fragments: readonly TreeFragment[]
  } | null = null
  config: BoundaryConfig
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
    let fragments = this.fragments
    if (this.tree) fragments = TreeFragment.addTree(this.tree)
    else if (this.advanced) {
      const tree = this.parse.snapshot()
      const verified = unindexedFrom(tree) ?? tree.length
      const suffix = this.retained
        ? fragments.flatMap((fragment) =>
            fragment.to <= verified
              ? []
              : fragment.from >= verified
                ? [fragment]
                : [
                    new TreeFragment(
                      verified,
                      fragment.to,
                      fragment.tree,
                      fragment.offset,
                      true,
                      fragment.openEnd,
                    ),
                  ],
          )
        : []
      // Only joining a saved suffix needs a cut; a cold scan keeps its full snapshot.
      fragments = suffix.length
        ? [new TreeFragment(0, verified, tree, 0, false, true), ...suffix]
        : TreeFragment.addTree(tree)
    }
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
    const prefix = mappedPrefix(this.config.prefix, changes)
    if (prefix !== null) this.config = { ...this.config, prefix }
    if (this.tree && unindexedFrom(this.tree) === null)
      this.retained = {
        version: this.version,
        fragments: TreeFragment.addTree(this.tree),
      }
    if (this.retained)
      this.retained = {
        version: this.retained.version,
        fragments: TreeFragment.applyChanges(this.retained.fragments, changes),
      }
    this.fragments = TreeFragment.applyChanges(fragments, changes)
    this.source = prepared.after
    this.tree = null
    this.advanced = false
    this.parse = this.parser.startBoundaryParse(
      boundaryInput(prepared.after),
      this.fragments,
      this.config.prefix,
    )
  }
  *pages(from = 0, baseVersion?: number) {
    if (!this.tree) throw new Error('Could not read a document worker reply.')
    const start = boundaryStart(this.tree, from)
    const retained =
      baseVersion === this.retained?.version
        ? this.retained?.fragments.at(-1)
        : undefined
    const to = retained
      ? Math.max(start, boundaryRejoin(this.tree, retained))
      : this.length
    const end = to < this.length ? { to } : {}
    const records = boundaryRecords(this.tree, from, to)
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
      yield { from: start, ...end, records: page, done: !!next.done }
    }
    if (!this.length || start === to)
      yield { from: start, ...end, records: [], done: true }
  }
  records(from = 0) {
    if (!this.tree) throw new Error('Could not read a document worker reply.')
    return boundaryRecords(this.tree, from)
  }
}
