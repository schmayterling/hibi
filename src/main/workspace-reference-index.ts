import { isMarkdownDocument } from '../shared/document-types.ts'
import type { WorkspaceTarget } from '../shared/foundation-contracts'
import {
  localTarget,
  noteBasenames,
  noteReferences,
  noteTargets,
  wikiTarget,
} from '../shared/note-links.ts'
import {
  metadataFrontmatterWithinLimit,
  type NoteHeading,
  noteHeadings,
  noteProperties,
  type PropertyScalar,
} from '../shared/note-metadata.ts'
import { defaultNoteSyntax } from '../shared/note-syntax.ts'
import { noteTags } from '../shared/note-tags.ts'
import type { WorkspacePage } from '../shared/workspace'
import type {
  WorkspaceGraphItem,
  WorkspaceTagSummary,
} from '../shared/workspace-query.ts'
import type { PageSyntax } from './workspace-syntax.ts'

type References = ReturnType<typeof noteReferences>
type DocumentLinks = {
  markdown: string
  syntax: PageSyntax['settings']
  syntaxKey: string
  syntaxComplete: boolean
  unsupportedSyntax: boolean
  references: References
  referenceComplete: boolean
  targets: ReadonlySet<string>
  tags?: readonly string[]
  properties?: ReturnType<typeof noteProperties>
  headings?: ReturnType<typeof noteHeadings>
}

const defaultPageSyntax = (): PageSyntax => ({
  settings: defaultNoteSyntax,
  key: 'gfm+wikilinks+hashtags',
  unsupported: false,
  complete: true,
})

export interface ReferencePage {
  readonly items: readonly string[]
  readonly hasMore: boolean
  readonly nextOffset: number
}

export interface TextSearchPosition {
  readonly pathIndex: number
  readonly sourceOffset: number
}

export interface GraphPosition {
  readonly pathIndex: number
  readonly targetIndex: number
  readonly nodeEmitted: boolean
  readonly emitted: number
}

/** Parsed references share the existing workspace page cache; no filesystem scan. */
export class WorkspaceReferenceIndex {
  private target: WorkspaceTarget | null = null
  private documents = new Map<string, DocumentLinks>()
  private reverse = new Map<string, Set<string>>()
  private paths = new Set<string>()
  private sortedPaths: string[] = []
  private basenames = new Map<string, string[]>()
  private tagPaths: Map<string, Set<string>> | null = null
  private tagCapReached = false
  private complete = true
  private readonly parse: typeof noteReferences

  constructor(parse = noteReferences) {
    this.parse = parse
  }

  clear(): void {
    this.target = null
    this.documents = new Map()
    this.reverse = new Map()
    this.paths = new Set()
    this.sortedPaths = []
    this.basenames = new Map()
    this.tagPaths = null
    this.tagCapReached = false
    this.complete = true
  }

