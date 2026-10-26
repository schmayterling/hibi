import type {
  WorkspaceEntry,
  WorkspaceIndex,
  WorkspacePage,
  WorkspaceState,
} from '../shared/workspace'

// Legacy IPC sends full text in one reply; paged metadata/search has no such bound.
export const MAX_LEGACY_INDEX_BYTES = 20 * 1024 * 1024

export function checkLegacyIndexBytes(
  bytes: number,
  remaining = MAX_LEGACY_INDEX_BYTES,
): void {
  if (bytes > remaining)
    throw new Error(
      'The legacy workspace index exceeds the 20 MiB message limit. Use paged workspace queries instead.',
    )
}

export type LegacyIndexSource = {
  id: string
  version: string
  read: (maximumBytes: number) => Promise<string> | string
}

export type LegacyIndexOptions = {
  /** Workspace identity, revision, and dirty source versions. */
  key: string
  /** Small header, refreshed even on a warm read. */
  workspace: Omit<WorkspaceState, 'entries'>
  entries: readonly WorkspaceEntry[]
  documents: readonly { path: string; dirty: boolean; pending?: boolean }[]
  drafts: ReadonlyMap<string, LegacyIndexSource>
  /** Validates the path and stats the file without reading its text. */
  resolve: (path: string) => Promise<LegacyIndexSource>
  isDocument: (name: string) => boolean
  current: () => boolean
}

type CachedPage = { version: string; page: WorkspacePage; bytes: number }
type CachedIndex = {
  key: string
  entries: WorkspaceEntry[]
  pages: WorkspacePage[]
  files: Map<string, CachedPage>
  bytes: number
}

/** Owns one bounded reply; per-file entries share its page objects and strings. */
export class LegacyWorkspaceIndex {
  private cached: CachedIndex | undefined
  private generation = 0

  clear(): void {
    this.generation++
    this.cached = undefined
  }

  async read(options: LegacyIndexOptions): Promise<WorkspaceIndex | null> {
    const generation = this.generation
    const current = () => generation === this.generation && options.current()
    if (!current()) return null
    let count = 0
    let started = performance.now()
    const tick = async () => {
      if (++count % 64 === 0 || performance.now() - started >= 4) {
        await new Promise<void>((resolve) => setImmediate(resolve))
        started = performance.now()
      }
    }
    let bytes = 0
    const charge = (amount: number) => {
      bytes += amount
      if (bytes > MAX_LEGACY_INDEX_BYTES) {
        if (current()) this.cached = undefined
        checkLegacyIndexBytes(bytes)
      }
    }
    // Count escaped UTF-8 in bounded pieces without a second full-page JSON string.
    const chargeString = async (value: string) => {
      charge(2)
      for (let offset = 0; offset < value.length; ) {
        let end = Math.min(offset + 16384, value.length)
        const last = value.charCodeAt(end - 1)
        const next = value.charCodeAt(end)
        if (
          last >= 0xd800 &&
          last <= 0xdbff &&
          next >= 0xdc00 &&
          next <= 0xdfff
        )
          end--
        charge(Buffer.byteLength(JSON.stringify(value.slice(offset, end))) - 2)
        offset = end
        await tick()
        if (!current()) return
      }
    }
    // Header and individual entry/page envelopes are small, plain transport data.
    const chargeJson = (value: unknown) =>
      charge(Buffer.byteLength(JSON.stringify(value)))
    const workspace = { ...options.workspace, entries: [] as WorkspaceEntry[] }
    chargeJson({ workspace, pages: [] })
    if (this.cached?.key === options.key) {
      charge(this.cached.bytes)
      return current()
        ? {
            workspace: { ...workspace, entries: this.cached.entries },
            pages: this.cached.pages,
          }
        : null
    }
    const headerBytes = bytes
    const previous = this.cached?.files
    const files = new Map<string, CachedPage>()
    const pages: WorkspacePage[] = []
    const entries: WorkspaceEntry[] = []
    const dirty = new Set<string>()
    const pending = new Map<string, WorkspaceEntry>()
    const additions = new Map<string, WorkspaceEntry[]>()
    for (const document of options.documents) {
      if (!current()) return null
      if (document.dirty) dirty.add(document.path)
      if (document.pending) {
        const slash = document.path.lastIndexOf('/')
        const parent = document.path.slice(0, slash < 0 ? 0 : slash)
        const entry: WorkspaceEntry = {
          path: document.path,
          name: document.path.slice(slash + 1),
          kind: 'file',
        }
        pending.set(entry.path, entry)
        const siblings = additions.get(parent) ?? []
        siblings.push(entry)
        additions.set(parent, siblings)
      }
      await tick()
    }
    type Frame = {
      source: readonly WorkspaceEntry[]
      target: WorkspaceEntry[]
      extra: readonly WorkspaceEntry[]
      offset: number
    }
    const stack: Frame[] = [
      {
        source: options.entries,
        target: entries,
        extra: additions.get('') ?? [],
        offset: 0,
      },
    ]
    while (true) {
      const frame = stack.at(-1)
      if (!frame) break
      if (!current()) return null
      const offset = frame.offset++
      const original =
        offset < frame.source.length
          ? frame.source[offset]
          : frame.extra[offset - frame.source.length]
      if (!original) {
        stack.pop()
        continue
      }
      await tick()
      if (!current()) return null
      // Pending drafts replace any matching disk row and append in tab order.
      if (offset < frame.source.length && pending.has(original.path)) continue
      const entry: WorkspaceEntry = {
        path: original.path,
        name: original.name,
        kind: original.kind,
        dirty: dirty.has(original.path),
        ...(original.children ? { children: [] } : {}),
      }
      chargeJson(entry)
      charge(Number(frame.target.length > 0))
      frame.target.push(entry)
      if (original.children && entry.children) {
        stack.push({
          source: original.children,
          target: entry.children,
          extra: additions.get(original.path) ?? [],
          offset: 0,
        })
        continue
      }
      if (entry.kind !== 'file' || !options.isDocument(entry.name)) continue
      try {
        const source =
          options.drafts.get(entry.path) ?? (await options.resolve(entry.path))
        // Resolve includes stat; a stale request must never start a Markdown read.
        if (!current()) return null
        const old = previous?.get(entry.path)
        let cached: CachedPage
        if (old?.version === source.version && old.page.id === source.id) {
          cached = old
          charge(cached.bytes)
        } else {
          if (!current()) return null
          const markdown = await source.read(MAX_LEGACY_INDEX_BYTES - bytes)
          if (!current()) return null
          const page = { id: source.id, path: entry.path, markdown }
          const before = bytes
          chargeJson({ ...page, markdown: '' })
          // Empty quotes were already charged by the envelope.
          bytes -= 2
          await chargeString(markdown)
          if (!current()) return null
          cached = { version: source.version, page, bytes: bytes - before }
        }
        charge(Number(pages.length > 0))
        pages.push(cached.page)
        files.set(entry.path, cached)
      } catch (error) {
        if (!current()) return null
        // Concurrent rename/delete is reconciled by the next watcher revision.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          this.cached = undefined
          throw error
        }
      }
    }
    if (!current()) return null
    this.cached = {
      key: options.key,
      entries,
      pages,
      files,
      bytes: bytes - headerBytes,
    }
    return { workspace: { ...workspace, entries }, pages }
  }
}
