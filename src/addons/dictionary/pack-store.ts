import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { download } from '../../main/download.ts'
import {
  completionLimit,
  completionPrefix,
  PackWorker,
} from './pack-runtime.ts'
import { packStamp } from './pack-verification.ts'
import {
  type PackId,
  type PackManifest,
  type PackState,
  packId,
  packIds,
  packs,
  validateManifest,
} from './packs.ts'

async function directory(path: string, create = false) {
  path = resolve(path)
  if (create) await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('The dictionary pack location is not an ordinary folder.')
  return realpath(path)
}
async function exists(path: string) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
/** Only fixed language ids enter a path; the renderer never supplies filenames. */
export async function packDirectory(root: string, value: unknown) {
  const id = packId(value)
  const base = await directory(root, true)
  const path = join(base, id)
  if (await exists(path)) await directory(path)
  return path
}
async function recoverPrevious(path: string, previous: string) {
  if (!(await exists(previous))) return
  await directory(previous)
  if (!(await exists(path))) await rename(previous, path)
  else await rm(previous, { recursive: true })
}
async function regularFile(path: string, maxBytes: number) {
  const info = await lstat(path)
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size < 1 ||
    info.size > maxBytes
  )
    throw new Error('This dictionary pack is damaged. Install it again.')
  return info
}
async function manifestAt(path: string, id: PackId) {
  await directory(path)
  await regularFile(join(path, 'manifest.json'), 64 * 1024)
  return validateManifest(
    JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8')),
    id,
  )
}

type Verification = {
  stamp: string
  generation: number
  pending: Promise<void>
  fresh: boolean
}

/** Main owns downloads; lookup and short-lived conversion workers stay independent. */
export class PackStore {
  private worker: PackWorker
  private invalidated = new Set<PackId>()
  private verified = new Map<PackId, Verification>()
  private active:
    | { id: PackId; controller: AbortController; done: Promise<void> }
    | undefined
  private progress = new Map<PackId, PackState>()
  private busy: PackId | undefined
  private closed = false
  private generation = new Map<PackId, number>()
  private installedCache: Promise<Set<PackId>> | undefined
  private recovered = new Map<PackId, Promise<void>>()

  constructor(
    private root: string,
    private workerPath: string | URL,
    private fetcher?: typeof fetch,
  ) {
    this.worker = new PackWorker(workerPath)
  }

  private async recover(id: PackId) {
    let recovery = this.recovered.get(id)
    if (!recovery) {
      recovery = (async () => {
        const path = await packDirectory(this.root, id)
        const base = await directory(this.root)
        const scratch = join(base, `.install-${id}`)
        if (await exists(scratch)) {
          await directory(scratch)
          await rm(scratch, { recursive: true })
        }
        const previous = join(base, `.previous-${id}`)
        await recoverPrevious(path, previous)
      })().catch((error) => {
        this.recovered.delete(id)
        throw error
      })
      this.recovered.set(id, recovery)
    }
    await recovery
    return packDirectory(this.root, id)
  }

  private ensureOpen() {
    if (this.closed) throw new Error('Dictionary packs are closed.')
  }

  async list(): Promise<PackState[]> {
    this.ensureOpen()
    return Promise.all(
      packIds.map(async (id) => {
        const progress = this.progress.get(id)
        if (progress) return progress
        try {
          const path = await this.recover(id)
          const manifest = (await exists(path))
            ? await manifestAt(path, id)
            : null
          return {
            id,
            manifest,
            phase: manifest ? 'installed' : 'absent',
            bytes: 0,
            total: null,
            entries: 0,
          }
        } catch {
          return {
            id,
            manifest: null,
            phase: 'error',
            bytes: 0,
            total: null,
            entries: 0,
            error: 'This dictionary pack is damaged. Install it again.',
          }
        }
      }),
    )
  }

  async installed(value: unknown): Promise<boolean> {
    const id = packId(value)
    this.ensureOpen()
    this.installedCache ??= this.list()
      .then(
        (states) =>
          new Set(
            states.filter((state) => state.manifest).map((state) => state.id),
          ),
      )
      .catch((error) => {
        this.installedCache = undefined
        throw error
      })
    return (await this.installedCache).has(id)
  }

