import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import type { AddonOwner } from '../shared/foundation-contracts'
import type {
  CredentialAvailability,
  CredentialFailure,
  CredentialMode,
  CredentialResult,
  CredentialStatus,
} from '../shared/host-credentials'

const MAX_ACTIVE = 4
const MAX_PER_OWNER = 2
const MAX_KEYS = 32
const MAX_SECRET_BYTES = 8 * 1024
const MAX_CIPHER_BYTES = 32 * 1024
const MAX_FILE_BYTES = 512 * 1024
const keyPattern = /^[a-z][a-z0-9-]{0,63}$/
const protectedLinux = new Set([
  'gnome_libsecret',
  'kwallet',
  'kwallet5',
  'kwallet6',
])

type SafeStorage = {
  isAsyncEncryptionAvailable(): Promise<boolean>
  encryptStringAsync(value: string): Promise<Buffer>
  decryptStringAsync(value: Buffer): Promise<{
    result: string
    shouldReEncrypt: boolean
  }>
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}
type Options = {
  /** Pass an app-owned private directory, never a path from the renderer. */
  directory: string
  storage: SafeStorage
  platform?: NodeJS.Platform
  /** Main-owned activation and renderer-session identity, never client generations. */
  currentOwner: (addonId: string) => AddonOwner | null
  isWindowLive: (windowKey: object) => boolean
}
type Entry = { key: string; ciphertext: string }
type Active = {
  owner: AddonOwner
  windowKey: object
  controller: AbortController
  revoked: boolean
  committed: boolean
}
type SessionEntry = {
  owner: AddonOwner
  bytes: Buffer
}

class VaultFailure extends Error {
  readonly code: CredentialFailure
  constructor(code: CredentialFailure) {
    super(code)
    this.code = code
  }
}

const fail = (code: CredentialFailure): never => {
  throw new VaultFailure(code)
}

function decodeKey(input: unknown): string {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    !Object.hasOwn(input, 'key') ||
    Object.keys(input).length !== 1
  )
    return fail('invalid-request')
  const key = (input as { key: unknown }).key
  if (typeof key !== 'string' || !keyPattern.test(key))
    return fail('invalid-request')
  return key
}

function decodeStore(input: unknown): {
  key: string
  secret: string
  mode: CredentialMode
} {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).length !== 3 ||
    !Object.hasOwn(input, 'key') ||
    !Object.hasOwn(input, 'secret') ||
    !Object.hasOwn(input, 'mode')
  )
    return fail('invalid-request')
  const { key, secret, mode } = input as Record<string, unknown>
  if (
    typeof key !== 'string' ||
    !keyPattern.test(key) ||
    typeof secret !== 'string' ||
    !secret ||
    (mode !== 'persistent' && mode !== 'session') ||
    Buffer.byteLength(secret, 'utf8') > MAX_SECRET_BYTES ||
    secret.includes('\0')
  )
    return fail('invalid-request')
  const bytes = Buffer.from(secret, 'utf8')
  const wellFormed = bytes.toString('utf8') === secret
  bytes.fill(0)
  if (!wellFormed) return fail('invalid-request')
  return { key, secret, mode }
}

function decodeFile(bytes: Buffer): Entry[] {
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    return fail('corrupt')
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value as { version?: unknown }).version !== 1 ||
    !Array.isArray((value as { entries?: unknown }).entries)
  )
    return fail('corrupt')
  const entries = (value as { entries: unknown[] }).entries
  if (entries.length > MAX_KEYS) return fail('corrupt')
  const seen = new Set<string>()
  return entries.map((entry): Entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      return fail('corrupt')
    const { key, ciphertext } = entry as Record<string, unknown>
    if (
      typeof key !== 'string' ||
      !keyPattern.test(key) ||
      seen.has(key) ||
      typeof ciphertext !== 'string' ||
      !ciphertext ||
      ciphertext.length > MAX_CIPHER_BYTES * 2 ||
      Buffer.from(ciphertext, 'base64').toString('base64') !== ciphertext ||
      Buffer.from(ciphertext, 'base64').length > MAX_CIPHER_BYTES
    )
      return fail('corrupt')
    seen.add(key)
    return { key, ciphertext }
  })
}

