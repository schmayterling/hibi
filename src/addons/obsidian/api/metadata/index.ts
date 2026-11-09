import { isMarkdownDocument } from '../../../../shared/document-types'
import type {
  DocumentTarget,
  WorkspaceTarget,
} from '../../../../shared/foundation-contracts'
import { readFrontmatter } from '../../../../shared/frontmatter'
import {
  localTargetPath,
  noteBasenames,
  resolveLocalTarget,
  resolveWikiTarget,
  wikiTargetName,
} from '../../../../shared/note-links'
import { noteProperties } from '../../../../shared/note-metadata'
import { shortestObsidianPath } from '../../../../shared/obsidian-links'
import { Events, reportError } from '../core/events'
import { registerObsidianApi } from '../registry'
import type { ApiContext } from '../types'
import type { TFile } from '../vault/index'
import * as helpers from './helpers'
import { validMetadataPath } from './path'
import type { MetadataFilePage } from './types'

export * from './helpers'

/** Hibi has no source positions for indexed metadata. These fields omit them. */
export interface CachedMetadata {
  headings?: { heading: string; level: number }[]
  tags?: { tag: string }[]
  frontmatter?: Record<string, unknown>
}

type LinkCounts = Record<string, Record<string, number>>
type CacheEntry = {
  version: string
  stale?: boolean
  cache: CachedMetadata
  resolved: Record<string, number>
  unresolved: Record<string, number>
}

declare module '../types' {
  interface MetadataCacheApi extends MetadataCache {}
}

/** Synchronous public cache over lazy, per-file worker and paged index reads. */
export class MetadataCache extends Events {
  readonly resolvedLinks: LinkCounts
  readonly unresolvedLinks: LinkCounts
  private entries = new Map<string, CacheEntry>()
  private pending = new Map<string, Promise<void>>()
  private tail: Promise<void> = Promise.resolve()
  private target: WorkspaceTarget | null = null
  private revision = 0
  private stops: (() => void)[] = []
  private disposed = false

  constructor(private context: ApiContext) {
    super()
    this.resolvedLinks = this.linkView('resolved')
    this.unresolvedLinks = this.linkView('unresolved')
  }

  async start() {
    if (this.context.app.vault.target === null) return
    const stream = await this.context.hibi.workspace.subscribeChanges(
      (event) => {
        if (this.disposed) return
        const previous = this.target
        const same =
          previous?.workspaceId === event.workspaceId &&
          previous.workspaceGeneration === event.workspaceGeneration
        this.target = {
          workspaceId: event.workspaceId,
          workspaceGeneration: event.workspaceGeneration,
        }
        this.invalidate(same, event.kind === 'content' ? event.paths : null)
      },
    )
    if (this.disposed) {
      stream.dispose()
      return
    }
    this.stops.push(() => stream.dispose())
    this.target ??= stream.snapshot.target
    this.stops.push(
      this.context.hibi.documents.subscribe((event) => {
        if (this.disposed) return
        const target =
          event.kind === 'closed' ? event.target : event.metadata?.target
        const file = target ? this.documentFile(target) : null
        this.invalidate(true, file ? [file.path] : null)
      }),
    )
    this.stops.push(
      this.context.hibi.editor.onSyntaxChange(() => {
        if (!this.disposed) this.invalidate(true)
      }),
    )
  }

  private invalidate(
    refresh: boolean,
    affected: readonly string[] | null = null,
  ) {
    if (!refresh) {
      this.revision++
      this.entries.clear()
      this.pending.clear()
      return
    }
    const paths = new Set([...this.entries.keys(), ...this.pending.keys()])
    for (const path of paths) {
      if (affected && !affected.includes(path)) continue
      const entry = this.entries.get(path)
      if (entry && affected) entry.stale = true
      this.pending.delete(path)
      this.request(path)
    }
  }

  dispose() {
    this.disposed = true
    this.revision++
    for (const stop of this.stops.splice(0)) stop()
    this.entries.clear()
    this.pending.clear()
    this.target = null
  }

  getFileCache(file: TFile): CachedMetadata | null {
    return this.getCache(file.path)
  }

  getCache(path: string): CachedMetadata | null {
    if (
      this.disposed ||
      !validMetadataPath(path) ||
      !isMarkdownDocument(path) ||
      !this.file(path)
    )
      return null
    const entry = this.entries.get(path)
    if (entry && !entry.stale) {
      this.entries.delete(path)
      this.entries.set(path, entry)
      return entry.cache
    }
    this.request(path)
    return null
  }

