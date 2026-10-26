import { sortSteps } from '../shared/cooperative-sort.ts'
import { isMarkdownDocument } from '../shared/document-types.ts'
import type { WorkspaceTarget } from '../shared/foundation-contracts'
import {
  localTarget,
  noteReferences,
  resolveLocalTarget,
  resolveWikiTarget,
  wikiTarget,
} from '../shared/note-links.ts'
import type { PropertyScalar } from '../shared/note-metadata.ts'
import { defaultNoteSyntax } from '../shared/note-syntax.ts'
import type { WorkspacePage } from '../shared/workspace'
import type {
  WorkspaceGraphItem,
  WorkspaceTagSummary,
} from '../shared/workspace-query.ts'
import {
  parseWorkspaceMetadata,
  propertyIndexValue,
  sourceIndexVersion,
  type WorkspaceMetadataPage,
  type WorkspacePageMetadata,
} from './workspace-index-metadata.ts'
import type { PageSyntax } from './workspace-syntax.ts'

type DocumentLinks = Omit<WorkspacePageMetadata, 'headings'> & {
  version: string
  syntaxKey: string
  syntaxComplete: boolean
  unsupportedSyntax: boolean
  targets: ReadonlySet<string>
}

type ApplyResult = {
  parsed: number
  resolved: number
}

type CanCommit = () => boolean

const referenceMetadata = (metadata: WorkspacePageMetadata) => ({
  references: metadata.references,
  referenceComplete: metadata.referenceComplete,
  tags: metadata.tags,
  properties: metadata.properties,
})

const workSlice = 64
const workSliceMs = 4
const yieldToEventLoop = () =>
  new Promise<void>((resolve) => setImmediate(resolve))

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

export interface GraphPosition {
  readonly pathIndex: number
  readonly targetIndex: number
  readonly nodeEmitted: boolean
}

// A note's targets are sorted once per build; graph pages that resume inside
// a note with many links reuse the order instead of sorting it again.
const sortedTargets = new WeakMap<ReadonlySet<string>, readonly string[]>()

/** Parsed references share the existing workspace page cache; no filesystem scan. */
export class WorkspaceReferenceIndex {
  private target: WorkspaceTarget | null = null
  private documents = new Map<string, DocumentLinks>()
  private revision = 0
  private incompleteCount = 0
  private incompleteDocuments = new Set<string>()
  private unsupportedCount = 0
  private tagBuild: Promise<boolean> | undefined
  private reverse = new Map<string, Set<string>>()
  private paths = new Set<string>()
  private sortedPaths: string[] = []
  private basenames = new Map<string, string[]>()
  private tagPaths: Map<string, Set<string>> | null = null
  private complete = true
  private unsupported = false
  private sortedViews = new WeakMap<Iterable<string>, string[]>()
  private filteredViews = new Map<
    string,
    { paths: string[]; complete: boolean }
  >()
  private tagViews = new Map<string | undefined, [string, Set<string>][]>()
  private readonly parse: typeof noteReferences
  private readonly yieldTurn: () => Promise<void>

  constructor(parse = noteReferences, yieldTurn = yieldToEventLoop) {
    this.parse = parse
    this.yieldTurn = yieldTurn
  }

  clear(): void {
    this.revision++
    this.incompleteCount = 0
    this.incompleteDocuments.clear()
    this.unsupportedCount = 0
    this.tagBuild = undefined
    this.target = null
    this.documents = new Map()
    this.reverse = new Map()
    this.paths = new Set()
    this.sortedPaths = []
    this.basenames = new Map()
    this.tagPaths = null
    this.complete = true
    this.unsupported = false
    this.sortedViews = new WeakMap()
    this.filteredViews.clear()
    this.tagViews.clear()
  }

  apply(
    target: WorkspaceTarget,
    pages: readonly (WorkspacePage | WorkspaceMetadataPage)[],
    pageSyntax: (page: WorkspacePage) => PageSyntax = defaultPageSyntax,
  ): ApplyResult {
    const result = this.finish(this.applySteps(target, pages, pageSyntax))
    if (!result)
      throw new Error('Workspace metadata index changed during apply.')
    return result
  }

