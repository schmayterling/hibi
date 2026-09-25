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
import { noteTags } from '../shared/note-tags.ts'
import type { WorkspacePage } from '../shared/workspace'

type References = ReturnType<typeof noteReferences>
type DocumentLinks = {
  markdown: string
  references: References
  referenceComplete: boolean
  targets: ReadonlySet<string>
  tags?: readonly string[]
  properties?: ReturnType<typeof noteProperties>
  headings?: ReturnType<typeof noteHeadings>
}

export interface ReferencePage {
  readonly items: readonly string[]
  readonly hasMore: boolean
  readonly nextOffset: number
}

export interface TextSearchPosition {
  readonly pathIndex: number
  readonly sourceOffset: number
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
    this.complete = true
  }

  apply(
    target: WorkspaceTarget,
    pages: readonly WorkspacePage[],
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
      if (cached?.markdown === page.markdown) {
        next.set(page.path, cached)
        continue
      }
      const markdownSource = isMarkdownDocument(page.path)
      const referenceComplete =
        !markdownSource || metadataFrontmatterWithinLimit(page.markdown)
      next.set(page.path, {
        markdown: page.markdown,
        references:
          markdownSource && referenceComplete
            ? this.parse(page.markdown)
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
    if (pathsChanged || changed.size) this.tagPaths = null
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
      (document) => document.referenceComplete,
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

  links(path: string, offset: number, limit: number): ReferencePage {
    return this.page(this.documents.get(path)?.targets ?? [], offset, limit)
  }

  backlinks(path: string, offset: number, limit: number): ReferencePage {
    return this.page(this.reverse.get(path) ?? [], offset, limit)
  }

  tagged(tag: string, offset: number, limit: number): ReferencePage {
    if (!this.tagPaths) {
      const nextTags = new Map<string, Set<string>>()
      for (const [path, document] of this.documents) {
        if (!isMarkdownDocument(path) || !document.referenceComplete) continue
        document.tags ??= noteTags(document.markdown)
        for (const name of document.tags) {
          let paths = nextTags.get(name)
          if (!paths) {
            paths = new Set()
            nextTags.set(name, paths)
          }
          paths.add(path)
        }
      }
      this.tagPaths = nextTags
    }
    return this.page(this.tagPaths.get(tag) ?? [], offset, limit)
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
      document.properties ??= noteProperties(document.markdown)
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
    document.headings ??= noteHeadings(document.markdown)
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
      complete: document.headings.complete,
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