  apply(
    target: WorkspaceTarget,
    pages: readonly WorkspacePage[],
    pageSyntax: (page: WorkspacePage) => PageSyntax = defaultPageSyntax,
  ): {
    parsed: number
    resolved: number
  } {
    if (pages.length > 2000)
      throw new Error('Workspace metadata exceeds 2,000 documents.')
    const sameWorkspace =
      this.target?.workspaceId === target.workspaceId &&
      this.target.workspaceGeneration === target.workspaceGeneration
    const previous = sameWorkspace
      ? this.documents
      : new Map<string, DocumentLinks>()
    const next = new Map<string, DocumentLinks>()
    const changed = new Set<string>()
    let parsed = 0
    for (const page of pages) {
      const cached = previous.get(page.path)
      const syntax = pageSyntax(page)
      const markdownSource = isMarkdownDocument(page.path)
      const syntaxComplete = !markdownSource || syntax.complete
      const unsupportedSyntax = markdownSource && syntax.unsupported
      if (
        cached?.markdown === page.markdown &&
        cached.syntaxKey === syntax.key
      ) {
        next.set(
          page.path,
          cached.syntaxComplete === syntaxComplete &&
            cached.unsupportedSyntax === unsupportedSyntax
            ? cached
            : {
                ...cached,
                syntaxComplete,
                unsupportedSyntax,
              },
        )
        continue
      }
      const referenceComplete =
        !markdownSource ||
        !syntax.settings.frontmatter ||
        metadataFrontmatterWithinLimit(page.markdown)
      next.set(page.path, {
        markdown: page.markdown,
        syntax: syntax.settings,
        syntaxKey: syntax.key,
        syntaxComplete,
        unsupportedSyntax,
        references:
          markdownSource && referenceComplete
            ? this.parse(page.markdown, syntax.settings)
            : { links: [], wikilinks: [] },
        referenceComplete,
        targets: new Set(),
      })
      changed.add(page.path)
      if (markdownSource && referenceComplete) parsed++
    }
    const pathsChanged =
      !sameWorkspace ||
      previous.size !== next.size ||
      [...next.keys()].some((path) => !previous.has(path))
    if (pathsChanged || changed.size) {
      this.tagPaths = null
      this.tagCapReached = false
    }
    const paths = new Set(next.keys())
    const basenames = pathsChanged ? noteBasenames(paths) : this.basenames
    const toResolve = pathsChanged ? [...next.keys()] : [...changed]
    const resolved = new Map<string, ReadonlySet<string>>()
    for (const path of toResolve) {
      const document = next.get(path)
      if (!document) continue
      resolved.set(
        path,
        new Set(
          noteTargets(
            document.markdown,
            path,
            paths,
            document.references,
            basenames,
          ),
        ),
      )
    }
    if (pathsChanged) {
      this.reverse = new Map()
      for (const [path, document] of next) {
        const targets = resolved.get(path) ?? new Set<string>()
        document.targets = targets
        for (const targetPath of targets) this.addReverse(targetPath, path)
      }
    } else {
      for (const path of changed) {
        for (const oldTarget of previous.get(path)?.targets ?? [])
          this.reverse.get(oldTarget)?.delete(path)
        const document = next.get(path)
        if (!document) continue
        const targets = resolved.get(path) ?? new Set<string>()
        document.targets = targets
        for (const targetPath of targets) this.addReverse(targetPath, path)
      }
    }
    this.documents = next
    this.complete = [...next.values()].every(
      (document) => document.referenceComplete && document.syntaxComplete,
    )
    this.paths = paths
    if (pathsChanged)
      this.sortedPaths = [...paths].sort((a, b) => a.localeCompare(b))
    this.basenames = basenames
    this.target = target
    return { parsed, resolved: toResolve.length }
  }

  has(path: string): boolean {
    return this.documents.has(path)
  }

  isComplete(): boolean {
    return this.complete
  }

  hasUnsupportedSyntax(): boolean {
    return [...this.documents.values()].some(
      (document) => document.unsupportedSyntax,
    )
  }

  links(path: string, offset: number, limit: number): ReferencePage {
    return this.page(this.documents.get(path)?.targets ?? [], offset, limit)
  }

  backlinks(path: string, offset: number, limit: number): ReferencePage {
    return this.page(this.reverse.get(path) ?? [], offset, limit)
  }

  tagged(tag: string, offset: number, limit: number): ReferencePage {
    this.ensureTags()
    const indexed = this.tagPaths?.get(tag)
    if (indexed) return this.page(indexed, offset, limit)
    if (!this.tagCapReached) return this.page([], offset, limit)
    return this.page(
      [...this.documents].flatMap(([path, document]) =>
        document.tags?.includes(tag) ? [path] : [],
      ),
      offset,
      limit,
    )
  }

