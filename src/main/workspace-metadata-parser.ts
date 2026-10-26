import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import type { WorkspacePage } from '../shared/workspace.ts'
import type { WorkspaceMetadataPage } from './workspace-index-metadata.ts'
import {
  type HeadingPage,
  headingPageLimit,
} from './workspace-metadata-heading-store.ts'
import {
  RecordReader,
  type RecordSlice,
  recordSliceCharacters,
  recordSliceTokens,
} from './workspace-metadata-record.ts'
import type { PageSyntax } from './workspace-syntax.ts'

export { incompleteMetadataPage } from './workspace-metadata-record.ts'

export type CachedMetadataRequest = {
  kind: 'cached'
  id: string
  path: string
  version: string
  fingerprint: string
}
export type MetadataRequest =
  | CachedMetadataRequest
  | {
      kind: 'parse'
      page: WorkspacePage
      syntax: PageSyntax
      version: string
      fingerprint: string
      fallback?: boolean
    }
export type MetadataParseInput = {
  id: string
  path: string
  version: string
  fingerprint: string
  syntax: PageSyntax
}
export type MetadataFileInput = MetadataParseInput & {
  nativePath: string
  expectedVersion: string
}
export type MetadataSource = {
  readonly utf16Length: number
  sliceRaw(start: number, end: number): string
}
type CacheNames = { names: string[]; done: boolean }
export type MetadataWorkerRequest =
  | MetadataRequest
  | { kind: 'cachedBatch'; requests: readonly CachedMetadataRequest[] }
  | { kind: 'beginBuild' }
  | { kind: 'finishBuild'; remove: readonly string[] }
  | { kind: 'fileStart'; input: MetadataFileInput }
  | { kind: 'fileChunk' }
  | { kind: 'sourceStart'; input: MetadataParseInput; length: number }
  | { kind: 'sourceChunk'; source: string }
  | { kind: 'parseEnd'; fallback?: boolean }
  | {
      kind: 'readHeadings'
      input: CachedMetadataRequest
      offset: number
      limit: number
    }
  | { kind: 'parseClear' }
  | { kind: 'resultChunk' }
  | { kind: 'incomplete'; input: MetadataParseInput | MetadataFileInput }
type MetadataResult =
  | WorkspaceMetadataPage
  | HeadingPage
  | (WorkspaceMetadataPage | null)[]
  | boolean
  | CacheNames
  | null
type ParserOptions = {
  entry: string | URL
  cacheDirectory?: string
  appVersion?: string
  // Expensive Markdown parsing restarts with the linear scanner after this delay.
  // Tests may lower this to exercise a stuck parser without waiting 30 seconds.
  watchdogMs?: number
}

// Hash the local import graph, including chunks whose filenames did not change.
async function bundleHash(entry: string | URL): Promise<string> {
  const root = entry instanceof URL ? entry : pathToFileURL(resolve(entry))
  const seen = new Set<string>()
  const hash = createHash('sha256')
  async function visit(url: URL): Promise<void> {
    if (seen.has(url.href)) return
    seen.add(url.href)
    const source = await readFile(url, 'utf8')
    hash.update(relative(dirname(fileURLToPath(root)), fileURLToPath(url)))
    hash.update('\0').update(source).update('\0')
    const runtime = source.replace(
      /\bimport\s+type\b[\s\S]*?\bfrom\s*['"][^'"]+['"]/g,
      '',
    )
    for (const match of runtime.matchAll(
      /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"](\.[^'"]+)['"]/g,
    ))
      if (match[1]) await visit(new URL(match[1], url))
  }
  await visit(root)
  return hash.digest('hex')
}

/** One parser thread, one active message; obsolete generations never start work. */
export class WorkspaceMetadataParser {
  private worker: Worker | undefined
  private ready: Promise<void> = Promise.resolve()
  private workerReady = false
  private headingDirectory: string | undefined
  private startupReject: ((error: Error) => void) | undefined
  private seen: Set<string> | undefined
  private pending:
    | {
        resolve: (value: MetadataResult | RecordSlice) => void
        reject: (error: Error) => void
        parsed: () => void
      }
    | undefined
  private tail: Promise<unknown> = Promise.resolve()
  private stopping: Promise<unknown> = Promise.resolve()
  private generation = 0
  private propertyHashes = new Map<string, string>()
  private options: () => ParserOptions

  constructor(options: () => ParserOptions) {
    this.options = options
  }

