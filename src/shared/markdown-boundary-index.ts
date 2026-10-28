import { type Tree, TreeFragment } from '@lezer/common'
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
import {
  type CodeExtentInput,
  MarkdownCodeExtents,
} from './markdown-code-extents.ts'
import type {
  PreparedSourceOperation,
  SourceSnapshot,
} from './source-buffer.ts'
import { sourceParserInput } from './source-parser.ts'
import { editorChangesFromSource, mappedPrefix } from './source-projection.ts'

/** Cache normalized ranges so short lines do not each seek the rope. */
function boundaryInput(source: SourceSnapshot): CodeExtentInput {
  const input = sourceParserInput(source)
  let from = -1,
    text = ''
  let breaks: number[] | null = null
  let anchor: { number: number; from: number } | null = null
  const read = (start: number, end: number) => {
    if (end - start > 16384) return input.read(start, end)
    if (start < from || end > from + text.length) {
      from = Math.max(0, start - 4096)
      breaks = null
      anchor = null
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
    // Geometry reuses the scanner's normalized window. Rope line seeks occur
    // once per window, not several times for every code block and CodeText.
    line: (at) => {
      read(at, at)
      if (!breaks) {
        breaks = []
        for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1))
          breaks.push(from + i)
      }
      if (!anchor) {
        const line = source.lineAt(source.editorToRaw(from)!)!
        anchor = { number: line.number, from: source.rawToEditor(line.from)! }
      }
      let low = 0,
        high = breaks.length
      while (low < high) {
        const mid = (low + high) >>> 1
        if (breaks[mid]! < at) low = mid + 1
        else high = mid
      }
      const start = low ? breaks[low - 1]! + 1 : anchor.from
      const end =
        breaks[low] ??
        (from + text.length === input.length ? input.length : null)
      if (start >= from && end !== null)
        return {
          number: anchor.number + low,
          from: start,
          to: end,
          next: Math.min(input.length, end + 1),
        }
      const line = source.lineAt(source.editorToRaw(at)!)!
      const to = source.rawToEditor(line.to)!
      return {
        number: line.number,
        from: source.rawToEditor(line.from)!,
        to,
        next: Math.min(input.length, to + 1),
      }
    },
    chunk: (start) => {
      let end = Math.min(input.length, start + 4096)
      const first = read(start, end)
      if (first.includes('\n') || end === input.length) return first
      // Markdown's line reader treats a chunk without a newline as a whole line.
      const parts = [first]
      while (end < input.length) {
        const next = Math.min(input.length, end + 4096)
        const part = read(end, next)
        parts.push(part)
        end = next
        if (part.includes('\n')) break
      }
      return parts.join('')
    },
    read,
  }
}

/** A metadata-only index of the canonical normalized rope, using the formatted view's scanner. */
export class MarkdownBoundaryIndex {
  readonly key: string
  readonly parser: ChunkedMarkdownParser
  private code: MarkdownCodeExtents | null
  private codeCoverage: boolean
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
    codeCoverage = false,
  ) {
    this.config = config
    const base = boundaryParser(config)
    if (!base || config.prefix > source.normalizedLength)
      throw new Error('Could not read a document worker reply.')
    this.key = boundaryKey(config)
    const input = boundaryInput(source)
    this.code = codeCoverage ? new MarkdownCodeExtents(source, input) : null
    this.codeCoverage = codeCoverage
    this.parser = new ChunkedMarkdownParser(base, base, {
      chunkSize: config.chunkSize,
      groupSize: config.groupSize,
      giantBlock: config.giantBlock,
      opaque: new Set(config.opaque),
      ...(this.code ? { codeBlocks: this.code } : {}),
      ...(probe ? { probe } : {}),
    })
    this.source = source
    this.parse = this.parser.startBoundaryParse(input, [], config.prefix)
  }
  setCodeCoverage(enabled: boolean) {
    if (enabled === this.codeCoverage) return
    this.codeCoverage = enabled
    delete this.parser.options.codeBlocks
    if (!enabled) {
      this.code = null
      return
    }
    const input = boundaryInput(this.source)
    this.code = new MarkdownCodeExtents(this.source, input)
    this.parser.options.codeBlocks = this.code
    this.tree = null
    this.advanced = false
    this.fragments = []
    this.parse = this.parser.startBoundaryParse(input, [], this.config.prefix)
  }
  acknowledgeCode(version: number) {
    if (this.tree) this.code?.acknowledge(version)
  }
  get codeWork() {
    return (
      this.code?.work ?? {
        readUnits: 0,
        maximumRead: 0,
        maximumWindow: 0,
        recordsWritten: 0,
        widthRuns: 0,
        reuseMisses: 0,
      }
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
    if (this.tree) this.code?.finish()
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
    const input = boundaryInput(prepared.after)
    if (this.code) {
      this.code.apply(prepared.before, prepared.after, changes, input)
      if (this.config.prefix) this.code.clear(0, this.config.prefix)
    }
    this.source = prepared.after
    this.tree = null
    this.advanced = false
    this.parse = this.parser.startBoundaryParse(
      input,
      this.fragments,
      this.config.prefix,
    )
  }
  *pages(
    from = 0,
    baseVersion?: number,
    codeVersion: number | null | undefined = baseVersion,
    codeOnly = false,
    includeCode = true,
  ) {
    if (!this.tree) throw new Error('Could not read a document worker reply.')
    const start = codeOnly ? 0 : boundaryStart(this.tree, from)
    const retained =
      !codeOnly && baseVersion === this.retained?.version
        ? this.retained?.fragments.at(-1)
        : undefined
    const to = retained
      ? Math.max(start, boundaryRejoin(this.tree, retained))
      : this.length
    const end = to < this.length ? { to } : {}
    const records = codeOnly
      ? [].values()
      : boundaryRecords(this.tree, from, to)
    // Geometry coverage is independent of the syntax repair suffix.
    const code =
      includeCode && this.code
        ? this.code.pages(
            0,
            this.length,
            typeof codeVersion === 'number' &&
              codeVersion === this.code.baseVersion,
          )
        : [].values()
    let next = records.next(),
      coverage = code.next()
    if (next.done && coverage.done) {
      yield { from: start, ...end, records: [], done: true }
      return
    }
    while (!next.done) {
      const page = []
      const shared = !coverage.done && coverage.value.records.length > 0
      let units = 0
      while (!next.done && page.length < (shared ? 64 : 128)) {
        const size = JSON.stringify(next.value).length
        if (units + size > (shared ? 8192 : 16384) && page.length) break
        units += size
        page.push(next.value)
        next = records.next()
      }
      if (
        !coverage.done &&
        page.length + coverage.value.records.length <= 128 &&
        units + JSON.stringify(coverage.value).length <= 16384
      ) {
        const { done: _done, ...patch } = coverage.value
        coverage = code.next()
        yield {
          from: start,
          ...end,
          records: page,
          code: patch,
          done: !!next.done && !!coverage.done,
        }
      } else
        yield {
          from: start,
          ...end,
          records: page,
          done: !!next.done && !!coverage.done,
        }
    }
    while (!coverage.done) {
      const { done: _done, ...patch } = coverage.value
      coverage = code.next()
      yield {
        from: start,
        ...end,
        records: [],
        code: patch,
        done: !!coverage.done,
      }
    }
  }
  records(from = 0) {
    if (!this.tree) throw new Error('Could not read a document worker reply.')
    return boundaryRecords(this.tree, from)
  }
}
