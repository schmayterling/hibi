import { isMarkdownDocument } from '../../../../shared/document-types'
import type {
  DocumentTarget,
  WorkspaceTarget,
} from '../../../../shared/foundation-contracts'
import type {
  NoteCacheEntry,
  NoteCacheValues,
  NotePosition,
} from '../../../../shared/note-cache'
import { iterateNoteMetadata } from '../../../../shared/note-cache-query'
import {
  localTargetPath,
  noteBasenames,
  resolveLocalTarget,
  resolveWikiTarget,
  wikiTargetName,
} from '../../../../shared/note-links'
import { shortestObsidianPath } from '../../../../shared/obsidian-links'
import { Events, reportError } from '../core/events'
import { registerObsidianApi } from '../registry'
import type { ApiContext } from '../types'
import type { TFile } from '../vault/index'
import * as helpers from './helpers'
import { validMetadataPath } from './path'

export type { Loc, Pos } from '../../../../shared/note-cache'
export * from './helpers'

export interface CachedMetadata {
  headings?: { heading: string; level: number; position: NotePosition }[]
  links?: NoteCacheValues['link'][]
  embeds?: NoteCacheValues['embed'][]
  tags?: NoteCacheValues['tag'][]
  frontmatter?: Record<string, unknown>
  frontmatterPosition?: NotePosition
  frontmatterLinks?: NoteCacheValues['frontmatterLink'][]
  sections?: NoteCacheValues['section'][]
  listItems?: NoteCacheValues['listItem'][]
  blocks?: Record<string, NoteCacheValues['block']>
}

function cacheEntry(cache: CachedMetadata, entry: NoteCacheEntry) {
  switch (entry.kind) {
    case 'heading': {
      const { text, depth, position } = entry.value
      cache.headings ??= []
      cache.headings.push({ heading: text, level: depth, position })
      break
    }
    case 'frontmatter':
      cache.frontmatter = entry.value.values
      cache.frontmatterPosition = entry.value.position
      break
    case 'block':
      cache.blocks ??= Object.create(null) as NonNullable<
        CachedMetadata['blocks']
      >
      cache.blocks[entry.value.id] = entry.value
      break
    case 'link':
      cache.links ??= []
      cache.links.push(entry.value)
      break
    case 'embed':
      cache.embeds ??= []
      cache.embeds.push(entry.value)
      break
    case 'tag':
      cache.tags ??= []
      cache.tags.push(entry.value)
      break
    case 'listItem':
      cache.listItems ??= []
      cache.listItems.push(entry.value)
      break
    case 'section':
      cache.sections ??= []
      cache.sections.push(entry.value)
      break
    case 'frontmatterLink':
      cache.frontmatterLinks ??= []
      cache.frontmatterLinks.push(entry.value)
      break
  }
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
  private sequence: number | undefined
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
        this.sequence = event.sequence
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
    this.sequence ??= stream.snapshot.sequence
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
    const sequence = this.sequence
    let retry = false
    // The pending job is a per-path epoch; unrelated edits cannot cancel it.
    const current = (): boolean =>
      !this.disposed &&
      revision === this.revision &&
      this.pending.get(path) === job
    let wasCurrent = false
    const job: Promise<void> = this.tail
      .then(async () => {
        if (current())
          retry = (await this.load(path, target, current)) === 'stale'
      })
      .finally(() => {
        wasCurrent = current()
        if (this.pending.get(path) === job) this.pending.delete(path)
        if (wasCurrent && retry && this.sequence !== sequence)
          this.request(path)
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
    const expectedSequence = this.sequence
    const captured: { page: { version: string; sequence: number } | null } = {
      page: null,
    }
    const cache: CachedMetadata = { headings: [], tags: [] }
    try {
      for await (const entry of iterateNoteMetadata(
        async (request) => {
          const result = await hibi.workspace.query(request)
          if (result.ok && result.value.kind === 'metadata') {
            if (
              expectedSequence !== undefined &&
              result.value.sequence !== expectedSequence
            )
              return {
                ok: false as const,
                code: 'stale' as const,
                message: 'This note metadata changed. Start again.',
              }
            captured.page ??= result.value
          }
          return result
        },
        { target, path },
      )) {
        if (!current()) return
        cacheEntry(cache, entry)
      }
    } catch (error) {
      if (!current()) return
      if ((error as { code?: string })?.code === 'stale')
        return 'stale' as const
      throw error
    }
    const page = captured.page
    if (!current() || !page) return
    const sequence = page.sequence
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
    const checked = await hibi.workspace.query({
      kind: 'metadata',
      target,
      path,
    })
    const after =
      checked.ok && checked.value.kind === 'metadata' ? checked.value : null
    if (!current()) return
    if (
      !after ||
      after.stale ||
      after.version !== page.version ||
      after.sequence !== sequence ||
      after.target.workspaceId !== target.workspaceId ||
      after.target.workspaceGeneration !== target.workspaceGeneration ||
      before !== versions()
    )
      return 'stale' as const
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
    const paths = this.paths()
    const basenames = noteBasenames(paths)
    const resolved: Record<string, number> = Object.create(null)
    const unresolved: Record<string, number> = Object.create(null)
    for (const link of [
      ...(cache.links ?? []),
      ...(cache.embeds ?? []),
      ...(cache.frontmatterLinks ?? []),
    ]) {
      const wiki =
        'syntax' in link
          ? link.syntax === 'wiki'
          : /^!?\[\[/.test(link.original)
      if (!wiki && /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(link.link)) continue
      const href = wiki
        ? wikiTargetName(link.link)
        : link.link.startsWith('#')
          ? ''
          : localTargetPath(path, link.link)
      if (href === null) continue
      const destination =
        href === ''
          ? path
          : wiki
            ? resolveWikiTarget(path, href, paths, basenames)
            : resolveLocalTarget(href, paths)
      const row = destination ? resolved : unresolved
      const key = destination ?? href
      if (key) row[key] = (row[key] ?? 0) + 1
    }
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
