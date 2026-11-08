import type { SourceEdit } from '../../../../shared/document-edits'
import type { WorkspaceTarget } from '../../../../shared/foundation-contracts'
import type { AddonContext } from '../../../api'
import { Events, reportError } from '../core/events'
import { registerObsidianApi } from '../registry'
import type { ApiContext } from '../types'
import { vaultPath } from './paths'
import type { FileStats, VaultEntry, VaultInfo, VaultPage } from './types'

export type { FileStats } from './types'

export class TAbstractFile {
  stat: FileStats = { ctime: 0, mtime: 0, size: 0 }
  parent: TFolder | null = null
  constructor(
    public vault: Vault,
    public path: string,
  ) {}
  get name() {
    return this.path.split('/').at(-1) || this.vault.getName()
  }
}
export class TFile extends TAbstractFile {
  get extension() {
    const dot = this.name.lastIndexOf('.')
    return dot > 0 ? this.name.slice(dot + 1) : ''
  }
  get basename() {
    return this.extension
      ? this.name.slice(0, -this.extension.length - 1)
      : this.name
  }
}
export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = []
  isRoot() {
    return this.path === ''
  }
}

/** One contiguous raw edit, expanding seams rather than splitting CRLF or a character. */
export function sourceChange(before: string, after: string): SourceEdit[] {
  if (before === after) return []
  let from = 0,
    end = 0
  while (
    from < before.length &&
    from < after.length &&
    before[from] === after[from]
  )
    from++
  const boundary = (text: string, at: number) =>
    !(
      at > 0 &&
      ((text[at - 1] === '\r' && text[at] === '\n') ||
        (/[\uD800-\uDBFF]/.test(text[at - 1] ?? '') &&
          /[\uDC00-\uDFFF]/.test(text[at] ?? '')))
    )
  while (!boundary(before, from) || !boundary(after, from)) from--
  while (
    end < before.length - from &&
    end < after.length - from &&
    before[before.length - end - 1] === after[after.length - end - 1]
  )
    end++
  while (
    !boundary(before, before.length - end) ||
    !boundary(after, after.length - end)
  )
    end--
  return [
    {
      from,
      to: before.length - end,
      expectedText: before.slice(from, before.length - end),
      insert: after.slice(from, after.length - end),
    },
  ]
}