  tags(
    offset: number,
    limit: number,
    prefix?: string,
  ): {
    items: readonly WorkspaceTagSummary[]
    hasMore: boolean
    nextOffset: number
    capReached: boolean
  } {
    this.ensureTags()
    const sorted = [...(this.tagPaths ?? [])]
      .filter(([tag]) => prefix === undefined || tag.startsWith(prefix))
      .sort(([a, aPaths], [b, bPaths]) =>
        prefix === undefined
          ? a.localeCompare(b)
          : bPaths.size - aPaths.size || (a < b ? -1 : a > b ? 1 : 0),
      )
    const items: WorkspaceTagSummary[] = []
    let bytes = 0
    for (
      let index = offset;
      index < sorted.length && items.length < limit;
      index++
    ) {
      const entry = sorted[index]
      if (!entry) break
      const size = Buffer.byteLength(entry[0]) + 8
      if (bytes + size > 32 * 1024) break
      items.push({ tag: entry[0], count: entry[1].size })
      bytes += size
    }
    const nextOffset = offset + items.length
    return {
      items,
      hasMore: nextOffset < sorted.length,
      nextOffset,
      capReached: this.tagCapReached,
    }
  }

  /** Resume graph enumeration without rescanning links or returning note source. */
  graph(
    start: GraphPosition,
    limit: number,
  ): {
    items: readonly WorkspaceGraphItem[]
    position: GraphPosition
    hasMore: boolean
    capReached: boolean
  } {
    const items: WorkspaceGraphItem[] = []
    let { pathIndex, targetIndex, nodeEmitted, emitted } = start
    let bytes = 0
    let targetsPath = ''
    let targets: string[] = []
    while (
      pathIndex < this.sortedPaths.length &&
      items.length < limit &&
      emitted < 10_000
    ) {
      const path = this.sortedPaths[pathIndex]
      if (!path) break
      let item: WorkspaceGraphItem
      if (!nodeEmitted) item = { kind: 'node', path }
      else {
        if (targetsPath !== path) {
          targetsPath = path
          targets = [...(this.documents.get(path)?.targets ?? [])].sort(
            (a, b) => a.localeCompare(b),
          )
        }
        const target = targets[targetIndex]
        if (!target) {
          pathIndex++
          targetIndex = 0
          nodeEmitted = false
          continue
        }
        item = { kind: 'edge', source: path, target }
      }
      const size =
        item.kind === 'node'
          ? Buffer.byteLength(item.path)
          : Buffer.byteLength(item.source) + Buffer.byteLength(item.target)
      if (bytes + size > 32 * 1024) break
      items.push(item)
      bytes += size
      emitted++
      if (item.kind === 'node') nodeEmitted = true
      else targetIndex++
    }
    const hasMore = pathIndex < this.sortedPaths.length && emitted < 10_000
    return {
      items,
      position: { pathIndex, targetIndex, nodeEmitted, emitted },
      hasMore,
      capReached: pathIndex < this.sortedPaths.length && emitted >= 10_000,
    }
  }

  private ensureTags(): void {
    if (this.tagPaths) return
    const next = new Map<string, Set<string>>()
    for (const [path, document] of this.documents) {
      if (!isMarkdownDocument(path) || !document.referenceComplete) continue
      document.tags ??= noteTags(document.markdown, document.syntax)
      for (const name of document.tags) {
        if (name.length > 128) {
          this.tagCapReached = true
          continue
        }
        let paths = next.get(name)
        if (!paths) {
          if (next.size >= 2000) {
            this.tagCapReached = true
            continue
          }
          paths = new Set()
          next.set(name, paths)
        }
        paths.add(path)
      }
    }
    this.tagPaths = next
  }

  property(
    key: string,
    value: PropertyScalar,
    offset: number,
    limit: number,
  ): ReferencePage & { complete: boolean } {
    const matches: string[] = []
    let complete = true
    for (const [path, document] of this.documents) {
      if (!isMarkdownDocument(path)) continue
      document.properties ??= noteProperties(document.markdown, document.syntax)
      if (!document.properties.complete) complete = false
      if (!Object.hasOwn(document.properties.values, key)) continue
      const found = document.properties.values[key]
      if (
        (Array.isArray(found) &&
          found.some((item) => Object.is(item, value))) ||
        Object.is(found, value)
      )
        matches.push(path)
    }
    return { ...this.page(matches, offset, limit), complete }
  }

