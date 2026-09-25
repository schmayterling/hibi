import { randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  AddonStorageChange,
  AddonStorageReadRequest,
  AddonStorageReadResult,
  AddonStorageScope,
  AddonStorageWriteRequest,
  AddonStorageWriteResult,
} from '../shared/addon-storage'
import type { WorkspaceTarget } from '../shared/foundation-contracts'

const VALUE_LIMIT = 10 * 1024 * 1024
const FILE_LIMIT = 16 * 1024 * 1024
const KEY_LIMIT = 128
const FORMAT = 1

type Entry = { version: number; revision: number; value: unknown }
type Unavailable = Extract<AddonStorageReadResult, { status: 'unavailable' }>
type Namespace = {
  entries: Record<string, Entry>
  loaded?: Promise<void>
  unavailable?: Unavailable
  tail: Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function validJson(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
): boolean {
  if (depth > 32) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || seen.has(value)) return false
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    return false
  seen.add(value)
  let valid: boolean
  if (Array.isArray(value)) {
    valid = Object.keys(value).length === value.length
    for (let index = 0; valid && index < value.length; index++)
      valid =
        Object.hasOwn(value, index) && validJson(value[index], depth + 1, seen)
  } else {
    valid = Object.entries(value).every(
      ([key, item]) =>
        key !== '__proto__' &&
        key !== 'constructor' &&
        validJson(item, depth + 1, seen),
    )
  }
  seen.delete(value)
  return valid
}

function jsonValue(value: unknown): unknown {
  if (!validJson(value))
    throw new Error('Store a JSON value without cycles or unsupported types.')
  const encoded = JSON.stringify(value)
  if (Buffer.byteLength(encoded) > VALUE_LIMIT)
    throw new Error('This addon storage value is too large.')
  return JSON.parse(encoded) as unknown
}

function validate(request: AddonStorageReadRequest): void {
  if (!/^[a-z][a-z0-9-]{0,79}$/.test(request.owner))
    throw new Error('Invalid addon storage owner.')
  if (!/^[a-z][a-z0-9._-]{0,79}$/.test(request.key))
    throw new Error('Invalid addon storage key.')
  if (!isVersion(request.version))
    throw new Error('Invalid addon storage version.')
  if (request.scope.kind === 'workspace') {
    const { workspaceId, workspaceGeneration } = request.scope.target ?? {}
    if (
      typeof workspaceId !== 'string' ||
      !/^[a-f0-9]{64}$/.test(workspaceId) ||
      !Number.isSafeInteger(workspaceGeneration) ||
      workspaceGeneration < 0
    )
      throw new Error('Invalid workspace storage target.')
  } else if (!['global', 'session'].includes(request.scope.kind)) {
    throw new Error('Invalid addon storage scope.')
  }
}

function recordResult(
  namespace: Namespace,
  key: string,
  version: number,
): AddonStorageReadResult {
  if (namespace.unavailable) return namespace.unavailable
  const entry = namespace.entries[key]
  if (!entry) return { status: 'missing', revision: 0 }
  const value = structuredClone(entry.value)
  return entry.version === version
    ? { status: 'ready', revision: entry.revision, value }
    : {
        status: 'version-mismatch',
        revision: entry.revision,
        storedVersion: entry.version,
        value,
      }
}