  close(): Promise<void> {
    this.generation++
    this.seen = undefined
    this.propertyHashes.clear()
    if (this.worker)
      this.fail(this.worker, new Error('Workspace metadata canceled.'))
    return this.stopping.then(() => {})
  }

  private fail(worker: Worker, error: Error): void {
    if (this.worker !== worker) return
    this.worker = undefined
    Object.assign(error, { metadataWorkerReady: this.workerReady })
    this.workerReady = false
    this.startupReject?.(error)
    this.startupReject = undefined
    this.pending?.reject(error)
    this.pending = undefined
    const directory = this.headingDirectory
    this.headingDirectory = undefined
    this.stopping = worker.terminate().then(async () => {
      if (directory) await rm(directory, { recursive: true, force: true })
    })
  }

  private canonical = (value: string): string => {
    const existing = this.propertyHashes.get(value)
    if (existing !== undefined) return existing
    // Interning is optional; old edits must not keep unused hashes alive forever.
    if (this.propertyHashes.size >= 4096) this.propertyHashes.clear()
    this.propertyHashes.set(value, value)
    return value
  }

  private start(
    options: ParserOptions,
    headingDirectory: string,
    buildIdentity?: string,
  ): Worker {
    const worker = new Worker(options.entry, {
      workerData: {
        cacheDirectory: options.cacheDirectory,
        buildIdentity,
        headingDirectory,
      },
      resourceLimits: {
        maxOldGenerationSizeMb: 256,
        maxYoungGenerationSizeMb: 32,
      },
    })
    this.worker = worker
    this.headingDirectory = headingDirectory
    this.workerReady = false
    let ready!: () => void
    this.ready = new Promise<void>((resolve, reject) => {
      ready = resolve
      this.startupReject = reject
    })
    worker.on(
      'message',
      (message: {
        value: MetadataResult | RecordSlice
        error?: string
        code?: string
        ready?: boolean
        parsed?: boolean
      }) => {
        if (this.worker !== worker) return
        if (message.ready) {
          this.workerReady = true
          this.startupReject = undefined
          worker.unref()
          ready()
          return
        }
        if (message.parsed) {
          this.pending?.parsed()
          return
        }
        const pending = this.pending
        this.pending = undefined
        worker.unref()
        if (message.error)
          pending?.reject(
            Object.assign(new Error(message.error), {
              code: message.code,
              metadataWorkerReady: this.workerReady,
            }),
          )
        else pending?.resolve(message.value)
      },
    )
    worker.on('error', (error) =>
      this.fail(
        worker,
        error instanceof Error ? error : new Error(String(error)),
      ),
    )
    worker.on('exit', (code) =>
      this.fail(
        worker,
        new Error(`Workspace metadata worker exited (${code}).`),
      ),
    )
    return worker
  }

  private enqueue(
    current: () => boolean,
    run: (active: () => boolean) => Promise<MetadataResult>,
  ): Promise<MetadataResult> {
    const generation = this.generation
    const active = () => generation === this.generation && current()
    const pending = this.tail
      .catch(() => {})
      .then(async () => {
        await this.stopping
        if (!active()) return null
        return run(active)
      })
    this.tail = pending
    return pending
  }

  private async send(
    request: MetadataWorkerRequest,
    active: () => boolean,
  ): Promise<MetadataResult> {
    if (!active()) return null
    if (!this.worker) {
      const options = this.options()
      const hash = options.appVersion
        ? await bundleHash(options.entry)
        : undefined
      if (!active()) return null
      const directory = await mkdtemp(join(tmpdir(), 'hibi-metadata-headings-'))
      if (!active()) {
        await rm(directory, { recursive: true, force: true })
        return null
      }
      this.start(
        options,
        directory,
        hash ? JSON.stringify([options.appVersion, hash]) : undefined,
      )
    }
    await this.ready
    if (!active()) return null
    const worker = this.worker as Worker
    let value = await this.exchange(worker, request)
    if (!value || typeof value !== 'object' || !('tokens' in value))
      return active() ? value : null
    const reader = new RecordReader(this.canonical, true)
    try {
      while (active()) {
        if (value.tokens.length > recordSliceTokens)
          throw new TypeError('Invalid metadata slice')
        let characters = 0
        for (let start = 0; start < value.tokens.length; start += 256) {
          if (!active()) return null
          const tokens = value.tokens.slice(start, start + 256)
          for (const token of tokens)
            characters += Array.isArray(token) ? token[0].length : 1
          if (characters > recordSliceCharacters)
            throw new TypeError('Invalid metadata slice')
          reader.write(tokens)
          await nextTurn()
        }
        if (value.done)
          return active() ? (reader.finish() as MetadataResult) : null
        const next = await this.exchange(worker, { kind: 'resultChunk' })
        if (!next || typeof next !== 'object' || !('tokens' in next))
          throw new TypeError('Missing metadata slice')
        value = next
      }
      return null
    } finally {
      if (!active() && this.worker === worker)
        await this.exchange(worker, { kind: 'parseClear' })
    }
  }