  /** Builds from a snapshot, yielding between bounded page batches, then publishes once. */
  async applyCooperatively(
    target: WorkspaceTarget,
    pages: readonly (WorkspacePage | WorkspaceMetadataPage)[],
    pageSyntax: (page: WorkspacePage) => PageSyntax = defaultPageSyntax,
    canCommit: CanCommit = () => true,
  ): Promise<ApplyResult | null> {
    return this.finishCooperatively(
      this.applySteps(target, pages, pageSyntax, canCommit),
      canCommit,
    )
  }

  /** Stream one derived page at a time; source text never enters the resident index. */
  async applyMetadataCooperatively(
    target: WorkspaceTarget,
    pages: AsyncIterable<WorkspaceMetadataPage>,
    canCommit: CanCommit = () => true,
  ): Promise<ApplyResult | null> {
    const snapshot = this.documents
    const revision = this.revision
    const collected: WorkspaceMetadataPage[] = []
    let started = performance.now()
    for await (const page of pages) {
      if (
        !canCommit() ||
        this.documents !== snapshot ||
        this.revision !== revision
      )
        return null
      collected.push(page)
      if (
        collected.length % workSlice === 0 ||
        performance.now() - started >= workSliceMs
      ) {
        await this.yieldTurn()
        if (
          !canCommit() ||
          this.documents !== snapshot ||
          this.revision !== revision
        )
          return null
        started = performance.now()
      }
    }
    if (
      !canCommit() ||
      this.documents !== snapshot ||
      this.revision !== revision
    )
      return null
    return this.applyCooperatively(target, collected, undefined, canCommit)
  }

  /** Existing paths publish only their changed metadata; untouched objects and views survive. */
  async applyDeltaCooperatively(
    target: WorkspaceTarget,
    pages: readonly WorkspaceMetadataPage[],
    canCommit: CanCommit = () => true,
  ): Promise<ApplyResult | null> {
    return this.finishCooperatively(
      this.deltaSteps(target, pages, canCommit),
      canCommit,
    )
  }