export class Vault extends Events {
  readonly #hibi: AddonContext
  readonly #files = new Map<string, TAbstractFile>()
  readonly #identities = new WeakMap<TAbstractFile, string>()
  readonly #writes = new Map<TAbstractFile, Promise<unknown>>()
  readonly #root: TFolder
  readonly #target: WorkspaceTarget
  #info: VaultInfo
  #disposed = false
  #refresh: Promise<void> = Promise.resolve()
  #stop: (() => void) | undefined
  private constructor(hibi: AddonContext, info: VaultInfo) {
    super()
    this.#hibi = hibi
    this.#info = info
    this.#target = Object.freeze({ ...info.target })
    this.#root = new TFolder(this, '')
    this.#files.set('', this.#root)
  }
  static async create(context: ApiContext) {
    const state = await context.hibi.workspace.get()
    if (!state?.id || state.workspaceGeneration === undefined)
      throw new Error('Open a vault before starting plugins.')
    const target = {
      workspaceId: state.id,
      workspaceGeneration: state.workspaceGeneration,
    } as WorkspaceTarget
    const info = await context.hibi.native.query<VaultInfo>('vaultInfo', {
      vaultId: target.workspaceId,
      target,
    })
    const vault = new Vault(context.hibi, info)
    await vault.refresh()
    const subscription = await context.hibi.workspace.subscribeChanges(
      (event) => {
        void vault
          .refresh(
            event.kind === 'content' && event.paths ? event.paths : undefined,
          )
          .catch(reportError)
      },
    )
    vault.#stop = () => subscription.dispose()
    context.register(() => vault.dispose())
    return vault
  }
  dispose() {
    this.#disposed = true
    this.#stop?.()
    this.#stop = undefined
  }
  get configDir() {
    return this.#info.configDir
  }
  get settings() {
    return this.#info.settings
  }
  get target() {
    return this.#target
  }
  getName() {
    return this.#info.name
  }
  getRoot() {
    return this.#root
  }
  getAbstractFileByPath(path: string) {
    return this.#files.get(vaultPath(path, this.configDir, true)) ?? null
  }
  getFileByPath(path: string) {
    const file = this.getAbstractFileByPath(path)
    return file instanceof TFile ? file : null
  }
  getFolderByPath(path: string) {
    const file = this.getAbstractFileByPath(path)
    return file instanceof TFolder ? file : null
  }
  getAllLoadedFiles() {
    return [...this.#files.values()]
  }
  getFiles() {
    return this.getAllLoadedFiles().filter(
      (file): file is TFile => file instanceof TFile,
    )
  }
  getMarkdownFiles() {
    return this.getFiles().filter(
      (file) => file.extension.toLowerCase() === 'md',
    )
  }
  getAllFolders(includeRoot = false) {
    return this.getAllLoadedFiles().filter(
      (file): file is TFolder =>
        file instanceof TFolder && (includeRoot || !file.isRoot()),
    )
  }
  #assert() {
    if (this.#disposed) throw new Error('This vault API has stopped.')
  }
  #path(file: TAbstractFile) {
    this.#assert()
    if (file.vault !== this || this.#files.get(file.path) !== file)
      throw new Error('This file no longer belongs to this vault.')
    return vaultPath(file.path, this.configDir)
  }
  #query<T>(method: string, data: Record<string, unknown> = {}) {
    this.#assert()
    return this.#hibi.native.query<T>(method, {
      ...data,
      vaultId: this.target.workspaceId,
      target: this.target,
    })
  }
  #invoke<T>(method: string, data: Record<string, unknown>) {
    this.#assert()
    return this.#hibi.native.invoke<T>(method, {
      ...data,
      vaultId: this.target.workspaceId,
      target: this.target,
    })
  }
  async info() {
    const info = await this.#query<VaultInfo>('vaultInfo')
    this.#assert()
    this.#info = info
    return info
  }
  refresh(paths?: readonly string[]) {
    const result = this.#refresh.then(async () => {
      const info = await this.info()
      if (paths) {
        for (const path of new Set(paths)) {
          const file = this.#files.get(path)
          if (!file) continue
          const entry = await this.#query<VaultEntry | null>('vaultStat', {
            path,
          })
          this.#assert()
          if (!entry) continue
          const changed =
            file.stat.ctime !== entry.stat.ctime ||
            file.stat.mtime !== entry.stat.mtime ||
            file.stat.size !== entry.stat.size
          file.stat = { ...entry.stat }
          this.#identities.set(file, entry.identity)
          if (changed) this.trigger('modify', file)
        }
        return
      }
      const root = await this.#query<VaultEntry | null>('vaultStat', {
        path: '',
      })
      if (root) this.#root.stat = { ...root.stat }
      const entries: VaultEntry[] = []
      let cursor: string | null = null
      do {
        const page: VaultPage = await this.#query('vaultList', {
          sequence: info.sequence,
          ...(cursor ? { cursor } : {}),
        })
        entries.push(...page.entries)
        cursor = page.nextCursor
      } while (cursor)
      this.#assert()
      this.#reconcile(entries)
    })
    this.#refresh = result.catch(() => {})
    return result
  }
  #reconcile(entries: VaultEntry[]) {
    const old = new Map(this.#files)
    const incoming = new Set(entries.map((entry) => entry.path))
    const moved = new Map<string, TAbstractFile>()
    for (const [path, file] of old)
      if (path && !incoming.has(path))
        moved.set(this.#identities.get(file) ?? path, file)
    const changes: [string, TAbstractFile, string?][] = []
    this.#files.clear()
    this.#files.set('', this.#root)
    this.#root.children = []
    for (const entry of entries) {
      let file = old.get(entry.path)
      if (!file || (entry.kind === 'file') !== file instanceof TFile) {
        file = moved.get(entry.identity)
        if (file) {
          changes.push(['rename', file, file.path])
          old.delete(file.path)
          moved.delete(entry.identity)
          file.path = entry.path
        } else {
          file =
            entry.kind === 'file'
              ? new TFile(this, entry.path)
              : new TFolder(this, entry.path)
          changes.push(['create', file])
        }
      } else if (
        file instanceof TFile &&
        (file.stat.ctime !== entry.stat.ctime ||
          file.stat.mtime !== entry.stat.mtime ||
          file.stat.size !== entry.stat.size)
      )
        changes.push(['modify', file])
      file.stat = { ...entry.stat }
      if (file instanceof TFolder) file.children = []
      this.#identities.set(file, entry.identity)
      this.#files.set(entry.path, file)
    }
    for (const [path, file] of old)
      if (path && !this.#files.has(path)) changes.push(['delete', file])
    for (const [path, file] of this.#files)
      if (path) {
        const parent = this.#files.get(
          path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
        )
        file.parent = parent instanceof TFolder ? parent : null
        file.parent?.children.push(file)
      }
    for (const [name, file, oldPath] of changes)
      this.trigger(name, file, ...(oldPath === undefined ? [] : [oldPath]))
  }
  #open(path: string, info: VaultInfo) {
    const mapped = info.documents.find((document) => document.path === path)
    if (!mapped) return null
    const document = this.#hibi.documents
      .listOpen()
      .find((document) => document.tabId === mapped.tabId)
    if (!document) throw new Error('This document session changed. Try again.')
    return document
  }
  async read(file: TFile) {
    const path = this.#path(file)
    const info = await this.info()
    const open = this.#open(path, info)
    if (open) {
      const read = this.#hibi.documents.readSource(open.target)
      if (read.status !== 'read') throw new Error(read.message)
      return read.source
    }
    const read = await this.#hibi.workspace.readText(this.target, path)
    if (!read.ok) throw new Error(read.message)
    return read.value.markdown
  }
  cachedRead(file: TFile) {
    return this.read(file)
  }
  async readBinary(file: TFile) {
    const read = await this.#hibi.workspace.readBinary(
      this.target,
      this.#path(file),
    )
    if (!read.ok) throw new Error(read.message)
    return Uint8Array.from(read.value.bytes).buffer
  }
  #serialize<T>(file: TAbstractFile, run: () => Promise<T>) {
    const result = (this.#writes.get(file) ?? Promise.resolve())
      .catch(() => {})
      .then(run)
    this.#writes.set(file, result)
    void result.then(
      () => {
        if (this.#writes.get(file) === result) this.#writes.delete(file)
      },
      () => {
        if (this.#writes.get(file) === result) this.#writes.delete(file)
      },
    )
    return result
  }
  process(file: TFile, transform: (source: string) => string) {
    return this.#serialize(file, async () => {
      const path = this.#path(file)
      const info = await this.info()
      const open = this.#open(path, info)
      const read = open
        ? this.#hibi.documents.readSource(open.target)
        : await this.#hibi.workspace.readText(this.target, path)
      if ('status' in read && read.status !== 'read')
        throw new Error(read.message)
      if ('ok' in read && !read.ok) throw new Error(read.message)
      const before = 'status' in read ? read.source : read.value.markdown
      const after = transform(before)
      if (typeof after !== 'string')
        throw new Error('Vault.process requires a synchronous text callback.')
      if (after === before) return after
      if ('status' in read) {
        const result = this.#hibi.documents.applyEdits({
          requestId: `obsidian:${crypto.randomUUID()}`,
          target: read.target,
          changes: sourceChange(before, after),
        })
        if (result.status !== 'applied') throw new Error(result.message)
        const saved = await this.#hibi.documents.save({
          ...read.target,
          contentVersion: result.contentVersion,
        })
        if (saved.status !== 'saved' && saved.status !== 'clean')
          throw new Error(
            'message' in saved
              ? saved.message
              : 'This document could not be saved.',
          )
      } else {
        const result = await this.#hibi.workspace.updateText(
          this.target,
          path,
          read.value.version,
          after,
          { allowMetadataReset: true },
        )
        if (!result.ok) throw new Error(result.message)
      }
      await this.refresh([path])
      return after
    })
  }
  async modify(file: TFile, data: string) {
    await this.process(file, () => data)
  }
  async append(file: TFile, data: string) {
    await this.process(file, (before) => before + data)
  }
  async create(path: string, data: string) {
    this.#assert()
    path = vaultPath(path, this.configDir)
    const result = await this.#hibi.workspace.createText(
      this.target,
      path,
      data,
    )
    if (!result.ok) throw new Error(result.message)
    await this.refresh()
    const file = this.getFileByPath(path)
    if (!file)
      throw new Error('The created file is not available in the vault tree.')
    return file
  }
  async createBinary(path: string, data: ArrayBuffer) {
    this.#assert()
    path = vaultPath(path, this.configDir)
    const result = await this.#hibi.workspace.createBinary(
      this.target,
      path,
      new Uint8Array(data),
    )
    if (!result.ok) throw new Error(result.message)
    await this.refresh()
    const file = this.getFileByPath(path)
    if (!file)
      throw new Error(
        'The created attachment is not available in the vault tree.',
      )
    return file
  }
  async createFolder(path: string) {
    await this.#invoke('vaultCreateFolder', {
      path: vaultPath(path, this.configDir),
    })
    await this.refresh()
    const folder = this.getFolderByPath(path)
    if (!folder)
      throw new Error('The created folder is not available in the vault tree.')
    return folder
  }
  async rename(file: TAbstractFile, path: string) {
    await this.#serialize(file, () =>
      this.#invoke('vaultAction', {
        action: 'rename',
        path: this.#path(file),
        destination: vaultPath(path, this.configDir),
      }),
    )
    await this.refresh()
  }
  async delete(file: TAbstractFile) {
    await this.#serialize(file, () =>
      this.#invoke('vaultAction', { action: 'delete', path: this.#path(file) }),
    )
    await this.refresh()
  }
  trash(file: TAbstractFile, _system = true) {
    return this.delete(file)
  }
  async copy<T extends TAbstractFile>(file: T, path: string): Promise<T> {
    await this.#serialize(file, () =>
      this.#invoke('vaultAction', {
        action: 'copy',
        path: this.#path(file),
        destination: vaultPath(path, this.configDir),
      }),
    )
    await this.refresh()
    const result = this.getAbstractFileByPath(path)
    if (!result)
      throw new Error('The copied file is not available in the vault tree.')
    return result as T
  }
  readonly adapter = {
    exists: async (path: string) =>
      (await this.#query<VaultEntry | null>('vaultStat', {
        path: vaultPath(path, this.configDir, true),
      })) !== null,
    stat: async (path: string) => {
      const entry = await this.#query<VaultEntry | null>('vaultStat', {
        path: vaultPath(path, this.configDir, true),
      })
      return entry ? { ...entry.stat, type: entry.kind } : null
    },
    read: async (path: string) => {
      const file = this.getFileByPath(path)
      if (!file) throw new Error('This vault file is unavailable.')
      return this.read(file)
    },
    write: async (path: string, data: string) => {
      const file = this.getFileByPath(path)
      if (file) await this.modify(file, data)
      else await this.create(path, data)
    },
    list: async (path: string) => {
      await this.refresh()
      const folder = this.getFolderByPath(path)
      if (!folder) throw new Error('This vault folder is unavailable.')
      return {
        files: folder.children
          .filter((file) => file instanceof TFile)
          .map((file) => file.path),
        folders: folder.children
          .filter((file) => file instanceof TFolder)
          .map((file) => file.path),
      }
    },
  }
}

declare module '../types' {
  interface VaultApi extends Vault {}
}

registerObsidianApi({
  id: 'vault',
  async create(context) {
    const vault = await Vault.create(context)
    return { app: { vault }, exports: { Vault, TAbstractFile, TFile, TFolder } }
  },
})
