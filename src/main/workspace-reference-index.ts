import type { WorkspaceTarget } from '../shared/foundation-contracts'
import {
  localTarget,
  noteReferences,
  noteTargets,
  wikiTarget,
} from '../shared/note-links.ts'
import type { WorkspacePage } from '../shared/workspace'

type References = ReturnType<typeof noteReferences>
type DocumentLinks = {
  markdown: string
  references: References
  targets: ReadonlySet<string>
}

export interface ReferencePage {
  readonly items: readonly string[]
  readonly hasMore: boolean
}

/** Parsed references share the existing workspace page cache; no filesystem scan. */
export class WorkspaceReferenceIndex {
  private target: WorkspaceTarget | null = null
  private documents = new Map<string, DocumentLinks>()
  private reverse = new Map<string, Set<string>>()
  private paths = new Set<string>()
  private readonly parse: typeof noteReferences

  constructor(parse = noteReferences) {
    this.parse = parse
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
      next.set(page.path, {
        markdown: page.markdown,
        references: this.parse(page.markdown),
        targets: new Set(),
      })
      changed.add(page.path)
      parsed++
    }
    const pathsChanged =
      !sameWorkspace ||
      previous.size !== next.size ||
      [...next.keys()].some((path) => !previous.has(path))
    const paths = new Set(next.keys())
    const toResolve = pathsChanged ? [...next.keys()] : [...changed]
    const resolved = new Map<string, ReadonlySet<string>>()
    for (const path of toResolve) {
      const document = next.get(path)
      if (!document) continue
      resolved.set(
        path,
        new Set(
          noteTargets(document.markdown, path, paths, document.references),
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
    this.paths = paths
    this.target = target
    return { parsed, resolved: toResolve.length }
  }

  has(path: string): boolean {
    return this.documents.has(path)
  }

  links(path: string, offset: number, limit: number): ReferencePage {
    return this.page(this.documents.get(path)?.targets ?? [], offset, limit)
  }

  backlinks(path: string, offset: number, limit: number): ReferencePage {
    return this.page(this.reverse.get(path) ?? [], offset, limit)
  }

  resolve(
    from: string,
    href: string,
    kind: 'markdown' | 'wiki',
  ): string | null {
    return kind === 'wiki'
      ? wikiTarget(from, href, this.paths)
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
    return {
      items: sorted.slice(offset, offset + limit),
      hasMore: offset + limit < sorted.length,
    }
  }
}