async function readEntries(path: string): Promise<Entry[]> {
  let file: Awaited<ReturnType<typeof open>>
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink()) return fail('corrupt')
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    return fail('io-error')
  }
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return fail('corrupt')
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1)
    let size = 0
    while (size < bytes.length) {
      const result = await file.read(bytes, size, bytes.length - size, null)
      if (!result.bytesRead) break
      size += result.bytesRead
    }
    if (size > MAX_FILE_BYTES) return fail('corrupt')
    return decodeFile(bytes.subarray(0, size))
  } finally {
    await file.close()
  }
}

async function writeEntries(
  directory: string,
  path: string,
  entries: readonly Entry[],
  beforeCommit: () => Promise<void>,
  commitGuard: () => void,
  onCommitted: () => void,
  platform: NodeJS.Platform,
): Promise<void> {
  const bytes = Buffer.from(JSON.stringify({ version: 1, entries }), 'utf8')
  if (bytes.length > MAX_FILE_BYTES) return fail('limit-exceeded')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const folder = await lstat(directory)
  if (
    !folder.isDirectory() ||
    folder.isSymbolicLink() ||
    (platform !== 'win32' && (folder.mode & 0o077) !== 0)
  )
    return fail('io-error')
  const temp = join(directory, `.${basename(path)}.${randomUUID()}.tmp`)
  try {
    const file = await open(temp, 'wx', 0o600)
    try {
      await file.writeFile(bytes)
      await file.sync()
    } finally {
      await file.close()
    }
    await beforeCommit()
    commitGuard()
    await rename(temp, path)
    onCommitted()
  } finally {
    await rm(temp, { force: true }).catch(() => {})
    bytes.fill(0)
  }
}

/** Host-only encrypted vault. Addons share a renderer; scope is cooperative, not hostile isolation. */
export class HostCredentials {
  readonly #options: Options
  readonly #platform: NodeJS.Platform
  readonly #active = new Set<Active>()
  readonly #session = new Map<object, Map<string, SessionEntry>>()
  readonly #stopped = new Map<string, number>()
  readonly #stoppedWindows = new WeakSet<object>()
  #tail: Promise<void> = Promise.resolve()
  #disposed = false

  constructor(options: Options) {
    if (!isAbsolute(options.directory))
      throw new Error('Invalid credential directory.')
    this.#options = options
    this.#platform = options.platform ?? process.platform
  }

  #path(addonId: string) {
    return join(this.#options.directory, `${addonId}.json`)
  }