  private async exchange(
    worker: Worker,
    request: MetadataWorkerRequest,
  ): Promise<MetadataResult | RecordSlice> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await new Promise<MetadataResult | RecordSlice>(
        (resolve, reject) => {
          this.pending = { resolve, reject, parsed: () => clearTimeout(timer) }
          worker.ref()
          if (
            (request.kind === 'parseEnd' || request.kind === 'parse') &&
            !request.fallback
          ) {
            timer = setTimeout(
              () =>
                this.fail(
                  worker,
                  Object.assign(
                    new Error('Workspace metadata parse timed out.'),
                    { code: 'ERR_METADATA_TIMEOUT' },
                  ),
                ),
              this.options().watchdogMs ?? 30_000,
            )
          }
          try {
            worker.postMessage(request)
          } catch (error) {
            this.fail(worker, error as Error)
          }
        },
      )
    } finally {
      clearTimeout(timer)
    }
  }

  private observe(ids: readonly (string | undefined)[]): void {
    for (const id of ids)
      if (id && /^[a-f0-9]{64}$/.test(id)) this.seen?.add(id)
  }

  private resourceFailure(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException)?.code
    return (
      code === 'ERR_METADATA_TIMEOUT' ||
      code === 'ERR_WORKER_OUT_OF_MEMORY' ||
      code === 'ERR_STRING_TOO_LONG' ||
      (error instanceof RangeError && error.message === 'Invalid string length')
    )
  }

  private async linearFallback(
    input: MetadataParseInput,
    active: () => boolean,
    run: () => Promise<MetadataResult>,
  ): Promise<MetadataResult> {
    try {
      return await run()
    } catch (error) {
      if (!active()) return null
      if (
        !this.resourceFailure(error) ||
        !(error as { metadataWorkerReady?: boolean }).metadataWorkerReady
      )
        throw error
      if (this.worker) this.fail(this.worker, error as Error)
      await this.stopping
      return this.send({ kind: 'incomplete', input }, active)
    }
  }

  private async parseInput(
    input: MetadataParseInput,
    active: () => boolean,
    transfer: () => Promise<boolean>,
  ): Promise<MetadataResult> {
    this.observe([input.id])
    try {
      if (!(await transfer()) || !active()) return null
      return await this.send({ kind: 'parseEnd' }, active)
    } catch (error) {
      if (!active()) return null
      if (
        !this.resourceFailure(error) ||
        !(error as { metadataWorkerReady?: boolean }).metadataWorkerReady
      )
        throw error
      if (this.worker) this.fail(this.worker, error as Error)
      await this.stopping
      if (!active()) return null
      return await this.linearFallback(input, active, async () => {
        if (!(await transfer()) || !active()) return null
        return this.send({ kind: 'parseEnd', fallback: true }, active)
      })
    } finally {
      // An obsolete transaction must release its chunks before another starts.
      if (this.worker) await this.send({ kind: 'parseClear' }, () => true)
    }
  }

  /** nativePath has already passed main's workspace validation. */
  async parseFile(
    input: MetadataFileInput,
    current: () => boolean,
  ): Promise<WorkspaceMetadataPage | null> {
    return (await this.enqueue(current, (active) =>
      this.parseInput(input, active, async () => {
        if ((await this.send({ kind: 'fileStart', input }, active)) !== true)
          return false
        while (active()) {
          const more = await this.send({ kind: 'fileChunk' }, active)
          if (more === false) return true
          if (more !== true) return false
        }
        return false
      }),
    )) as WorkspaceMetadataPage | null
  }

  /** Only bounded slices cross main; joining and parsing belong to the worker. */
  async parseSource(
    input: MetadataParseInput,
    source: MetadataSource,
    current: () => boolean,
  ): Promise<WorkspaceMetadataPage | null> {
    return (await this.enqueue(current, (active) =>
      this.parseInput(input, active, async () => {
        const length = source.utf16Length
        if (
          (await this.send({ kind: 'sourceStart', input, length }, active)) !==
          true
        )
          return false
        for (let start = 0; start < length; start += 32 * 1024) {
          if (!active()) return false
          const end = Math.min(length, start + 32 * 1024)
          const chunk = source.sliceRaw(start, end)
          if (chunk.length !== end - start)
            throw new RangeError('Invalid metadata source slice')
          if (
            (await this.send(
              { kind: 'sourceChunk', source: chunk },
              active,
            )) !== true
          )
            return false
        }
        return active()
      }),
    )) as WorkspaceMetadataPage | null
  }

  async request(
    request: MetadataRequest,
    current: () => boolean,
  ): Promise<WorkspaceMetadataPage | null> {
    return (await this.enqueue(current, async (active) => {
      this.observe([request.kind === 'parse' ? request.page.id : request.id])
      try {
        return await this.send(request, active)
      } catch (error) {
        if (
          !this.resourceFailure(error) ||
          !(error as { metadataWorkerReady?: boolean }).metadataWorkerReady
        )
          throw error
        if (this.worker) this.fail(this.worker, error as Error)
        if (request.kind === 'cached') return null
        await this.stopping
        if (!active()) return null
        return this.linearFallback(
          {
            id: request.page.id ?? '',
            path: request.page.path,
            version: request.version,
            fingerprint: request.fingerprint,
            syntax: request.syntax,
          },
          active,
          () => this.send({ ...request, fallback: true }, active),
        )
      }
    })) as WorkspaceMetadataPage | null
  }

  async readHeadings(
    input: CachedMetadataRequest,
    offset: number,
    limit: number,
    current: () => boolean,
  ): Promise<HeadingPage | null> {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > headingPageLimit
    )
      throw new RangeError('Invalid heading page')
    return (await this.enqueue(current, async (active) => {
      try {
        return await this.send(
          { kind: 'readHeadings', input, offset, limit },
          active,
        )
      } catch (error) {
        if (
          !this.resourceFailure(error) ||
          !(error as { metadataWorkerReady?: boolean }).metadataWorkerReady
        )
          throw error
        if (this.worker) this.fail(this.worker, error as Error)
        return null
      }
    })) as HeadingPage | null
  }

  /** At most 64 descriptors per call; null entries must be parsed normally. */
  async cachedBatch(
    requests: readonly CachedMetadataRequest[],
    current: () => boolean,
  ): Promise<(WorkspaceMetadataPage | null)[]> {
    if (requests.length > 64)
      throw new RangeError('cachedBatch accepts 64 requests')
    const misses = () => requests.map(() => null)
    return (
      ((await this.enqueue(current, async (active) => {
        this.observe(requests.map((request) => request.id))
        try {
          return await this.send({ kind: 'cachedBatch', requests }, active)
        } catch (error) {
          if (
            !this.resourceFailure(error) ||
            !(error as { metadataWorkerReady?: boolean }).metadataWorkerReady
          )
            throw error
          if (this.worker) this.fail(this.worker, error as Error)
          return null
        }
      })) as (WorkspaceMetadataPage | null)[] | null) ?? misses()
    )
  }

  async beginBuild(current: () => boolean): Promise<boolean> {
    return (
      (await this.enqueue(current, async (active) => {
        this.seen = undefined
        const result = await this.send({ kind: 'beginBuild' }, active)
        if (result === true && active()) {
          this.seen = new Set()
        }
        return result
      })) === true
    )
  }

  async finishBuild(current: () => boolean): Promise<boolean> {
    return (
      (await this.enqueue(current, async (active) => {
        const seen = this.seen
        this.seen = undefined
        if (!seen) return false
        let remove: string[] = []
        while (active()) {
          const batch = await this.send({ kind: 'finishBuild', remove }, active)
          if (!batch || typeof batch !== 'object' || !('names' in batch))
            return false
          remove = batch.names.filter((name) => !seen.has(name.slice(0, -5)))
          if (batch.done) return true
        }
        return false
      })) === true
    )
  }

  /** Include pages reused from the main-process cache in completed-build pruning. */
  async markSeen(
    ids: readonly string[],
    current: () => boolean,
  ): Promise<boolean> {
    if (ids.length > 64) throw new RangeError('markSeen accepts 64 ids')
    return (
      (await this.enqueue(current, async () => {
        if (!this.seen) return false
        this.observe(ids)
        return true
      })) === true
    )
  }
}
