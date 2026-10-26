import { Worker } from 'node:worker_threads'
import type { PackEntry } from './pack-converters'
import { type PackId, type PackStats, validateId } from './pack-index'
import type { PackManifest } from './packs'

export function completionLimit(value: unknown = 8): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 32
  )
    throw new Error('Invalid dictionary completion limit')
  return value as number
}

export function completionPrefix(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128 || /\p{Cc}/u.test(value))
    throw new Error('Invalid dictionary prefix')
  return value.trim().normalize('NFC')
}

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  progress?: ((entries: number) => void) | undefined
  cleanup: () => void
}
export class PackWorker {
  private worker: Worker | undefined
  private pending = new Map<number, Pending>()
  private seq = 0
  private closed = false
  private stopping: Promise<unknown> = Promise.resolve()
  constructor(private path: string | URL) {}
  private fail(worker: Worker, error: Error) {
    if (this.worker !== worker) return
    this.worker = undefined
    for (const pending of this.pending.values()) {
      pending.cleanup()
      pending.reject(error)
    }
    this.pending.clear()
  }
  private start() {
    if (this.worker) return this.worker
    const worker = new Worker(this.path, {
      resourceLimits: {
        maxOldGenerationSizeMb: 512,
        maxYoungGenerationSizeMb: 32,
        stackSizeMb: 4,
      },
    })
    this.worker = worker
    worker.on(
      'message',
      (message: {
        seq: number
        progress?: number
        result?: unknown
        error?: string
        invalidPack?: boolean
        checksumFailed?: boolean
      }) => {
        if (this.worker !== worker) return
        const pending = this.pending.get(message.seq)
        if (!pending) return
        if (message.progress !== undefined) {
          try {
            pending.progress?.(message.progress)
          } catch {
            /* Progress observers do not own worker lifetime. */
          }
          return
        }
        this.pending.delete(message.seq)
        pending.cleanup()
        if (message.error !== undefined)
          pending.reject(
            Object.assign(
              new Error(message.error),
              message.invalidPack
                ? { name: 'DictionaryPackValidationError' }
                : message.checksumFailed
                  ? { name: 'DictionaryPackChecksumError' }
                  : {},
            ),
          )
        else pending.resolve(message.result)
      },
    )
    worker.on('error', (error) => {
      if (this.worker !== worker) return
      this.fail(
        worker,
        error instanceof Error ? error : new Error(String(error)),
      )
      this.stopping = worker.terminate()
    })
    worker.on('exit', (code) =>
      this.fail(worker, new Error(`Dictionary worker exited (${code})`)),
    )
    return worker
  }
  private async request<T>(
    job: Record<string, unknown>,
    signal?: AbortSignal,
    progress?: ((entries: number) => void) | undefined,
  ): Promise<T> {
    if (
      ![
        'unload',
        'convert',
        'verify',
        'lookup',
        'preload',
        'complete',
      ].includes(job.type as string)
    )
      throw new Error('Invalid dictionary operation')
    if (job.type === 'complete') {
      job.prefix = completionPrefix(job.prefix)
      job.limit = completionLimit(job.limit)
    }
    if (job.type === 'unload') {
      if (job.id !== undefined) validateId(job.id)
    } else {
      if (
        typeof job.directory !== 'string' ||
        !job.directory ||
        job.directory.length > 4096 ||
        !['en', 'zh', 'yue', 'ja', 'tl', 'fr', 'de'].includes(job.id as string)
      )
        throw new Error('Invalid dictionary request')
      if (
        job.type === 'lookup' &&
        (typeof job.word !== 'string' || job.word.length > 256)
      )
        throw new Error('Invalid dictionary word')
      if (
        job.type === 'convert' &&
        (!Array.isArray(job.files) ||
          job.files.length < 1 ||
          job.files.length > 16 ||
          !job.files.every(
            (file) => typeof file === 'string' && file.length <= 4096,
          ))
      )
        throw new Error('Invalid dictionary files')
    }
    let stopping: Promise<unknown>
    do {
      stopping = this.stopping
      await stopping
    } while (stopping !== this.stopping)
    if (this.pending.size >= 64) throw new Error('Dictionary worker queue full')
    if (this.closed) throw new Error('Dictionary worker closed')
    signal?.throwIfAborted()
    const worker = this.start()
    const seq = ++this.seq
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        const error = new Error('Dictionary conversion cancelled')
        error.name = 'AbortError'
        this.fail(worker, error)
        this.stopping = worker.terminate()
      }
      this.pending.set(seq, {
        resolve: (value) => resolve(value as T),
        reject,
        progress,
        cleanup: () => signal?.removeEventListener('abort', abort),
      })
      signal?.addEventListener('abort', abort, { once: true })
      try {
        worker.postMessage({ ...job, seq })
      } catch (error) {
        this.pending.delete(seq)
        signal?.removeEventListener('abort', abort)
        reject(error)
      }
    })
  }
  async convert(
    id: PackId,
    files: string[],
    directory: string,
    signal: AbortSignal,
    onProgress: (entries: number) => void,
  ): Promise<PackStats> {
    try {
      return await this.request<PackStats>(
        { type: 'convert', id, files, directory },
        signal,
        onProgress,
      )
    } catch (error) {
      await this.stopping
      throw error
    }
  }
  lookup(id: PackId, directory: string, word: string): Promise<PackEntry[]> {
    return this.request({ type: 'lookup', id, directory, word })
  }
  verify(
    id: PackId,
    directory: string,
    manifest: PackManifest,
    force = false,
  ): Promise<{ cached: boolean }> {
    return this.request({ type: 'verify', id, directory, manifest, force })
  }
  preload(id: PackId, directory: string): Promise<void> {
    return this.request({ type: 'preload', id, directory })
  }
  complete(
    id: PackId,
    directory: string,
    prefix: string,
    limit = 8,
  ): Promise<string[]> {
    return this.request({ type: 'complete', id, directory, prefix, limit })
  }
  unload(id?: PackId): Promise<void> {
    return this.request({ type: 'unload', id })
  }
  async close(): Promise<void> {
    this.closed = true
    const worker = this.worker
    if (worker) {
      this.fail(worker, new Error('Dictionary worker closed'))
      this.stopping = worker.terminate()
    }
    await this.stopping
  }
}
