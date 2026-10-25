import { Worker } from 'node:worker_threads'
import type { SiteWorkerRequest } from './site-worker'

/** One owned worker and one acknowledged page at a time. */
export class SiteWorker {
  private worker: Worker
  private pending:
    | { resolve: (result: unknown) => void; reject: (error: Error) => void }
    | undefined
  private failure: Error | undefined

  constructor(path: string | URL) {
    this.worker = new Worker(path)
    this.worker.on(
      'message',
      (message: { result?: unknown; error?: string }) => {
        const pending = this.pending
        this.pending = undefined
        if (message.error !== undefined)
          pending?.reject(new Error(message.error))
        else pending?.resolve(message.result)
      },
    )
    this.worker.on('error', (error) =>
      this.fail(error instanceof Error ? error : new Error(String(error))),
    )
    this.worker.on('exit', () =>
      this.fail(new Error('Could not prepare the documentation export.')),
    )
  }

  private fail(error: Error) {
    this.failure = error
    this.pending?.reject(error)
    this.pending = undefined
  }

  request<T = void>(job: SiteWorkerRequest): Promise<T> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.pending)
      return Promise.reject(new Error('Another export is already in progress.'))
    return new Promise<T>((resolve, reject) => {
      this.pending = { resolve: (result) => resolve(result as T), reject }
      try {
        this.worker.postMessage(job)
      } catch (error) {
        this.pending = undefined
        reject(error)
      }
    })
  }

  async close() {
    this.fail(new Error('Could not prepare the documentation export.'))
    await this.worker.terminate()
  }
}
