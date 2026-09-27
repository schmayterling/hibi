import { randomUUID } from 'node:crypto'
import { type BigIntStats, constants } from 'node:fs'
import {
  type FileHandle,
  link,
  lstat,
  open,
  realpath,
  unlink,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { BrowserWindow, WebContents } from 'electron'
import type { AddonOwner } from '../shared/foundation-contracts'
import {
  HOST_SELECTED_IO_MAX_BYTES,
  HOST_SELECTED_IO_TTL_MS,
  type HostExportChoice,
  type HostImportChoice,
  type HostSelectedIoCancel,
  type HostSelectedIoFailure,
  type HostSelectedIoRead,
  type HostSelectedIoSelection,
  type HostSelectedIoWrite,
} from '../shared/host-selected-io.ts'

const MAX_GRANTS = 16
const MAX_ACTIVE = 4
const CHUNK_BYTES = 64 * 1024

type FileOps = {
  lstat: typeof lstat
  realpath: typeof realpath
  open: typeof open
  link: typeof link
  unlink: typeof unlink
}
type Parent = { path: string; dev: bigint; ino: bigint }
type GrantBase = {
  owner: AddonOwner
  session: WebContents
  parent: Parent
  path: string
  expiresAt: number
  serviceEpoch: number
  ownerEpoch: number
  timer: ReturnType<typeof setTimeout>
  busy: boolean
  reason: 'cancelled' | 'stale' | null
}
type ImportGrant = GrantBase & {
  action: 'import'
  file: FileHandle
  fingerprint: BigIntStats
}
type ExportGrant = GrantBase & { action: 'export' }
type Grant = ImportGrant | ExportGrant

export type HostSelectedIoOptions = {
  selectImport?: (
    window: BrowserWindow,
    choice: HostImportChoice,
  ) => Promise<string | null>
  selectExport?: (
    window: BrowserWindow,
    choice: HostExportChoice,
  ) => Promise<string | null>
  now?: () => number
  files?: FileOps
  isOpenDocument: (path: string) => boolean
}

const files: FileOps = { lstat, realpath, open, link, unlink }
const ok = <T>(value: T) => ({ ok: true as const, value })
const fail = (code: HostSelectedIoFailure, message: string) => ({
  ok: false as const,
  code,
  message,
})

class IoFailure extends Error {
  readonly code: HostSelectedIoFailure

  constructor(code: HostSelectedIoFailure, message: string) {
    super(message)
    this.code = code
  }
}

function failure(error: unknown) {
  if (error instanceof IoFailure) return fail(error.code, error.message)
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === 'EEXIST')
    return fail('conflict', 'A file already exists at the selected name.')
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS')
    return fail('permission-denied', 'The selected file cannot be accessed.')
  if (code === 'ELOOP' || code === 'EISDIR' || code === 'ENXIO')
    return fail('unsupported', 'Choose a regular file.')
  if (code === 'ENOTSUP' || code === 'EOPNOTSUPP')
    return fail('unsupported', 'This volume cannot publish exports atomically.')
  return fail('stale', 'The selected file or folder changed. Choose it again.')
}

function sameFile(a: BigIntStats, b: BigIntStats) {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs &&
    a.mode === b.mode &&
    a.nlink === b.nlink
  )
}

function importChoice(value: unknown): HostImportChoice {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new IoFailure('unsupported', 'Choose valid import options.')
  const extensions = (value as HostImportChoice).extensions
  if (extensions === undefined) return {}
  if (
    !Array.isArray(extensions) ||
    extensions.length > 8 ||
    extensions.some(
      (extension) =>
        typeof extension !== 'string' || !/^[a-z0-9]{1,12}$/.test(extension),
    )
  )
    throw new IoFailure('unsupported', 'Choose valid import extensions.')
  return { extensions: [...new Set(extensions)] }
}

