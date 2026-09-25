import { randomUUID } from 'node:crypto'
import { type BigIntStats, constants } from 'node:fs'
import { type FileHandle, lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { BrowserWindow, WebContents } from 'electron'
import type { AddonOwner } from '../shared/foundation-contracts'
import {
  SELECTED_TEXT_MAX_BYTES,
  SELECTED_TEXT_TTL_MS,
  type SelectedTextFailure,
  type SelectedTextRead,
  type SelectedTextSelection,
} from '../shared/selected-text.ts'

type FileOps = {
  lstat: typeof lstat
  realpath: typeof realpath
  open: typeof open
}
type Fingerprint = Pick<
  BigIntStats,
  'dev' | 'ino' | 'size' | 'mtimeNs' | 'ctimeNs'
>
type Grant = {
  owner: AddonOwner
  session: WebContents
  path: string
  file: FileHandle
  fingerprint: Fingerprint
  expiresAt: number
  serviceEpoch: number
  ownerEpoch: number
  timer: ReturnType<typeof setTimeout>
}

const MAX_PENDING = 16
const MAX_ACTIVE_READS = 4
const files: FileOps = { lstat, realpath, open }
const ok = <T>(value: T) => ({ ok: true as const, value })
const fail = (code: SelectedTextFailure, message: string) => ({
  ok: false as const,
  code,
  message,
})

class SelectedTextError extends Error {
  readonly code: SelectedTextFailure

  constructor(code: SelectedTextFailure, message: string) {
    super(message)
    this.code = code
  }
}

function resultError(error: unknown) {
  if (error instanceof SelectedTextError) return fail(error.code, error.message)
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === 'EACCES' || code === 'EPERM')
    return fail('permission-denied', 'Hibi cannot read the selected file.')
  if (code === 'ELOOP' || code === 'EISDIR' || code === 'ENXIO')
    return fail('unsupported', 'Choose a regular text file.')
  if (error instanceof TypeError)
    return fail('unsupported', 'Choose a valid UTF-8 text file.')
  return fail('stale', 'The selected file changed. Choose it again.')
}

function sameFile(left: Fingerprint, right: Fingerprint): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

async function hostSelectFile(window: BrowserWindow): Promise<string | null> {
  const { dialog } = await import('electron')
  const selected = await dialog.showOpenDialog(window, {
    title: 'Choose a text file',
    properties: ['openFile'],
  })
  return selected.canceled ? null : (selected.filePaths[0] ?? null)
}

/** Main-process only. The caller must pass a window admitted by trustedWindow and a main-owned activation resolver. */
export class SelectedTextService {
  private readonly grants = new Map<string, Grant>()
  private activeReads = 0
  private serviceEpoch = 0
  private readonly ownerEpochs = new Map<string, number>()
  private readonly currentOwner: (addonId: string) => AddonOwner | null
  private readonly selectFile: (window: BrowserWindow) => Promise<string | null>
  private readonly now: () => number
  private readonly fileOps: FileOps

  constructor(
    currentOwner: (addonId: string) => AddonOwner | null,
    selectFile: (
      window: BrowserWindow,
    ) => Promise<string | null> = hostSelectFile,
    now: () => number = () => performance.now(),
    fileOps: FileOps = files,
  ) {
    this.currentOwner = currentOwner
    this.selectFile = selectFile
    this.now = now
    this.fileOps = fileOps
  }

  async select(
    window: BrowserWindow,
    addonId: unknown,
  ): Promise<SelectedTextSelection> {
    const owner = this.owner(addonId)
    const session = this.session(window)
    if (!owner || !session)
      return fail('disposed', 'Enable this addon before selecting a file.')
    const serviceEpoch = this.serviceEpoch
    const ownerEpoch = this.ownerEpochs.get(owner.addonId) ?? 0
    let path: string | null
    try {
      path = await this.selectFile(window)
    } catch {
      return fail('unsupported', 'Could not select a text file. Try again.')
    }
    if (!this.live(window, owner, session, serviceEpoch, ownerEpoch))
      return fail(
        'stale',
        'The addon or window changed. Select the file again.',
      )
    if (path === null) return ok(null)
    if (typeof path !== 'string' || path.length > 4096 || !isAbsolute(path))
      return fail('unsupported', 'Choose a regular text file.')

    let file: FileHandle | null = null
    try {
      const fingerprint = await this.inspect(path)
      if (!this.live(window, owner, session, serviceEpoch, ownerEpoch))
        throw new SelectedTextError('stale', 'The addon or window changed.')
      file = await this.fileOps.open(
        path,
        constants.O_RDONLY |
          (constants.O_NOFOLLOW ?? 0) |
          (constants.O_NONBLOCK ?? 0),
      )
      if (!this.live(window, owner, session, serviceEpoch, ownerEpoch))
        throw new SelectedTextError('stale', 'The addon or window changed.')
      const opened = await file.stat({ bigint: true })
      if (!opened.isFile() || !sameFile(fingerprint, opened))
        throw new SelectedTextError('stale', 'The selected file changed.')
      const current = await this.inspect(path)
      if (
        !sameFile(fingerprint, current) ||
        !this.live(window, owner, session, serviceEpoch, ownerEpoch)
      )
        throw new SelectedTextError('stale', 'The selected file changed.')
      this.expireOld()
      if (this.grants.size >= MAX_PENDING)
        throw new SelectedTextError('busy', 'Read an earlier selection first.')
      const handle = randomUUID()
      const timer = setTimeout(() => this.expire(handle), SELECTED_TEXT_TTL_MS)
      timer.unref()
      this.grants.set(handle, {
        owner,
        session,
        path,
        file,
        fingerprint,
        expiresAt: this.now() + SELECTED_TEXT_TTL_MS,
        serviceEpoch,
        ownerEpoch,
        timer,
      })
      file = null
      return ok({ handle })
    } catch (error) {
      return resultError(error)
    } finally {
      if (file) await file.close().catch(() => {})
    }
  }