  #sessionKey(addonId: string, key: string) {
    return `${addonId}\0${key}`
  }

  #clearSession(windowKey: object, id: string): boolean {
    const entries = this.#session.get(windowKey)
    if (!entries) return false
    const entry = entries.get(id)
    if (!entry) return false
    entry.bytes.fill(0)
    entries.delete(id)
    if (!entries.size) this.#session.delete(windowKey)
    return true
  }

  #guard(active: Active) {
    const current = this.#options.currentOwner(active.owner.addonId)
    if (
      this.#disposed ||
      active.revoked ||
      this.#stoppedWindows.has(active.windowKey) ||
      active.owner.activationGeneration <=
        (this.#stopped.get(active.owner.addonId) ?? -1) ||
      !this.#options.isWindowLive(active.windowKey) ||
      !current ||
      current.addonId !== active.owner.addonId ||
      current.activationGeneration !== active.owner.activationGeneration
    )
      fail('stale')
  }

  #admit(addonId: string, windowKey: object, expected?: AddonOwner): Active {
    if (this.#disposed) return fail('stale')
    if (typeof addonId !== 'string' || !keyPattern.test(addonId))
      return fail('invalid-request')
    if (
      this.#active.size >= MAX_ACTIVE ||
      [...this.#active].filter((entry) => entry.owner.addonId === addonId)
        .length >= MAX_PER_OWNER
    )
      return fail('busy')
    const owner = this.#options.currentOwner(addonId)
    if (
      !owner ||
      owner.addonId !== addonId ||
      !Number.isSafeInteger(owner.activationGeneration) ||
      owner.activationGeneration < 0 ||
      (expected &&
        expected.activationGeneration !== owner.activationGeneration) ||
      this.#stoppedWindows.has(windowKey) ||
      !this.#options.isWindowLive(windowKey) ||
      owner.activationGeneration <= (this.#stopped.get(addonId) ?? -1)
    )
      return fail('stale')
    const active = {
      owner,
      windowKey,
      controller: new AbortController(),
      revoked: false,
      committed: false,
    }
    this.#active.add(active)
    return active
  }

  async #run<T>(
    addonId: string,
    windowKey: object,
    work: (active: Active) => Promise<T>,
    expected?: AddonOwner,
  ): Promise<CredentialResult<T>> {
    let active: Active | undefined
    try {
      active = this.#admit(addonId, windowKey, expected)
      const value = await work(active)
      this.#guard(active)
      return { ok: true, value }
    } catch (error) {
      if (error instanceof VaultFailure)
        return {
          ok: false,
          code: error.code,
          ...(active?.committed ? { committed: true } : {}),
        }
      return {
        ok: false,
        code: 'io-error',
        ...(active?.committed ? { committed: true } : {}),
      }
    } finally {
      if (active) this.#active.delete(active)
    }
  }

  #serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(work)
    this.#tail = result.then(
      () => {},
      () => {},
    )
    return result
  }

  async #availability(): Promise<CredentialAvailability> {
    try {
      if (this.#platform === 'linux') {
        // ponytail: electron 44's linux async provider has an unprotected
        // fallback. use the attested sync backend until async reports its key source.
        const backend = this.#options.storage.getSelectedStorageBackend?.()
        if (backend === 'basic_text') return 'unprotected'
        if (!backend || !protectedLinux.has(backend))
          return 'locked-or-unavailable'
        return this.#options.storage.isEncryptionAvailable()
          ? 'protected'
          : 'locked-or-unavailable'
      }
      if (this.#platform === 'darwin' || this.#platform === 'win32')
        return (await this.#options.storage.isAsyncEncryptionAvailable())
          ? 'protected'
          : 'locked-or-unavailable'
    } catch {
      // A locked keychain or unavailable provider must never trigger plaintext fallback.
    }
    return 'locked-or-unavailable'
  }

  #availabilityFailure(value: CredentialAvailability): never {
    return fail(
      value === 'unprotected' ? 'unprotected' : 'locked-or-unavailable',
    )
  }

  async #encrypt(secret: string): Promise<Buffer> {
    let bytes: Buffer
    try {
      bytes =
        this.#platform === 'linux'
          ? this.#options.storage.encryptString(secret)
          : await this.#options.storage.encryptStringAsync(secret)
    } catch {
      return fail('locked-or-unavailable')
    }
    if (
      !Buffer.isBuffer(bytes) ||
      !bytes.length ||
      bytes.length > MAX_CIPHER_BYTES
    )
      return fail('locked-or-unavailable')
    return bytes
  }

  async #decrypt(bytes: Buffer): Promise<{ secret: string; rotate: boolean }> {
    try {
      if (this.#platform === 'linux')
        return {
          secret: this.#options.storage.decryptString(bytes),
          rotate: false,
        }
      const result = await this.#options.storage.decryptStringAsync(bytes)
      if (
        typeof result.result !== 'string' ||
        typeof result.shouldReEncrypt !== 'boolean'
      )
        return fail('locked-or-unavailable')
      return { secret: result.result, rotate: result.shouldReEncrypt }
    } catch {
      return fail('locked-or-unavailable')
    } finally {
      bytes.fill(0)
    }
  }

  async #load(active: Active): Promise<Entry[]> {
    const entries = await readEntries(this.#path(active.owner.addonId))
    this.#guard(active)
    return entries
  }

  async #write(
    active: Active,
    entries: readonly Entry[],
    protectedRequired: boolean,
  ) {
    const beforeCommit = async () => {
      this.#guard(active)
      if (protectedRequired) {
        const available = await this.#availability()
        this.#guard(active)
        if (available !== 'protected') this.#availabilityFailure(available)
      }
    }
    await writeEntries(
      this.#options.directory,
      this.#path(active.owner.addonId),
      entries,
      beforeCommit,
      () => this.#guard(active),
      () => {
        active.committed = true
      },
      this.#platform,
    )
  }

  #sessionFor(active: Active, key: string): SessionEntry | undefined {
    const id = this.#sessionKey(active.owner.addonId, key)
    const entry = this.#session.get(active.windowKey)?.get(id)
    if (!entry) return undefined
    if (
      entry.owner.activationGeneration !== active.owner.activationGeneration
    ) {
      this.#clearSession(active.windowKey, id)
      return undefined
    }
    return entry
  }

  async store(
    addonId: string,
    windowKey: object,
    input: unknown,
  ): Promise<CredentialResult<{ mode: CredentialMode }>> {
    let request: ReturnType<typeof decodeStore>
    try {
      request = decodeStore(input)
    } catch {
      return { ok: false, code: 'invalid-request' }
    }
    const { key, secret, mode } = request
    return this.#run(addonId, windowKey, async (active) => {
      this.#guard(active)
      if (mode === 'session') {
        const id = this.#sessionKey(addonId, key)
        const entries =
          this.#session.get(windowKey) ?? new Map<string, SessionEntry>()
        const previous = entries.get(id)
        if (
          !previous &&
          [...this.#session.values()].reduce(
            (count, windowEntries) =>
              count +
              [...windowEntries.values()].filter(
                (entry) => entry.owner.addonId === addonId,
              ).length,
            0,
          ) >= MAX_KEYS
        )
          fail('limit-exceeded')
        const bytes = Buffer.from(secret, 'utf8')
        this.#guard(active)
        previous?.bytes.fill(0)
        entries.set(id, { owner: active.owner, bytes })
        this.#session.set(windowKey, entries)
        return { mode }
      }
      return this.#serialize(async () => {
        this.#guard(active)
        const available = await this.#availability()
        this.#guard(active)
        if (available !== 'protected') this.#availabilityFailure(available)
        const encrypted = await this.#encrypt(secret)
        try {
          this.#guard(active)
          const entries = await this.#load(active)
          const next = entries.filter((entry) => entry.key !== key)
          if (next.length >= MAX_KEYS) fail('limit-exceeded')
          next.push({ key, ciphertext: encrypted.toString('base64') })
          await this.#write(active, next, true)
          const session = this.#sessionFor(active, key)
          if (session)
            this.#clearSession(windowKey, this.#sessionKey(addonId, key))
          return { mode }
        } finally {
          encrypted.fill(0)
        }
      })
    })
  }

  async remove(
    addonId: string,
    windowKey: object,
    input: unknown,
  ): Promise<CredentialResult<{ removed: boolean }>> {
    let key: string
    try {
      key = decodeKey(input)
    } catch {
      return { ok: false, code: 'invalid-request' }
    }
    return this.#run(addonId, windowKey, (active) =>
      this.#serialize(async () => {
        this.#guard(active)
        const entries = await this.#load(active)
        const next = entries.filter((entry) => entry.key !== key)
        if (next.length !== entries.length)
          await this.#write(active, next, false)
        else this.#guard(active)
        const session = this.#clearSession(
          windowKey,
          this.#sessionKey(addonId, key),
        )
        return { removed: next.length !== entries.length || session }
      }),
    )
  }

  async status(
    addonId: string,
    windowKey: object,
    input: unknown,
  ): Promise<CredentialResult<CredentialStatus>> {
    let key: string
    try {
      key = decodeKey(input)
    } catch {
      return { ok: false, code: 'invalid-request' }
    }
    return this.#run(addonId, windowKey, (active) =>
      this.#serialize(async () => {
        this.#guard(active)
        const persistence = await this.#availability()
        this.#guard(active)
        const entries = await this.#load(active)
        const stored = this.#sessionFor(active, key)
          ? 'session'
          : entries.some((entry) => entry.key === key)
            ? 'persistent'
            : 'missing'
        return { key, stored, persistence }
      }),
    )
  }

  /** Main-only callback; call only after the destination and operation were granted. */
  async applyForApprovedRequest(
    owner: AddonOwner,
    windowKey: object,
    key: string,
    apply: (secret: string, signal: AbortSignal) => void | Promise<void>,
  ): Promise<CredentialResult<{ applied: true }>> {
    if (!keyPattern.test(key) || typeof apply !== 'function')
      return { ok: false, code: 'invalid-request' }
    return this.#run(
      owner.addonId,
      windowKey,
      async (active) => {
        this.#guard(active)
        const session = this.#sessionFor(active, key)
        const secret = session
          ? session.bytes.toString('utf8')
          : await this.#serialize(async () => {
              this.#guard(active)
              const available = await this.#availability()
              this.#guard(active)
              if (available !== 'protected')
                this.#availabilityFailure(available)
              const entries = await this.#load(active)
              const entry = entries.find((item) => item.key === key)
              const decoded = await this.#decrypt(
                Buffer.from(entry?.ciphertext ?? fail('not-found'), 'base64'),
              )
              this.#guard(active)
              if (
                !decoded.secret ||
                decoded.secret.includes('\0') ||
                Buffer.byteLength(decoded.secret, 'utf8') > MAX_SECRET_BYTES
              )
                fail('corrupt')
              if (decoded.rotate) {
                const encrypted = await this.#encrypt(decoded.secret)
                try {
                  this.#guard(active)
                  const next = entries.map((item) =>
                    item.key === key
                      ? { key, ciphertext: encrypted.toString('base64') }
                      : item,
                  )
                  await this.#write(active, next, true)
                } finally {
                  encrypted.fill(0)
                }
              }
              return decoded.secret
            })
        this.#guard(active)
        await apply(secret, active.controller.signal)
        this.#guard(active)
        return { applied: true as const }
      },
      owner,
    )
  }

  stopOwner(owner: AddonOwner) {
    this.#stopped.set(
      owner.addonId,
      Math.max(
        this.#stopped.get(owner.addonId) ?? -1,
        owner.activationGeneration,
      ),
    )
    for (const active of this.#active)
      if (
        active.owner.addonId === owner.addonId &&
        active.owner.activationGeneration <= owner.activationGeneration
      ) {
        active.revoked = true
        active.controller.abort()
      }
    for (const [windowKey, entries] of this.#session)
      for (const [id, entry] of entries)
        if (
          entry.owner.addonId === owner.addonId &&
          entry.owner.activationGeneration <= owner.activationGeneration
        )
          this.#clearSession(windowKey, id)
  }

  stopWindow(windowKey: object) {
    this.#stoppedWindows.add(windowKey)
    for (const active of this.#active)
      if (active.windowKey === windowKey) {
        active.revoked = true
        active.controller.abort()
      }
    for (const id of this.#session.get(windowKey)?.keys() ?? [])
      this.#clearSession(windowKey, id)
  }

  dispose() {
    this.#disposed = true
    for (const active of this.#active) {
      active.revoked = true
      active.controller.abort()
    }
    for (const entries of this.#session.values())
      for (const entry of entries.values()) entry.bytes.fill(0)
    this.#session.clear()
  }
}