function exportChoice(value: unknown): HostExportChoice {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new IoFailure('unsupported', 'Choose a valid export name.')
  const { suggestedName, extension } = value as HostExportChoice
  if (
    typeof suggestedName !== 'string' ||
    !suggestedName ||
    suggestedName.length > 128 ||
    suggestedName === '.' ||
    suggestedName === '..' ||
    /[\\/:*?"<>|\p{Cc}]|[. ]$/u.test(suggestedName) ||
    (extension !== undefined &&
      (typeof extension !== 'string' || !/^[a-z0-9]{1,12}$/.test(extension)))
  )
    throw new IoFailure('unsupported', 'Choose a valid export name.')
  return { suggestedName, ...(extension ? { extension } : {}) }
}

async function selectImportDialog(
  window: BrowserWindow,
  choice: HostImportChoice,
) {
  const { dialog } = await import('electron')
  const result = await dialog.showOpenDialog(window, {
    title: 'Import file',
    properties: ['openFile'],
    ...(choice.extensions?.length
      ? {
          filters: [
            { name: 'Import files', extensions: [...choice.extensions] },
          ],
        }
      : {}),
  })
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

async function selectExportDialog(
  window: BrowserWindow,
  choice: HostExportChoice,
) {
  const { dialog } = await import('electron')
  const result = await dialog.showSaveDialog(window, {
    title: 'Export file',
    defaultPath: choice.suggestedName,
    ...(choice.extension
      ? {
          filters: [{ name: choice.extension, extensions: [choice.extension] }],
        }
      : {}),
  })
  return result.canceled ? null : (result.filePath ?? null)
}

/** Main-process only; IPC must pass a trustedWindow and a main-owned activation resolver. */
export class HostSelectedIoService {
  private readonly grants = new Map<string, Grant>()
  private readonly ownerEpochs = new Map<string, number>()
  private serviceEpoch = 0
  private active = 0
  private selecting = false
  private readonly selectImportFile: NonNullable<
    HostSelectedIoOptions['selectImport']
  >
  private readonly selectExportFile: NonNullable<
    HostSelectedIoOptions['selectExport']
  >
  private readonly now: () => number
  private readonly fs: FileOps
  private readonly isOpenDocument: (path: string) => boolean
  private readonly currentOwner: (addonId: string) => AddonOwner | null

  constructor(
    currentOwner: (addonId: string) => AddonOwner | null,
    options: HostSelectedIoOptions,
  ) {
    this.currentOwner = currentOwner
    this.selectImportFile = options.selectImport ?? selectImportDialog
    this.selectExportFile = options.selectExport ?? selectExportDialog
    this.now = options.now ?? (() => performance.now())
    this.fs = options.files ?? files
    this.isOpenDocument = options.isOpenDocument
  }

  async selectImport(
    window: BrowserWindow,
    addonId: unknown,
    options: unknown = undefined,
  ): Promise<HostSelectedIoSelection> {
    const owner = this.owner(addonId),
      session = this.session(window)
    if (!owner || !session)
      return fail('disposed', 'Enable this addon before importing.')
    if (this.selecting)
      return fail('busy', 'Finish the current file selection first.')
    this.selecting = true
    const serviceEpoch = this.serviceEpoch,
      ownerEpoch = this.ownerEpochs.get(owner.addonId) ?? 0
    let file: FileHandle | null = null
    try {
      const choice = importChoice(options)
      const selected = await this.selectImportFile(window, choice)
      if (!this.live(window, owner, session, serviceEpoch, ownerEpoch))
        throw new IoFailure('stale', 'The addon or window changed.')
      if (selected === null) return ok(null)
      const { path, parent } = await this.selectedPath(selected)
      const before = await this.fs.lstat(path, { bigint: true })
      if (!before.isFile())
        throw new IoFailure('unsupported', 'Choose a regular file.')
      if (before.size > BigInt(HOST_SELECTED_IO_MAX_BYTES))
        throw new IoFailure('limit-exceeded', 'Choose a file under 16 MiB.')
      file = await this.fs.open(
        path,
        constants.O_RDONLY |
          (constants.O_NOFOLLOW ?? 0) |
          (constants.O_NONBLOCK ?? 0),
      )
      const opened = await file.stat({ bigint: true })
      if (!opened.isFile() || !sameFile(before, opened))
        throw new IoFailure('stale', 'The selected file changed.')
      await this.verifyFile(path, parent, before)
      if (!this.live(window, owner, session, serviceEpoch, ownerEpoch))
        throw new IoFailure('stale', 'The addon or window changed.')
      const handle = this.issue({
        action: 'import',
        owner,
        session,
        serviceEpoch,
        ownerEpoch,
        parent,
        path,
        file,
        fingerprint: before,
      })
      file = null
      return ok({ handle, name: basename(path) })
    } catch (error) {
      return failure(error)
    } finally {
      if (file) await file.close().catch(() => {})
      this.selecting = false
    }
  }

  async selectExport(
    window: BrowserWindow,
    addonId: unknown,
    options: unknown,
  ): Promise<HostSelectedIoSelection> {
    const owner = this.owner(addonId),
      session = this.session(window)
    if (!owner || !session)
      return fail('disposed', 'Enable this addon before exporting.')
    if (this.selecting)
      return fail('busy', 'Finish the current file selection first.')
    this.selecting = true
    const serviceEpoch = this.serviceEpoch,
      ownerEpoch = this.ownerEpochs.get(owner.addonId) ?? 0
    try {
      const choice = exportChoice(options)
      const selected = await this.selectExportFile(window, choice)
      if (!this.live(window, owner, session, serviceEpoch, ownerEpoch))
        throw new IoFailure('stale', 'The addon or window changed.')
      if (selected === null) return ok(null)
      const { path, parent } = await this.selectedPath(selected)
      await this.absent(path)
      if (this.isOpenDocument(path))
        throw new IoFailure('conflict', 'A document is open at that name.')
      await this.verifyParent(parent)
      if (!this.live(window, owner, session, serviceEpoch, ownerEpoch))
        throw new IoFailure('stale', 'The addon or window changed.')
      const handle = this.issue({
        action: 'export',
        owner,
        session,
        serviceEpoch,
        ownerEpoch,
        parent,
        path,
      })
      return ok({ handle, name: basename(path) })
    } catch (error) {
      return failure(error)
    } finally {
      this.selecting = false
    }
  }

  async readImport(
    window: BrowserWindow,
    addonId: unknown,
    handle: unknown,
  ): Promise<HostSelectedIoRead> {
    const grant = this.authorized(window, addonId, handle)
    if (!grant || grant.action !== 'import')
      return fail('not-found', 'Select a file before importing.')
    if (this.active >= MAX_ACTIVE || grant.busy)
      return fail('busy', 'Wait for the selected file to finish.')
    grant.busy = true
    this.active++
    try {
      this.assertLive(window, grant)
      await this.verifyFile(grant.path, grant.parent, grant.fingerprint)
      const opened = await grant.file.stat({ bigint: true })
      if (!opened.isFile() || !sameFile(grant.fingerprint, opened))
        throw new IoFailure('stale', 'The selected file changed.')
      const bytes = Buffer.alloc(Number(opened.size) + 1)
      let length = 0
      while (length < bytes.length) {
        this.assertLive(window, grant)
        const chunk = await grant.file.read(
          bytes,
          length,
          Math.min(CHUNK_BYTES, bytes.length - length),
          length,
        )
        this.assertLive(window, grant)
        if (!chunk.bytesRead) break
        length += chunk.bytesRead
      }
      if (length !== Number(opened.size))
        throw new IoFailure('stale', 'The selected file changed.')
      const after = await grant.file.stat({ bigint: true })
      if (!sameFile(grant.fingerprint, after))
        throw new IoFailure('stale', 'The selected file changed.')
      await this.verifyFile(grant.path, grant.parent, grant.fingerprint)
      this.assertLive(window, grant)
      return ok(bytes.subarray(0, length))
    } catch (error) {
      return failure(error)
    } finally {
      this.active--
      await this.finish(handle as string, grant)
    }
  }

  async writeExport(
    window: BrowserWindow,
    addonId: unknown,
    handle: unknown,
    value: unknown,
  ): Promise<HostSelectedIoWrite> {
    const grant = this.authorized(window, addonId, handle)
    if (!grant || grant.action !== 'export')
      return fail('not-found', 'Choose a file name before exporting.')
    if (!(value instanceof Uint8Array))
      return fail('unsupported', 'Export bytes must be a byte array.')
    if (value.byteLength > HOST_SELECTED_IO_MAX_BYTES)
      return fail('limit-exceeded', 'Export at most 16 MiB.')
    if (this.active >= MAX_ACTIVE || grant.busy)
      return fail('busy', 'Wait for the selected export to finish.')
    grant.busy = true
    this.active++
    const bytes = Buffer.from(value)
    const temporary = join(grant.parent.path, `.${randomUUID()}.tmp`)
    let staged: FileHandle | null = null
    let stagedCreated = false
    try {
      this.assertLive(window, grant)
      await this.verifyParent(grant.parent)
      staged = await this.fs.open(temporary, 'wx', 0o600)
      stagedCreated = true
      let offset = 0
      while (offset < bytes.length) {
        this.assertLive(window, grant)
        const chunk = await staged.write(
          bytes,
          offset,
          Math.min(CHUNK_BYTES, bytes.length - offset),
          offset,
        )
        if (!chunk.bytesWritten)
          throw new IoFailure('stale', 'The export could not be staged.')
        offset += chunk.bytesWritten
      }
      await staged.sync()
      const stagedInfo = await staged.stat({ bigint: true })
      await staged.close()
      staged = null
      this.assertLive(window, grant)
      await this.verifyParent(grant.parent)
      const stagedPath = await this.fs.lstat(temporary, { bigint: true })
      if (
        !stagedInfo.isFile() ||
        stagedInfo.nlink !== 1n ||
        !sameFile(stagedInfo, stagedPath)
      )
        throw new IoFailure('stale', 'The staged export changed.')
      await this.absent(grant.path)
      if (this.isOpenDocument(grant.path))
        throw new IoFailure('conflict', 'A document is open at that name.')
      this.assertLive(window, grant)
      // ponytail: portable Node lacks directory-handle-relative link; a same-user
      // parent swap after this check needs native openat-style IO to rule out.
      await this.fs.link(temporary, grant.path)
      const directorySynced = await this.syncDirectory(grant.parent.path)
      return ok({
        bytes: bytes.length,
        atomicVisibility: true,
        directorySynced,
      })
    } catch (error) {
      return failure(error)
    } finally {
      if (staged) await staged.close().catch(() => {})
      if (stagedCreated) await this.fs.unlink(temporary).catch(() => {})
      this.active--
      await this.finish(handle as string, grant)
      bytes.fill(0)
    }
  }

  async cancel(
    window: BrowserWindow,
    addonId: unknown,
    handle: unknown,
  ): Promise<HostSelectedIoCancel> {
    const grant = this.authorized(window, addonId, handle)
    if (!grant) return fail('not-found', 'This file selection is unavailable.')
    await this.expire(handle as string, 'cancelled')
    return ok(null)
  }

  revokeAddon(addonId: string): void {
    this.ownerEpochs.set(addonId, (this.ownerEpochs.get(addonId) ?? 0) + 1)
    for (const [handle, grant] of this.grants)
      if (grant.owner.addonId === addonId) void this.expire(handle, 'stale')
  }

  clear(): void {
    this.serviceEpoch++
    this.ownerEpochs.clear()
    for (const handle of this.grants.keys()) void this.expire(handle, 'stale')
  }

  private owner(addonId: unknown): AddonOwner | null {
    if (typeof addonId !== 'string') return null
    try {
      const owner = this.currentOwner(addonId)
      return owner?.addonId === addonId &&
        Number.isSafeInteger(owner.activationGeneration) &&
        owner.activationGeneration >= 0
        ? { ...owner }
        : null
    } catch {
      return null
    }
  }

  private session(window: BrowserWindow): WebContents | null {
    try {
      if (window.isDestroyed()) return null
      const session = window.webContents
      return session.isDestroyed() ? null : session
    } catch {
      return null
    }
  }

  private live(
    window: BrowserWindow,
    owner: AddonOwner,
    session: WebContents,
    serviceEpoch: number,
    ownerEpoch: number,
  ): boolean {
    return (
      this.serviceEpoch === serviceEpoch &&
      (this.ownerEpochs.get(owner.addonId) ?? 0) === ownerEpoch &&
      this.session(window) === session &&
      this.owner(owner.addonId)?.activationGeneration ===
        owner.activationGeneration
    )
  }

  private assertLive(window: BrowserWindow, grant: Grant) {
    if (grant.reason)
      throw new IoFailure(grant.reason, 'The file selection ended.')
    if (
      this.now() >= grant.expiresAt ||
      !this.live(
        window,
        grant.owner,
        grant.session,
        grant.serviceEpoch,
        grant.ownerEpoch,
      )
    )
      throw new IoFailure('stale', 'The addon or file selection changed.')
  }

  private authorized(
    window: BrowserWindow,
    addonId: unknown,
    handle: unknown,
  ): Grant | null {
    if (typeof handle !== 'string') return null
    const grant = this.grants.get(handle)
    if (
      !grant ||
      grant.owner.addonId !== addonId ||
      grant.session !== this.session(window)
    )
      return null
    return grant
  }

  private issue(
    grant:
      | Omit<ImportGrant, 'busy' | 'reason' | 'expiresAt' | 'timer'>
      | Omit<ExportGrant, 'busy' | 'reason' | 'expiresAt' | 'timer'>,
  ): string {
    for (const [handle, existing] of this.grants)
      if (this.now() >= existing.expiresAt) void this.expire(handle, 'stale')
    if (this.grants.size >= MAX_GRANTS)
      throw new IoFailure('busy', 'Finish an earlier file selection first.')
    const handle = randomUUID()
    const timer = setTimeout(
      () => void this.expire(handle, 'stale'),
      HOST_SELECTED_IO_TTL_MS,
    )
    timer.unref()
    this.grants.set(handle, {
      ...grant,
      busy: false,
      reason: null,
      expiresAt: this.now() + HOST_SELECTED_IO_TTL_MS,
      timer,
    } as Grant)
    return handle
  }

  private async expire(handle: string, reason: 'cancelled' | 'stale') {
    const grant = this.grants.get(handle)
    if (!grant) return
    grant.reason ??= reason
    if (!grant.busy) await this.finish(handle, grant)
  }

  private async finish(handle: string, grant: Grant) {
    if (this.grants.get(handle) !== grant) return
    this.grants.delete(handle)
    clearTimeout(grant.timer)
    if (grant.action === 'import') await grant.file.close().catch(() => {})
  }

  private async selectedPath(
    value: unknown,
  ): Promise<{ path: string; parent: Parent }> {
    if (typeof value !== 'string' || value.length > 4096 || !isAbsolute(value))
      throw new IoFailure('unsupported', 'Choose a valid file.')
    const parentPath = await this.fs.realpath(dirname(value))
    const info = await this.fs.lstat(parentPath, { bigint: true })
    if (!info.isDirectory())
      throw new IoFailure('unsupported', 'Choose a file in a folder.')
    return {
      path: join(parentPath, basename(value)),
      parent: { path: parentPath, dev: info.dev, ino: info.ino },
    }
  }

  private async verifyParent(parent: Parent) {
    const info = await this.fs.lstat(parent.path, { bigint: true })
    if (
      !info.isDirectory() ||
      info.dev !== parent.dev ||
      info.ino !== parent.ino ||
      (await this.fs.realpath(parent.path)) !== parent.path
    )
      throw new IoFailure('stale', 'The selected folder changed.')
  }

  private async verifyFile(
    path: string,
    parent: Parent,
    expected: BigIntStats,
  ) {
    await this.verifyParent(parent)
    const info = await this.fs.lstat(path, { bigint: true })
    if (!info.isFile() || !sameFile(info, expected))
      throw new IoFailure('stale', 'The selected file changed.')
  }

  private async absent(path: string) {
    try {
      await this.fs.lstat(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    throw new IoFailure(
      'conflict',
      'A file already exists at the selected name.',
    )
  }

  private async syncDirectory(path: string) {
    if (process.platform === 'win32') return false
    try {
      const directory = await this.fs.open(path, 'r')
      try {
        await directory.sync()
        return true
      } finally {
        await directory.close()
      }
    } catch {
      return false
    }
  }
}