  headings(
    path: string,
    offset: number,
    limit: number,
  ): {
    items: readonly NoteHeading[]
    hasMore: boolean
    nextOffset: number
    complete: boolean
  } {
    const document = this.documents.get(path)
    if (!document || !isMarkdownDocument(path))
      return { items: [], hasMore: false, nextOffset: offset, complete: true }
    document.headings ??= noteHeadings(document.markdown, document.syntax)
    const items: NoteHeading[] = []
    let bytes = 0
    for (
      let index = offset;
      index < document.headings.items.length && items.length < limit;
      index++
    ) {
      const heading = document.headings.items[index]
      if (!heading) break
      const size = Buffer.byteLength(heading.text)
      if (bytes + size > 32 * 1024) break
      items.push(heading)
      bytes += size
    }
    const nextOffset = offset + items.length
    return {
      items,
      hasMore: nextOffset < document.headings.items.length,
      nextOffset,
      complete: document.headings.complete && document.syntaxComplete,
    }
  }

  searchPaths(query: string, offset: number, limit: number): ReferencePage {
    const folded = query.toLocaleLowerCase()
    return this.page(
      [...this.paths].filter((path) =>
        path.toLocaleLowerCase().includes(folded),
      ),
      offset,
      limit,
    )
  }

  /** Scan at most one million source characters per call; cursor resumes long notes. */
  searchText(
    query: string,
    start: TextSearchPosition,
    limit: number,
  ): {
    items: readonly string[]
    position: TextSearchPosition
    hasMore: boolean
  } {
    const term = query.toLowerCase()
    const items: string[] = []
    let pathIndex = start.pathIndex
    let sourceOffset = start.sourceOffset
    let budget = 1024 * 1024
    let bytes = 0
    while (pathIndex < this.sortedPaths.length && items.length < limit) {
      const path = this.sortedPaths[pathIndex]
      const source = path ? (this.documents.get(path)?.markdown ?? '') : ''
      if (sourceOffset >= source.length) {
        pathIndex++
        sourceOffset = 0
        continue
      }
      if (!budget) break
      const length = Math.min(64 * 1024, budget, source.length - sourceOffset)
      const overlap = Math.max(0, sourceOffset - query.length * 4)
      const chunk = source.slice(overlap, sourceOffset + length)
      budget -= length
      if (chunk.toLowerCase().includes(term)) {
        const size = Buffer.byteLength(path ?? '')
        if (bytes + size > 32 * 1024) break
        if (path) items.push(path)
        bytes += size
        pathIndex++
        sourceOffset = 0
      } else {
        sourceOffset += length
        if (sourceOffset >= source.length) {
          pathIndex++
          sourceOffset = 0
        }
      }
    }
    return {
      items,
      position: { pathIndex, sourceOffset },
      hasMore: pathIndex < this.sortedPaths.length,
    }
  }

  resolve(
    from: string,
    href: string,
    kind: 'markdown' | 'wiki',
  ): string | null {
    return kind === 'wiki'
      ? wikiTarget(from, href, this.paths, this.basenames)
      : localTarget(from, href, this.paths)
  }

  private addReverse(target: string, source: string): void {
    let sources = this.reverse.get(target)
    if (!sources) {
      sources = new Set()
      this.reverse.set(target, sources)
    }
    sources.add(source)
  }

  private page(
    values: Iterable<string>,
    offset: number,
    limit: number,
  ): ReferencePage {
    const sorted = [...values].sort((a, b) => a.localeCompare(b))
    const items: string[] = []
    let bytes = 0
    for (
      let index = offset;
      index < sorted.length && items.length < limit;
      index++
    ) {
      const path = sorted[index]
      if (!path) break
      const size = Buffer.byteLength(path)
      if (bytes + size > 32 * 1024) break
      items.push(path)
      bytes += size
    }
    const nextOffset = offset + items.length
    return {
      items,
      hasMore: nextOffset < sorted.length,
      nextOffset,
    }
  }
}