  private *deltaSteps(
    target: WorkspaceTarget,
    pages: readonly WorkspaceMetadataPage[],
    canCommit: CanCommit,
  ): Generator<void, ApplyResult | null> {
    if (
      this.target?.workspaceId !== target.workspaceId ||
      this.target.workspaceGeneration !== target.workspaceGeneration
    )
      return null
    const revision = this.revision
    const tags = this.tagPaths
    const updates = new Map<string, DocumentLinks>()
    const reverseChanges: [string, string, boolean][] = []
    const tagChanges: [string, string, boolean][] = []
    let incomplete = this.incompleteCount
    let unsupported = this.unsupportedCount
    let started = performance.now()
    let count = 0
    const pause = () =>
      ++count % workSlice === 0 || performance.now() - started >= workSliceMs
    for (const page of pages) {
      const previous = this.documents.get(page.path)
      if (!previous) return null
      const markdown = isMarkdownDocument(page.path)
      const syntaxComplete = !markdown || page.syntax.complete
      const unsupportedSyntax = markdown && page.syntax.unsupported
      if (
        previous.version === page.version &&
        previous.syntaxKey === page.syntax.key &&
        previous.syntaxComplete === syntaxComplete &&
        previous.unsupportedSyntax === unsupportedSyntax
      )
        continue
      const targets = new Set<string>()
      for (const [kind, hrefs] of [
        ['markdown', page.metadata.references.links],
        ['wiki', page.metadata.references.wikilinks],
      ] as const)
        for (const href of hrefs) {
          const path =
            kind === 'wiki'
              ? resolveWikiTarget(page.path, href, this.paths, this.basenames)
              : resolveLocalTarget(href, this.paths)
          if (path && path !== page.path) targets.add(path)
          if (pause()) {
            yield
            started = performance.now()
          }
        }
      for (const path of previous.targets) {
        if (!targets.has(path)) reverseChanges.push([path, page.path, false])
        if (pause()) {
          yield
          started = performance.now()
        }
      }
      for (const path of targets) {
        if (!previous.targets.has(path))
          reverseChanges.push([path, page.path, true])
        if (pause()) {
          yield
          started = performance.now()
        }
      }
      if (tags) {
        const oldTags = new Set<string>()
        const newTags = new Set<string>()
        for (const tag of previous.tags) {
          oldTags.add(tag)
          if (pause()) {
            yield
            started = performance.now()
          }
        }
        for (const tag of page.metadata.tags) {
          newTags.add(tag)
          if (pause()) {
            yield
            started = performance.now()
          }
        }
        for (const tag of oldTags) {
          if (!newTags.has(tag)) tagChanges.push([tag, page.path, false])
          if (pause()) {
            yield
            started = performance.now()
          }
        }
        for (const tag of newTags) {
          if (!oldTags.has(tag)) tagChanges.push([tag, page.path, true])
          if (pause()) {
            yield
            started = performance.now()
          }
        }
      }
      const next: DocumentLinks = {
        ...referenceMetadata(page.metadata),
        version: page.version,
        syntaxKey: page.syntax.key,
        syntaxComplete,
        unsupportedSyntax,
        targets,
      }
      incomplete +=
        Number(!next.referenceComplete || !syntaxComplete) -
        Number(!previous.referenceComplete || !previous.syntaxComplete)
      unsupported +=
        Number(unsupportedSyntax) - Number(previous.unsupportedSyntax)
      updates.set(page.path, next)
      if (pause()) {
        yield
        started = performance.now()
      }
    }
    if (this.revision !== revision || !canCommit()) return null
    if (!updates.size) return { parsed: 0, resolved: 0 }
    for (const [path, document] of updates) {
      this.documents.set(path, document)
      if (!document.referenceComplete || !document.syntaxComplete)
        this.incompleteDocuments.add(path)
      else this.incompleteDocuments.delete(path)
    }
    for (const [path, source, add] of reverseChanges) {
      const sources = this.reverse.get(path)
      if (sources) this.sortedViews.delete(sources)
      if (add) this.addReverse(this.reverse, path, source)
      else {
        sources?.delete(source)
        if (!sources?.size) this.reverse.delete(path)
      }
    }
    if (this.tagPaths === tags && tags) {
      for (const [tag, path, add] of tagChanges) {
        const paths = tags.get(tag)
        if (paths) this.sortedViews.delete(paths)
        if (add) this.addReverse(tags, tag, path)
        else {
          paths?.delete(path)
          if (!paths?.size) tags.delete(tag)
        }
      }
    } else this.tagPaths = null
    this.incompleteCount = incomplete
    this.unsupportedCount = unsupported
    this.complete = incomplete === 0
    this.unsupported = unsupported > 0
    this.revision++
    this.tagBuild = undefined
    for (const key of this.filteredViews.keys())
      if (!key.startsWith('paths:')) this.filteredViews.delete(key)
    if (tagChanges.length || this.tagPaths === null) this.tagViews.clear()
    return { parsed: updates.size, resolved: updates.size }
  }