  async install(value: unknown) {
    const id = packId(value)
    this.ensureOpen()
    if (this.busy)
      throw new Error(
        'Wait for the current dictionary pack operation to finish.',
      )
    this.busy = id
    this.generation.set(id, (this.generation.get(id) ?? 0) + 1)
    this.installedCache = undefined
    const controller = new AbortController()
    const state: PackState = {
      id,
      manifest: null,
      phase: 'downloading',
      bytes: 0,
      total: null,
      entries: 0,
    }
    this.progress.set(id, state)
    const done = this.performInstall(id, controller.signal, state)
      .catch((error) => {
        if (controller.signal.aborted) this.progress.delete(id)
        else
          this.progress.set(id, {
            ...state,
            phase: 'error',
            error:
              error instanceof Error
                ? error.message
                : 'Could not install this dictionary pack.',
          })
      })
      .finally(() => {
        this.active = undefined
        this.busy = undefined
        this.installedCache = undefined
      })
    this.active = { id, controller, done }
  }

  private async performInstall(
    id: PackId,
    cancel: AbortSignal,
    state: PackState,
  ) {
    const path = await this.recover(id)
    const base = await directory(this.root)
    const scratch = join(base, `.install-${id}`)
    const previous = join(base, `.previous-${id}`)
    await recoverPrevious(path, previous)
    state.manifest = (await exists(path))
      ? await manifestAt(path, id).catch(() => null)
      : null
    if (await exists(scratch)) {
      await directory(scratch)
      await rm(scratch, { recursive: true })
    }
    await mkdir(scratch, { mode: 0o700 })
    try {
      const sources: PackManifest['sources'] = []
      const files: string[] = []
      let downloaded = 0
      for (const [i, source] of packs[id].sources.entries()) {
        const file = join(scratch, `source-${i}`)
        const handle = await open(file, 'wx', 0o600)
        try {
          const result = await download(source.url, {
            maxBytes: source.maxBytes,
            expectedBytes: source.bytes,
            allowedOrigins: [new URL(source.url).origin],
            signal: cancel,
            stallTimeoutMs: 60_000,
            ...(this.fetcher ? { fetch: this.fetcher } : {}),
            write: async (chunk) => {
              await handle.writeFile(chunk)
            },
            progress: (bytes, total) => {
              state.bytes = downloaded + bytes
              state.total =
                total === null
                  ? null
                  : downloaded +
                    total +
                    packs[id].sources
                      .slice(i + 1)
                      .reduce((sum, item) => sum + item.bytes, 0)
            },
          })
          sources.push({
            ...source,
            bytes: result.bytes,
            sha256: result.sha256,
            lastModified: result.lastModified,
          })
          downloaded += result.bytes
          files.push(file)
        } finally {
          await handle.close()
        }
      }
      state.phase = 'converting'
      state.total = state.bytes
      // ponytail: local conversion avoids hosted data; use hosted prebuilt packs if conversion becomes too slow.
      const converter = new PackWorker(this.workerPath)
      const signal = AbortSignal.any([
        cancel,
        AbortSignal.timeout(15 * 60 * 1000),
      ])
      const result = await converter
        .convert(id, files, scratch, signal, (entries) => {
          state.entries = entries
        })
        .catch((error) => {
          if (!cancel.aborted)
            console.error('could not prepare dictionary pack:', error)
          throw new Error('Could not install this dictionary pack. Try again.')
        })
        .finally(() => converter.close())
      signal.throwIfAborted()
      const manifest = validateManifest(
        {
          format: 1,
          id,
          installedAt: new Date().toISOString(),
          sources,
          ...result,
        },
        id,
      )
      await writeFile(
        join(scratch, 'manifest.json'),
        JSON.stringify(manifest),
        { flag: 'wx', mode: 0o600 },
      )
      for (const file of files) await rm(file)
      await this.worker.unload(id)
      signal.throwIfAborted()
      if (await exists(path)) await rename(path, previous)
      try {
        await rename(scratch, path)
      } catch (error) {
        if (await exists(previous)) await rename(previous, path)
        throw error
      }
      this.verified.delete(id)
      state.manifest = manifest
      if (await exists(previous)) await rm(previous, { recursive: true })
      this.progress.delete(id)
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }

  async cancel(value: unknown) {
    const id = packId(value)
    if (this.active?.id !== id) return
    this.active.controller.abort(
      new Error('Dictionary pack installation canceled.'),
    )
    await this.active.done
  }

  async uninstall(value: unknown) {
    const id = packId(value)
    this.ensureOpen()
    if (this.busy)
      throw new Error(
        'Wait for the current dictionary pack operation to finish.',
      )
    this.busy = id
    this.generation.set(id, (this.generation.get(id) ?? 0) + 1)
    this.installedCache = undefined
    try {
      const path = await this.recover(id)
      await this.verified.get(id)?.pending.catch(() => {})
      await this.worker.unload(id)
      const base = await directory(this.root)
      for (const candidate of [
        join(base, `.previous-${id}`),
        join(base, `.install-${id}`),
        path,
      ]) {
        if (!(await exists(candidate))) continue
        await directory(candidate)
        await rm(candidate, { recursive: true })
      }
      this.verified.delete(id)
      this.progress.delete(id)
    } finally {
      this.busy = undefined
      this.installedCache = undefined
    }
  }

  async complete(value: unknown, prefix: string, limit = 8): Promise<string[]> {
    const id = packId(value)
    prefix = completionPrefix(prefix)
    limit = completionLimit(limit)
    this.ensureOpen()
    if (!prefix) return []
    return this.read(
      id,
      (id, path) => this.worker.complete(id, path, prefix, limit),
      [],
    )
  }

  /**
   * Completions from several packs for one keystroke, in the order asked.
   * Missing or failing packs are skipped so the others still answer.
   */
  async completeAll(
    values: unknown,
    prefix: string,
    limit = 8,
  ): Promise<{ id: PackId; words: string[] }[]> {
    if (!Array.isArray(values) || values.length > packIds.length)
      throw new Error('Choose dictionary language packs.')
    const ids = [...new Set(values.map(packId))]
    prefix = completionPrefix(prefix)
    limit = completionLimit(limit)
    const found = await Promise.all(
      ids.map((id) =>
        this.complete(id, prefix, limit).then(
          (words) => ({ id, words }),
          (error) => {
            console.error('could not complete from dictionary pack:', error)
            return { id, words: [] }
          },
        ),
      ),
    )
    return found.filter(({ words }) => words.length)
  }

  async lookup(id: PackId, word: string) {
    return this.read(
      packId(id),
      (id, path) => this.worker.lookup(id, path, word),
      [],
    )
  }

  private async read<T>(
    id: PackId,
    query: (id: PackId, path: string) => Promise<T>,
    empty: T,
  ): Promise<T> {
    this.ensureOpen()
    if (this.busy === id) return empty
    const generation = this.generation.get(id) ?? 0
    const changed = () =>
      this.closed ||
      this.busy === id ||
      generation !== (this.generation.get(id) ?? 0)
    try {
      const path = await this.recover(id)
      if (!(await exists(path))) return empty
      const manifest = await manifestAt(path, id)
      if (changed()) return empty
      const stamp = await packStamp(path, manifest)
      if (changed()) return empty
      let verification = this.verified.get(id)
      if (
        verification?.stamp !== stamp ||
        verification.generation !== generation
      ) {
        const pending = this.worker
          .verify(id, path, manifest, this.invalidated.has(id))
          .then(async ({ cached }) => {
            current.fresh = !cached
            if (changed()) return
            this.invalidated.delete(id)
            await this.worker.unload(id)
          })
        const current: Verification = {
          stamp,
          generation,
          pending,
          fresh: false,
        }
        verification = current
        this.verified.set(id, current)
        void pending.catch((error) => {
          if (
            this.verified.get(id) === current &&
            !(
              error instanceof Error &&
              error.name === 'DictionaryPackChecksumError'
            )
          )
            this.verified.delete(id)
        })
      }
      await verification.pending
      if (changed()) return empty
      try {
        const result = await query(id, path)
        return changed() ? empty : result
      } catch (error) {
        if (
          error instanceof Error &&
          error.name === 'DictionaryPackValidationError'
        ) {
          if (this.verified.get(id) === verification) {
            if (verification.fresh) {
              const pending = Promise.reject(error)
              void pending.catch(() => {})
              this.verified.set(id, { ...verification, pending })
            } else {
              this.invalidated.add(id)
              this.verified.delete(id)
            }
          }
        }
        throw error
      }
    } catch (error) {
      if (changed()) return empty
      throw error
    }
  }

  async close() {
    this.closed = true
    this.installedCache = undefined
    this.active?.controller.abort(
      new Error('Dictionary pack installation canceled.'),
    )
    await this.active?.done
    await this.worker.close()
  }
}
