import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { SiteWorkerRequest } from './site-worker'

export type SiteFile = { path: string; bytes: number }

/** Version-1 artifacts cross IPC; disk exports stream instead. */
export function validateSiteFiles(files: readonly SiteFile[]) {
  let bytes = 0
  for (const file of files) {
    bytes += file.bytes + Buffer.byteLength(file.path) + 64
    if (bytes > 40 * 1024 * 1024)
      throw new Error(
        'This site is too large to return in memory. Export to disk instead.',
      )
  }
}

export async function readSiteFiles(
  directory: string,
  files: readonly SiteFile[],
) {
  validateSiteFiles(files)
  const result: { path: string; content: string }[] = []
  for (const { path } of files)
    result.push({
      path,
      content: await readFile(join(directory, path), 'utf8'),
    })
  return result
}

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