  getFirstLinkpathDest(linkpath: string, sourcePath: string): TFile | null {
    if (this.disposed || (sourcePath !== '' && !validMetadataPath(sourcePath)))
      return null
    const relative = linkpath.split('#', 1)[0]?.trim() ?? ''
    if (/^\.\.?\//.test(relative)) {
      const path = localTargetPath(
        sourcePath,
        relative.split('/').map(encodeURIComponent).join('/'),
      )
      const resolved =
        path && validMetadataPath(path)
          ? resolveLocalTarget(path, this.paths())
          : null
      return resolved ? this.file(resolved) : null
    }
    const name = wikiTargetName(linkpath)
    if (name === null || (name && !validMetadataPath(name.replace(/^\//, ''))))
      return null
    const paths = this.paths()
    const destination = resolveWikiTarget(
      sourcePath,
      name,
      paths,
      noteBasenames(paths),
    )
    return destination ? this.file(destination) : null
  }

  fileToLinktext(
    file: TFile,
    sourcePath: string,
    omitMdExtension = true,
  ): string {
    if (
      !validMetadataPath(file.path) ||
      (sourcePath !== '' && !validMetadataPath(sourcePath))
    )
      throw new Error('Use vault-relative file paths.')
    const format = this.context.app.vault.settings?.newLinkFormat
    let link = file.path
    if (format === 'relative') {
      const from = sourcePath.split('/').slice(0, -1)
      const to = file.path.split('/')
      while (from.length && from[0] === to[0]) {
        from.shift()
        to.shift()
      }
      link = [...from.map(() => '..'), ...to].join('/')
      if (!link.startsWith('.')) link = `./${link}`
      return omitMdExtension ? link.replace(/\.md$/i, '') : link
    }
    if (format === 'absolute')
      return omitMdExtension ? link.replace(/\.md$/i, '') : link
    const shortest = shortestObsidianPath(file.path, this.paths())
    return omitMdExtension ? shortest.replace(/\.md$/i, '') : shortest
  }

  private documentFile(target: DocumentTarget): TFile | null {
    return this.context.app.vault.getFileForDocument?.(target) ?? null
  }

  private file(path: string): TFile | null {
    try {
      return this.context.app.vault.getFileByPath(path)
    } catch {
      return null
    }
  }

  private paths() {
    return new Set(
      this.context.app.vault
        .getFiles()
        .map((file) => file.path)
        .filter(validMetadataPath),
    )
  }

  private linkView(field: 'resolved' | 'unresolved'): LinkCounts {
    return new Proxy(Object.create(null) as LinkCounts, {
      ownKeys: () => (this.disposed ? [] : [...this.paths()]),
      getOwnPropertyDescriptor: (_target, key) =>
        typeof key === 'string' && validMetadataPath(key) && this.file(key)
          ? {
              configurable: true,
              enumerable: true,
              get: () => this.linkRow(key, field),
            }
          : undefined,
      get: (_target, key) =>
        typeof key === 'string' ? this.linkRow(key, field) : undefined,
      has: (_target, key) =>
        typeof key === 'string' && validMetadataPath(key) && !!this.file(key),
      set: () => false,
      defineProperty: () => false,
      deleteProperty: () => false,
      preventExtensions: () => false,
    })
  }

  private linkRow(path: string, field: 'resolved' | 'unresolved') {
    if (!this.getCache(path)) return undefined
    const entry = this.entries.get(path)
    return entry?.[field]
  }

  private request(path: string) {
    if (
      this.disposed ||
      !this.target ||
      this.pending.has(path) ||
      this.pending.size >= 128 ||
      !validMetadataPath(path) ||
      !this.file(path)
    )
      return
    const revision = this.revision
    const target = this.target
    // The pending job is a per-path epoch; unrelated edits cannot cancel it.
    const current = (): boolean =>
      !this.disposed &&
      revision === this.revision &&
      this.pending.get(path) === job
    let wasCurrent = false
    const job: Promise<void> = this.tail
      .then(() => (current() ? this.load(path, target, current) : undefined))
      .finally(() => {
        wasCurrent = current()
        if (this.pending.get(path) === job) this.pending.delete(path)
      })
    this.pending.set(path, job)
    this.tail = job.then(
      () => {
        if (
          wasCurrent &&
          !this.disposed &&
          revision === this.revision &&
          !this.pending.size &&
          this.entries.has(path)
        )
          this.trigger('resolved')
      },
      (error) => {
        if (wasCurrent && !this.disposed && revision === this.revision)
          reportError(error)
      },
    )
  }

  private async load(
    path: string,
    target: WorkspaceTarget,
    current: () => boolean,
  ) {
    const { hibi } = this.context
    const input = { target, path, vaultId: target.workspaceId }
    const page = await hibi.native.query<MetadataFilePage | null>(
      'obsidianMetadataFile',
      input,
    )
    if (!current() || !page || page.path !== path) return
    const cache: CachedMetadata = {
      tags: page.metadata.tags.map((tag) => ({ tag: `#${tag}` })),
    }
    const destinations = new Set<string>()
    const sequence = page.sequence
    // Each query is bounded; publish only when every page belongs to one sequence.
    for (const kind of ['headings', 'links'] as const) {
      let offset = 0
      cache.headings ??= []
      while (current()) {
        const result = await hibi.workspace.query({
          target,
          path,
          kind,
          offset,
          limit: 100,
        })
        if (!current() || !result.ok) return
        const value = result.value
        if (
          value.kind !== kind ||
          value.stale ||
          value.target.workspaceId !== target.workspaceId ||
          value.target.workspaceGeneration !== target.workspaceGeneration ||
          sequence !== value.sequence
        )
          return
        if (value.kind === 'headings')
          cache.headings.push(
            ...value.items.map(({ text, depth }) => ({
              heading: text,
              level: depth,
            })),
          )
        else if (value.kind === 'links')
          for (const destination of value.items)
            if (validMetadataPath(destination)) destinations.add(destination)
        if (!value.hasMore) break
        if (value.nextOffset <= offset) return
        offset = value.nextOffset
      }
    }
    if (!current()) return
    const versions = () =>
      JSON.stringify(
        hibi.documents
          .listOpen()
          .filter(({ target }) => this.documentFile(target)?.path === path)
          .map(({ tabId, target }) => [
            tabId,
            target.documentId,
            target.documentGeneration,
            target.contentVersion,
          ]),
      )
    const before = versions()
    const sourceFile = this.file(path)
    if (!sourceFile) return
    const data = await this.context.app.vault.read(sourceFile)
    if (!current() || before !== versions()) return
    const after = await hibi.native.query<MetadataFilePage | null>(
      'obsidianMetadataFile',
      input,
    )
    if (
      !current() ||
      !after ||
      after.version !== page.version ||
      after.sequence !== sequence ||
      before !== versions()
    )
      return
    if (
      page.version.startsWith('draft:') &&
      !hibi.documents
        .listOpen()
        .some(
          ({ tabId, target }) =>
            page.version === `draft:${tabId}:${target.contentVersion}`,
        )
    )
      return
    const properties = noteProperties(data, page.syntax.settings)
    if (page.syntax.settings.frontmatter && readFrontmatter(data, true))
      cache.frontmatter = { ...properties.values }
    const paths = this.paths()
    const basenames = noteBasenames(paths)
    const resolved: Record<string, number> = Object.create(null)
    const unresolved: Record<string, number> = Object.create(null)
    const count = (href: string, destination: string | null) => {
      const known =
        destination && (destination === path || destinations.has(destination))
      if (destination && !known) return
      const row = known ? resolved : unresolved
      const key = known ? destination : href
      if (key) row[key] = (row[key] ?? 0) + 1
    }
    for (const href of page.metadata.references.links)
      count(href, resolveLocalTarget(href, paths))
    for (const href of page.metadata.references.wikilinks)
      count(href, resolveWikiTarget(path, href, paths, basenames))
    const file = this.file(path)
    if (!current() || !file) return
    const previous = this.entries.get(path)
    if (
      previous?.version === page.version &&
      JSON.stringify([
        previous.cache,
        previous.resolved,
        previous.unresolved,
      ]) === JSON.stringify([cache, resolved, unresolved])
    ) {
      previous.stale = false
      return
    }
    // ponytail: retain at most 128 requested notes; use host-backed eviction if plugins need larger synchronous caches.
    const oldest = this.entries.keys().next().value
    if (!previous && this.entries.size >= 128 && oldest !== undefined)
      this.entries.delete(oldest)
    this.entries.set(path, {
      version: page.version,
      cache,
      resolved,
      unresolved,
    })
    this.trigger('changed', file, data, cache)
    if (current()) this.trigger('resolve', file)
  }
}

registerObsidianApi({
  id: 'metadata',
  async create(context) {
    const metadataCache = new MetadataCache(context)
    context.register(() => metadataCache.dispose())
    await metadataCache.start()
    return {
      app: { metadataCache },
      exports: { MetadataCache, ...helpers },
    }
  },
})