  private *applySteps(
    target: WorkspaceTarget,
    pages: readonly (WorkspacePage | WorkspaceMetadataPage)[],
    pageSyntax: (page: WorkspacePage) => PageSyntax,
    canCommit: CanCommit = () => true,
  ): Generator<void, ApplyResult | null> {
    const snapshot = this.documents
    const revision = this.revision
    const sameWorkspace =
      this.target?.workspaceId === target.workspaceId &&
      this.target.workspaceGeneration === target.workspaceGeneration
    const previous = sameWorkspace
      ? this.documents
      : new Map<string, DocumentLinks>()
    const next = new Map<string, DocumentLinks>()
    const changed = new Set<string>()
    const paths = new Set<string>()
    let pathsChanged = !sameWorkspace
    let complete = true
    let unsupported = false
    let incompleteCount = 0
    const incompleteDocuments = new Set<string>()
    let unsupportedCount = 0
    let parsed = 0
    let sliceStarted = performance.now()
    for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
      if (
        !canCommit() ||
        this.documents !== snapshot ||
        this.revision !== revision
      )
        return null
      const page = pages[pageIndex]
      if (!page) continue
      const cached = previous.get(page.path)
      const syntax = 'metadata' in page ? page.syntax : pageSyntax(page)
      const version =
        'metadata' in page ? page.version : sourceIndexVersion(page.markdown)
      const markdownSource = isMarkdownDocument(page.path)
      const syntaxComplete = !markdownSource || syntax.complete
      const unsupportedSyntax = markdownSource && syntax.unsupported
      if (cached?.version === version && cached.syntaxKey === syntax.key) {
        next.set(
          page.path,
          cached.syntaxComplete === syntaxComplete &&
            cached.unsupportedSyntax === unsupportedSyntax
            ? cached
            : { ...cached, syntaxComplete, unsupportedSyntax },
        )
      } else {
        const metadata =
          'metadata' in page
            ? page.metadata
            : parseWorkspaceMetadata(page, syntax, this.parse, () => {})
        next.set(page.path, {
          ...referenceMetadata(metadata),
          version,
          syntaxKey: syntax.key,
          syntaxComplete,
          unsupportedSyntax,
          targets: new Set(),
        })
        changed.add(page.path)
        if (markdownSource && metadata.referenceComplete) parsed++
      }
      paths.add(page.path)
      if (!previous.has(page.path)) pathsChanged = true
      const document = next.get(page.path)
      complete &&= !!document?.referenceComplete && !!document.syntaxComplete
      unsupported ||= !!document?.unsupportedSyntax
      if (!document?.referenceComplete || !document.syntaxComplete) {
        incompleteCount++
        incompleteDocuments.add(page.path)
      }
      if (document?.unsupportedSyntax) unsupportedCount++
      if (
        (pageIndex + 1) % workSlice === 0 ||
        performance.now() - sliceStarted >= workSliceMs
      ) {
        yield
        sliceStarted = performance.now()
      }
    }
    pathsChanged ||= previous.size !== next.size
    const tagPaths = pathsChanged || changed.size ? null : this.tagPaths
    const basenames = pathsChanged
      ? new Map<string, string[]>()
      : this.basenames
    if (pathsChanged) {
      let count = 0
      for (const path of paths) {
        const name = path.split('/').at(-1) ?? path
        const matches = basenames.get(name)
        if (matches) matches.push(path)
        else basenames.set(name, [path])
        if (
          ++count % workSlice === 0 ||
          performance.now() - sliceStarted >= workSliceMs
        ) {
          yield
          sliceStarted = performance.now()
        }
      }
    }
    const toResolve = pathsChanged ? [...next.keys()] : [...changed]
    const resolved = new Map<string, ReadonlySet<string>>()
    for (let pathIndex = 0; pathIndex < toResolve.length; pathIndex++) {
      const path = toResolve[pathIndex]
      if (!path) continue
      const document = next.get(path)
      if (!document) continue
      const targets = new Set<string>()
      let references = 0
      for (const [kind, hrefs] of [
        ['markdown', document.references.links],
        ['wiki', document.references.wikilinks],
      ] as const) {
        for (const href of hrefs) {
          const targetPath: string | null =
            kind === 'wiki'
              ? resolveWikiTarget(path, href, paths, basenames)
              : resolveLocalTarget(href, paths)
          if (targetPath && targetPath !== path) targets.add(targetPath)
          if (
            ++references % workSlice === 0 ||
            performance.now() - sliceStarted >= workSliceMs
          ) {
            yield
            sliceStarted = performance.now()
          }
        }
      }
      resolved.set(path, targets)
      if (
        (pathIndex + 1) % workSlice === 0 ||
        performance.now() - sliceStarted >= workSliceMs
      ) {
        yield
        sliceStarted = performance.now()
      }
    }
    let reverse: Map<string, Set<string>>
    if (pathsChanged) {
      reverse = new Map()
      let index = 0
      for (const [path, document] of next) {
        const targets = resolved.get(path) ?? new Set<string>()
        next.set(path, { ...document, targets })
        for (const targetPath of targets) {
          this.addReverse(reverse, targetPath, path)
          if (performance.now() - sliceStarted >= workSliceMs) {
            yield
            sliceStarted = performance.now()
          }
        }
        if (
          ++index % workSlice === 0 ||
          performance.now() - sliceStarted >= workSliceMs
        ) {
          yield
          sliceStarted = performance.now()
        }
      }
    } else {
      reverse = new Map()
      let index = 0
      for (const [path, sources] of this.reverse) {
        const copied = new Set<string>()
        reverse.set(path, copied)
        for (const source of sources) {
          copied.add(source)
          if (performance.now() - sliceStarted >= workSliceMs) {
            yield
            sliceStarted = performance.now()
          }
        }
        if (
          ++index % workSlice === 0 ||
          performance.now() - sliceStarted >= workSliceMs
        ) {
          yield
          sliceStarted = performance.now()
        }
      }
      for (const path of changed) {
        for (const oldTarget of previous.get(path)?.targets ?? []) {
          reverse.get(oldTarget)?.delete(path)
          if (performance.now() - sliceStarted >= workSliceMs) {
            yield
            sliceStarted = performance.now()
          }
        }
        const document = next.get(path)
        if (!document) continue
        const targets = resolved.get(path) ?? new Set<string>()
        next.set(path, { ...document, targets })
        for (const targetPath of targets) {
          this.addReverse(reverse, targetPath, path)
          if (performance.now() - sliceStarted >= workSliceMs) {
            yield
            sliceStarted = performance.now()
          }
        }
        if (
          ++index % workSlice === 0 ||
          performance.now() - sliceStarted >= workSliceMs
        ) {
          yield
          sliceStarted = performance.now()
        }
      }
    }
    if (
      this.documents !== snapshot ||
      this.revision !== revision ||
      !canCommit()
    )
      return null
    const sortedPaths = pathsChanged
      ? yield* sortSteps([...paths], (a, b) => a.localeCompare(b))
      : this.sortedPaths
    if (
      this.documents !== snapshot ||
      this.revision !== revision ||
      !canCommit()
    )
      return null
    this.documents = next
    this.revision++
    this.incompleteCount = incompleteCount
    this.incompleteDocuments = incompleteDocuments
    this.unsupportedCount = unsupportedCount
    this.tagBuild = undefined
    this.filteredViews.clear()
    this.tagViews.clear()
    this.reverse = reverse
    this.complete = complete
    this.unsupported = unsupported
    this.paths = paths
    this.sortedPaths = sortedPaths
    this.basenames = basenames
    this.tagPaths = tagPaths
    this.target = target
    return { parsed, resolved: toResolve.length }
  }

  has(path: string): boolean {
    return this.documents.has(path)
  }

  incompletePaths(): readonly string[] {
    const paths: string[] = []
    let bytes = 0
    for (const path of this.incompleteDocuments) {
      const size = Buffer.byteLength(path)
      if (bytes + size > 32 * 1024) break
      paths.push(path)
      bytes += size
      if (paths.length === 8) break
    }
    return paths
  }

  isComplete(): boolean {
    return this.complete
  }

  hasUnsupportedSyntax(): boolean {
    return this.unsupported
  }

  links(path: string, offset: number, limit: number): ReferencePage {
    return this.page(this.documents.get(path)?.targets ?? [], offset, limit)
  }

  backlinks(path: string, offset: number, limit: number): ReferencePage {
    return this.page(this.reverse.get(path) ?? [], offset, limit)
  }

  async referencesCooperatively(
    kind: 'links' | 'backlinks',
    path: string,
    offset: number,
    limit: number,
    current: CanCommit,
  ): Promise<ReferencePage | null> {
    return this.finishCooperatively(
      this.pageSteps(
        kind === 'links'
          ? (this.documents.get(path)?.targets ?? [])
          : (this.reverse.get(path) ?? []),
        offset,
        limit,
      ),
      current,
    )
  }

  tagged(tag: string, offset: number, limit: number): ReferencePage {
    this.ensureTags()
    return this.page(this.tagPaths?.get(tag) ?? [], offset, limit)
  }

  async taggedCooperatively(
    tag: string,
    offset: number,
    limit: number,
    canCommit: CanCommit = () => true,
  ): Promise<ReferencePage | null> {
    const snapshot = this.documents
    const revision = this.revision
    if (!(await this.ensureTagsCooperatively(canCommit))) return null
    if (
      this.documents !== snapshot ||
      this.revision !== revision ||
      !canCommit()
    )
      return null
    return this.finishCooperatively(
      this.pageSteps(this.tagPaths?.get(tag) ?? [], offset, limit),
      canCommit,
    )
  }

  tags(offset: number, limit: number, prefix?: string) {
    this.ensureTags()
    return this.finish(this.tagsSteps(offset, limit, prefix))
  }

  private *tagsSteps(
    offset: number,
    limit: number,
    prefix?: string,
  ): Generator<
    void,
    {
      items: readonly WorkspaceTagSummary[]
      hasMore: boolean
      nextOffset: number
      capReached: boolean
    }
  > {
    let sorted = this.tagViews.get(prefix)
    if (!sorted) {
      const matches: [string, Set<string>][] = []
      let count = 0
      let started = performance.now()
      for (const entry of this.tagPaths ?? []) {
        if (prefix === undefined || entry[0].startsWith(prefix))
          matches.push(entry)
        if (
          ++count % workSlice === 0 ||
          performance.now() - started >= workSliceMs
        ) {
          yield
          started = performance.now()
        }
      }
      sorted = yield* sortSteps(matches, ([a, aPaths], [b, bPaths]) =>
        prefix === undefined
          ? a.localeCompare(b)
          : bPaths.size - aPaths.size || (a < b ? -1 : a > b ? 1 : 0),
      )
      if (this.tagViews.size >= 16)
        this.tagViews.delete(this.tagViews.keys().next().value)
      this.tagViews.set(prefix, sorted)
    }
    const items: WorkspaceTagSummary[] = []
    let bytes = 0
    let nextOffset = offset
    let capReached = false
    let started = performance.now()
    for (
      let index = offset;
      index < sorted.length && items.length < limit;
      index++
    ) {
      if (performance.now() - started >= workSliceMs) {
        yield
        started = performance.now()
      }
      const entry = sorted[index]
      if (!entry) break
      const size = Buffer.byteLength(entry[0]) + 8
      if (size > 32 * 1024) {
        capReached = true
        nextOffset = index + 1
        continue
      }
      if (bytes + size > 32 * 1024) break
      items.push({ tag: entry[0], count: entry[1].size })
      bytes += size
      nextOffset = index + 1
    }
    return {
      items,
      hasMore: nextOffset < sorted.length,
      nextOffset,
      capReached,
    }
  }

  async tagsCooperatively(
    offset: number,
    limit: number,
    prefix?: string,
    canCommit: CanCommit = () => true,
  ): Promise<{
    items: readonly WorkspaceTagSummary[]
    hasMore: boolean
    nextOffset: number
    capReached: boolean
  } | null> {
    const snapshot = this.documents
    const revision = this.revision
    if (!(await this.ensureTagsCooperatively(canCommit))) return null
    if (
      this.documents !== snapshot ||
      this.revision !== revision ||
      !canCommit()
    )
      return null
    return this.finishCooperatively(
      this.tagsSteps(offset, limit, prefix),
      canCommit,
    )
  }

  /** Resume graph enumeration without rescanning links or returning note source. */
  graph(
    start: GraphPosition,
    limit: number,
  ): {
    items: readonly WorkspaceGraphItem[]
    position: GraphPosition
    hasMore: boolean
  } {
    const items: WorkspaceGraphItem[] = []
    let { pathIndex, targetIndex, nodeEmitted } = start
    let bytes = 0
    let targetsPath = ''
    let targets: readonly string[] = []
    while (pathIndex < this.sortedPaths.length && items.length < limit) {
      const path = this.sortedPaths[pathIndex]
      if (!path) break
      let item: WorkspaceGraphItem
      if (!nodeEmitted) item = { kind: 'node', path }
      else {
        if (targetsPath !== path) {
          targetsPath = path
          const links = this.documents.get(path)?.targets
          let sorted = links && sortedTargets.get(links)
          if (links && !sorted) {
            sorted = [...links].sort((a, b) => a.localeCompare(b))
            sortedTargets.set(links, sorted)
          }
          targets = sorted ?? []
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
      if (item.kind === 'node') nodeEmitted = true
      else targetIndex++
    }
    return {
      items,
      position: { pathIndex, targetIndex, nodeEmitted },
      hasMore: pathIndex < this.sortedPaths.length,
    }
  }

  private ensureTags(): void {
    this.finish(this.tagSteps())
  }

  private async ensureTagsCooperatively(
    canCommit: CanCommit,
  ): Promise<boolean> {
    if (!canCommit()) return false
    if (!this.tagPaths && !this.tagBuild) {
      const revision = this.revision
      const current = () => this.revision === revision
      const build = this.finishCooperatively(this.tagSteps(current), current)
        .then((result) => result ?? false)
        .finally(() => {
          if (this.tagBuild === build) this.tagBuild = undefined
        })
      this.tagBuild = build
    }
    return (this.tagPaths !== null || !!(await this.tagBuild)) && canCommit()
  }

  private *buildTags(
    documents: Map<string, DocumentLinks>,
  ): Generator<void, Map<string, Set<string>>> {
    const next = new Map<string, Set<string>>()
    let index = 0
    let started = performance.now()
    for (const [path, document] of documents) {
      if (isMarkdownDocument(path)) {
        const tags = document.tags
        for (const name of tags) {
          let paths = next.get(name)
          if (!paths) {
            paths = new Set()
            next.set(name, paths)
          }
          paths.add(path)
          if (performance.now() - started >= workSliceMs) {
            yield
            started = performance.now()
          }
        }
      }
      if (
        ++index % workSlice === 0 ||
        performance.now() - started >= workSliceMs
      ) {
        yield
        started = performance.now()
      }
    }
    return next
  }

  private *tagSteps(
    canCommit: CanCommit = () => true,
  ): Generator<void, boolean> {
    if (this.tagPaths) return true
    const snapshot = this.documents
    const next = yield* this.buildTags(snapshot)
    if (this.documents !== snapshot || !canCommit()) return false
    this.tagPaths = next
    return true
  }

  property(
    key: string,
    value: PropertyScalar,
    offset: number,
    limit: number,
  ): ReferencePage & { complete: boolean } {
    const result = this.finish(this.propertySteps(key, value, offset, limit))
    if (!result)
      throw new Error('Workspace metadata index changed during query.')
    return result
  }

  async propertyCooperatively(
    key: string,
    value: PropertyScalar,
    offset: number,
    limit: number,
    canCommit: CanCommit = () => true,
  ): Promise<(ReferencePage & { complete: boolean }) | null> {
    return this.finishCooperatively(
      this.propertySteps(key, value, offset, limit, canCommit),
      canCommit,
    )
  }

  private *propertySteps(
    key: string,
    value: PropertyScalar,
    offset: number,
    limit: number,
    canCommit: CanCommit = () => true,
  ): Generator<void, (ReferencePage & { complete: boolean }) | null> {
    const snapshot = this.documents
    const matches: string[] = []
    let complete = true
    let index = 0
    let started = performance.now()
    const propertyKey = sourceIndexVersion(key)
    const propertyValue = propertyIndexValue(value)
    const cacheKey = `property:${propertyKey}:${propertyValue}`
    const cached = this.filteredViews.get(cacheKey)
    if (cached)
      return {
        ...(yield* this.pageSteps(cached.paths, offset, limit)),
        complete: cached.complete,
      }
    for (const [path, document] of snapshot) {
      if (isMarkdownDocument(path)) {
        const properties = document.properties
        if (!properties.complete) complete = false
        if (properties.values[propertyKey]?.includes(propertyValue))
          matches.push(path)
      }
      if (
        ++index % workSlice === 0 ||
        performance.now() - started >= workSliceMs
      ) {
        yield
        started = performance.now()
      }
    }
    if (this.documents !== snapshot || !canCommit()) return null
    this.rememberPaths(cacheKey, matches, complete)
    return { ...(yield* this.pageSteps(matches, offset, limit)), complete }
  }

  searchPaths(query: string, offset: number, limit: number): ReferencePage {
    return this.finish(this.pathSteps(query, offset, limit))
  }

  async searchPathsCooperatively(
    query: string,
    offset: number,
    limit: number,
    current: CanCommit,
  ) {
    return this.finishCooperatively(
      this.pathSteps(query, offset, limit),
      current,
    )
  }

  private *pathSteps(
    query: string,
    offset: number,
    limit: number,
  ): Generator<void, ReferencePage> {
    const folded = query.toLocaleLowerCase()
    const cacheKey = `paths:${folded}`
    const cached = this.filteredViews.get(cacheKey)
    if (cached) return yield* this.pageSteps(cached.paths, offset, limit)
    const matches: string[] = []
    let count = 0
    let started = performance.now()
    for (const path of this.paths) {
      if (path.toLocaleLowerCase().includes(folded)) matches.push(path)
      if (
        ++count % workSlice === 0 ||
        performance.now() - started >= workSliceMs
      ) {
        yield
        started = performance.now()
      }
    }
    this.rememberPaths(cacheKey, matches, true)
    return yield* this.pageSteps(matches, offset, limit)
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

  private finish<T>(work: Generator<void, T>): T {
    let step = work.next()
    while (!step.done) step = work.next()
    return step.value
  }

  private async finishCooperatively<T>(
    work: Generator<void, T>,
    current: CanCommit = () => true,
  ): Promise<T | null> {
    const snapshot = this.documents
    const revision = this.revision
    if (!current()) return null
    let step = work.next()
    while (!step.done) {
      await this.yieldTurn()
      if (
        this.documents !== snapshot ||
        this.revision !== revision ||
        !current()
      ) {
        work.return(null as T)
        return null
      }
      step = work.next()
    }
    return step.value
  }

  private addReverse(
    reverse: Map<string, Set<string>>,
    target: string,
    source: string,
  ): void {
    let sources = reverse.get(target)
    if (!sources) {
      sources = new Set()
      reverse.set(target, sources)
    }
    sources.add(source)
  }

  private rememberPaths(key: string, paths: string[], complete: boolean): void {
    if (this.filteredViews.size >= 16)
      this.filteredViews.delete(
        this.filteredViews.keys().next().value as string,
      )
    this.filteredViews.set(key, { paths, complete })
  }

  private page(
    values: Iterable<string>,
    offset: number,
    limit: number,
  ): ReferencePage {
    return this.finish(this.pageSteps(values, offset, limit))
  }

  private *pageSteps(
    values: Iterable<string>,
    offset: number,
    limit: number,
  ): Generator<void, ReferencePage> {
    let sorted = this.sortedViews.get(values)
    if (!sorted) {
      sorted = yield* sortSteps([...values], (a, b) => a.localeCompare(b))
      this.sortedViews.set(values, sorted)
    }
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
