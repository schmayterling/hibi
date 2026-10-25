import { Worker } from 'node:worker_threads'
import type { WorkspacePage } from '../shared/workspace.ts'
import type { WorkspaceMetadataPage } from './workspace-index-metadata.ts'
import type { PageSyntax } from './workspace-syntax.ts'

export type MetadataRequest =
  | {
      kind: 'cached'
      id: string
      path: string
      version: string
      fingerprint: string
    }
  | {
      kind: 'parse'
      page: WorkspacePage
      syntax: PageSyntax
      version: string
      fingerprint: string
    }

/** One parser thread, one active page; obsolete generations never start queued work. */
export class WorkspaceMetadataParser {
  private worker: Worker | undefined
  private pending:
    | {
        resolve: (page: WorkspaceMetadataPage | null) => void
        reject: (error: Error) => void
      }
    | undefined
  private tail: Promise<unknown> = Promise.resolve()
  private stopping: Promise<unknown> = Promise.resolve()
  private generation = 0

  private options: () => { entry: string | URL; cacheDirectory?: string }

  constructor(options: () => { entry: string | URL; cacheDirectory?: string }) {
    this.options = options
  }

  close(): void {
    this.generation++
    if (this.worker)
      this.fail(this.worker, new Error('Workspace metadata canceled.'))
  }

  private fail(worker: Worker, error: Error): void {
    if (this.worker !== worker) return
    this.worker = undefined
    this.pending?.reject(error)
    this.pending = undefined
    this.stopping = worker.terminate()
  }

  private start(): Worker {
    if (this.worker) return this.worker
    const options = this.options()
    const worker = new Worker(options.entry, {
      workerData: { cacheDirectory: options.cacheDirectory },
      resourceLimits: {
        maxOldGenerationSizeMb: 256,
        maxYoungGenerationSizeMb: 32,
      },
    })
    this.worker = worker
    worker.on(
      'message',
      (message: { page: WorkspaceMetadataPage | null; error?: string }) => {
        if (this.worker !== worker) return
        const pending = this.pending
        this.pending = undefined
        worker.unref()
        if (message.error) pending?.reject(new Error(message.error))
        else pending?.resolve(message.page)
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
    worker.unref()
    return worker
  }

  request(
    request: MetadataRequest,
    current: () => boolean,
  ): Promise<WorkspaceMetadataPage | null> {
    const generation = this.generation
    const pending = this.tail
      .catch(() => {})
      .then(async () => {
        await this.stopping
        if (generation !== this.generation || !current()) return null
        const worker = this.start()
        const page = await new Promise<WorkspaceMetadataPage | null>(
          (resolve, reject) => {
            this.pending = { resolve, reject }
            worker.ref()
            try {
              worker.postMessage(request)
            } catch (error) {
              this.fail(worker, error as Error)
            }
          },
        )
        return generation === this.generation && current() ? page : null
      })
    this.tail = pending
    return pending
  }
}