/** One cached, serialized namespace per addon and scope. Persistent files never live in a workspace. */
export function createAddonStorage(
  baseDirectory: string,
  isCurrentWorkspace: (target: WorkspaceTarget) => boolean,
  isCurrentActivation: (owner: string, generation: number) => boolean,
) {
  const namespaces = new Map<string, Namespace>()
  const listeners = new Set<(change: AddonStorageChange) => void>()

  function namespaceKey(owner: string, scope: AddonStorageScope): string {
    return scope.kind === 'workspace'
      ? `workspace:${scope.target.workspaceId}:${owner}`
      : `${scope.kind}:${owner}`
  }

  function location(owner: string, scope: AddonStorageScope): string | null {
    if (scope.kind === 'session') return null
    return scope.kind === 'global'
      ? join(baseDirectory, 'global', `${owner}.json`)
      : join(
          baseDirectory,
          'workspace',
          scope.target.workspaceId,
          `${owner}.json`,
        )
  }

  function state(owner: string, scope: AddonStorageScope): Namespace {
    const key = namespaceKey(owner, scope)
    let namespace = namespaces.get(key)
    if (!namespace) {
      namespace = {
        entries: Object.create(null) as Record<string, Entry>,
        tail: Promise.resolve(),
      }
      namespaces.set(key, namespace)
    }
    return namespace
  }

  async function load(
    namespace: Namespace,
    file: string | null,
  ): Promise<void> {
    if (!file || namespace.loaded) return namespace.loaded
    namespace.loaded = (async () => {
      const details = await lstat(file).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null
          throw error
        },
      )
      if (!details) return
      if (
        !details.isFile() ||
        details.isSymbolicLink() ||
        details.size > FILE_LIMIT
      ) {
        namespace.unavailable = { status: 'unavailable', reason: 'corrupt' }
        return
      }
      const text = await readFile(file, 'utf8')
      if (Buffer.byteLength(text) > FILE_LIMIT) {
        namespace.unavailable = { status: 'unavailable', reason: 'corrupt' }
        return
      }
      try {
        const parsed: unknown = JSON.parse(text)
        if (!isRecord(parsed) || !Number.isSafeInteger(parsed.format))
          throw new Error()
        if (Number(parsed.format) > FORMAT) {
          namespace.unavailable = {
            status: 'unavailable',
            reason: 'newer-format',
          }
          return
        }
        if (parsed.format !== FORMAT || !isRecord(parsed.entries))
          throw new Error()
        const entries = Object.entries(parsed.entries)
        if (entries.length > KEY_LIMIT) throw new Error()
        const restored = Object.create(null) as Record<string, Entry>
        for (const [key, candidate] of entries) {
          if (
            !/^[a-z][a-z0-9._-]{0,79}$/.test(key) ||
            !isRecord(candidate) ||
            !isVersion(candidate.version) ||
            !isVersion(candidate.revision) ||
            !validJson(candidate.value) ||
            Buffer.byteLength(JSON.stringify(candidate.value)) > VALUE_LIMIT
          )
            throw new Error()
          restored[key] = candidate as Entry
        }
        namespace.entries = restored
      } catch {
        namespace.unavailable = { status: 'unavailable', reason: 'corrupt' }
      }
    })()
    try {
      await namespace.loaded
    } catch (error) {
      delete namespace.loaded
      throw error
    }
  }

  function current(scope: AddonStorageScope): boolean {
    return scope.kind !== 'workspace' || isCurrentWorkspace(scope.target)
  }

  function stale(
    request: AddonStorageReadRequest,
    generation: number,
  ): Unavailable | null {
    if (!isCurrentActivation(request.owner, generation))
      return { status: 'unavailable', reason: 'stale-activation' }
    if (!current(request.scope))
      return { status: 'unavailable', reason: 'stale-workspace' }
    return null
  }

  async function read(
    request: AddonStorageReadRequest,
    generation: number,
  ): Promise<AddonStorageReadResult> {
    validate(request)
    const before = stale(request, generation)
    if (before) return before
    const namespace = state(request.owner, request.scope)
    await namespace.tail
    await load(namespace, location(request.owner, request.scope))
    return (
      stale(request, generation) ??
      recordResult(namespace, request.key, request.version)
    )
  }

  async function write(
    request: AddonStorageWriteRequest,
    generation: number,
  ): Promise<AddonStorageWriteResult> {
    validate(request)
    if (!Number.isSafeInteger(request.baseRevision) || request.baseRevision < 0)
      throw new Error('Invalid addon storage revision.')
    if (
      request.migrateFromVersion !== undefined &&
      (!isVersion(request.migrateFromVersion) ||
        request.migrateFromVersion >= request.version)
    )
      throw new Error('Invalid addon storage migration version.')
    const value = jsonValue(request.value)
    const namespace = state(request.owner, request.scope)
    const run = namespace.tail.then(
      async (): Promise<AddonStorageWriteResult> => {
        const before = stale(request, generation)
        if (before) return before
        const file = location(request.owner, request.scope)
        await load(namespace, file)
        const afterLoad = stale(request, generation)
        if (afterLoad) return afterLoad
        if (namespace.unavailable) return namespace.unavailable
        const existing = namespace.entries[request.key]
        if ((existing?.revision ?? 0) !== request.baseRevision)
          return {
            status: 'conflict',
            current: recordResult(namespace, request.key, request.version),
          }
        if (
          existing &&
          existing.version !== request.version &&
          existing.version !== request.migrateFromVersion
        )
          return {
            status: 'version-mismatch',
            current: recordResult(namespace, request.key, request.version),
          }
        if (!existing && Object.keys(namespace.entries).length >= KEY_LIMIT)
          throw new Error('This addon storage scope has too many keys.')
        if (existing?.revision === Number.MAX_SAFE_INTEGER)
          throw new Error('This addon storage key reached its revision limit.')
        const revision = (existing?.revision ?? 0) + 1
        const next = Object.assign(
          Object.create(null) as Record<string, Entry>,
          namespace.entries,
        )
        next[request.key] = { version: request.version, revision, value }
        if (file) {
          const encoded = JSON.stringify({ format: FORMAT, entries: next })
          if (Buffer.byteLength(encoded) > FILE_LIMIT)
            throw new Error('This addon storage scope is full.')
          const beforeWrite = stale(request, generation)
          if (beforeWrite) return beforeWrite
          await mkdir(dirname(file), { recursive: true, mode: 0o700 })
          const temporary = `${file}.${randomUUID()}.tmp`
          try {
            await writeFile(temporary, encoded, { mode: 0o600 })
            const beforeRename = stale(request, generation)
            if (beforeRename) return beforeRename
            await rename(temporary, file)
          } finally {
            await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOENT') throw error
            })
          }
        }
        if (!file) {
          const beforeCommit = stale(request, generation)
          if (beforeCommit) return beforeCommit
        }
        namespace.entries = next
        const result: AddonStorageWriteResult = {
          status: 'saved',
          revision,
          value: structuredClone(value),
        }
        const change: AddonStorageChange = {
          owner: request.owner,
          scope: request.scope,
          key: request.key,
          version: request.version,
          current: { status: 'ready', revision, value: structuredClone(value) },
        }
        for (const listener of listeners)
          try {
            listener(change)
          } catch (error) {
            console.error('Could not publish addon storage change:', error)
          }
        return result
      },
    )
    namespace.tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async function clearSession(owner: string): Promise<void> {
    if (!/^[a-z][a-z0-9-]{0,79}$/.test(owner)) return
    const namespace = namespaces.get(`session:${owner}`)
    if (!namespace) return
    const run = namespace.tail.then(() => {
      const keys = Object.keys(namespace.entries)
      namespace.entries = Object.create(null) as Record<string, Entry>
      for (const key of keys)
        for (const listener of listeners)
          try {
            listener({
              owner,
              scope: { kind: 'session' },
              key,
              version: null,
              current: { status: 'missing', revision: 0 },
            })
          } catch (error) {
            console.error('Could not publish addon storage change:', error)
          }
    })
    namespace.tail = run.then(
      () => undefined,
      () => undefined,
    )
    await run
  }

  async function clearAllSessions(): Promise<void> {
    await Promise.all(
      [...namespaces.keys()]
        .filter((key) => key.startsWith('session:'))
        .map((key) => clearSession(key.slice('session:'.length))),
    )
  }

  return {
    read,
    write,
    clearSession,
    clearAllSessions,
    subscribe(listener: (change: AddonStorageChange) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