  async read(
    window: BrowserWindow,
    addonId: unknown,
    handle: unknown,
  ): Promise<SelectedTextRead> {
    if (this.activeReads >= MAX_ACTIVE_READS)
      return fail('busy', 'Wait for another selected file to finish reading.')
    const grant = typeof handle === 'string' ? this.consume(handle) : null
    if (!grant) return fail('not-found', 'Select a file again before reading.')
    this.activeReads += 1
    try {
      if (
        grant.owner.addonId !== addonId ||
        grant.session !== this.session(window)
      )
        return fail('permission-denied', 'This file selection is unavailable.')
      if (!this.grantLive(window, grant))
        return fail('stale', 'The addon or file selection changed.')
      const current = await this.inspect(grant.path)
      if (
        !sameFile(grant.fingerprint, current) ||
        !this.grantLive(window, grant)
      )
        return fail('stale', 'The selected file changed.')
      const opened = await grant.file.stat({ bigint: true })
      if (
        !opened.isFile() ||
        !sameFile(grant.fingerprint, opened) ||
        !this.grantLive(window, grant)
      )
        return fail('stale', 'The selected file changed.')
      const bytes = Buffer.alloc(Number(opened.size) + 1)
      let length = 0
      while (length < bytes.length) {
        const chunk = await grant.file.read(
          bytes,
          length,
          bytes.length - length,
          length,
        )
        if (!this.grantLive(window, grant))
          return fail('stale', 'The addon or window changed.')
        if (!chunk.bytesRead) break
        length += chunk.bytesRead
      }
      if (length !== Number(opened.size))
        return fail('stale', 'The selected file changed.')
      const after = await grant.file.stat({ bigint: true })
      const pathAfter = await this.inspect(grant.path)
      if (
        !sameFile(grant.fingerprint, after) ||
        !sameFile(grant.fingerprint, pathAfter) ||
        !this.grantLive(window, grant)
      )
        return fail('stale', 'The selected file changed.')
      const text = new TextDecoder('utf-8', {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes.subarray(0, length))
      if (text.includes('\0'))
        return fail('unsupported', 'Choose a valid UTF-8 text file.')
      return ok(text)
    } catch (error) {
      return resultError(error)
    } finally {
      this.activeReads -= 1
      await grant.file.close().catch(() => {})
    }
  }

  revokeAddon(addonId: string): void {
    this.ownerEpochs.set(addonId, (this.ownerEpochs.get(addonId) ?? 0) + 1)
    for (const [handle, grant] of this.grants)
      if (grant.owner.addonId === addonId) this.expire(handle)
  }

  clear(): void {
    this.serviceEpoch += 1
    this.ownerEpochs.clear()
    for (const handle of this.grants.keys()) this.expire(handle)
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

  private grantLive(window: BrowserWindow, grant: Grant): boolean {
    return (
      this.now() < grant.expiresAt &&
      this.live(
        window,
        grant.owner,
        grant.session,
        grant.serviceEpoch,
        grant.ownerEpoch,
      )
    )
  }

  private async inspect(path: string): Promise<Fingerprint> {
    const stat = await this.fileOps.lstat(path, { bigint: true })
    if (!stat.isFile())
      throw new SelectedTextError('unsupported', 'Choose a regular text file.')
    if (stat.size > BigInt(SELECTED_TEXT_MAX_BYTES))
      throw new SelectedTextError(
        'limit-exceeded',
        'Choose a file under 2 MiB.',
      )
    if ((await this.fileOps.realpath(path)) !== path)
      throw new SelectedTextError(
        'unsupported',
        'Choose a file without symbolic links.',
      )
    return stat
  }

  private consume(handle: string): Grant | null {
    const grant = this.grants.get(handle)
    if (!grant) return null
    this.grants.delete(handle)
    clearTimeout(grant.timer)
    return grant
  }

  private expire(handle: string): void {
    const grant = this.consume(handle)
    if (grant) void grant.file.close().catch(() => {})
  }

  private expireOld(): void {
    for (const [handle, grant] of this.grants)
      if (this.now() >= grant.expiresAt) this.expire(handle)
  }
}
