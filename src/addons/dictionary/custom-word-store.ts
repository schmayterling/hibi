import { Worker } from 'node:worker_threads'

/** One serialized database worker per enabled dictionary; never a renderer path. */
export class CustomWordStore {
  private worker: Worker | undefined
  private closed = false
  private seq = 0
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  constructor(
    private path: string | URL,
    private profile: string,
  ) {}
  request(
    method: 'page' | 'complete' | 'change',
    input?: unknown,
  ): Promise<unknown> {
    if (this.closed)
      return Promise.reject(new Error('Dictionary packs are closed.'))
    if (this.pending.size >= 64)
      return Promise.reject(new Error('Dictionary worker queue full'))
    // Bound each IPC/worker allocation, never the number or length of stored words.
    if (
      input !== undefined &&
      Buffer.byteLength(JSON.stringify(input)) > 16 * 1024 * 1024
    )
      return Promise.reject(
        new Error('This custom word exceeds the storage request size.'),
      )
    if (!this.worker) {
      const worker = new Worker(this.path, {
        workerData: { profile: this.profile },
        resourceLimits: {
          maxOldGenerationSizeMb: 512,
          maxYoungGenerationSizeMb: 32,
          stackSizeMb: 4,
        },
      })
      this.worker = worker
      worker.on('message', ({ seq, result, error }) => {
        if (this.worker !== worker) return
        const pending = this.pending.get(seq)
        if (!pending) return
        this.pending.delete(seq)
        if (error) pending.reject(new Error(error))
        else pending.resolve(result)
      })
      worker.on('error', (error) =>
        this.fail(
          worker,
          error instanceof Error ? error : new Error(String(error)),
        ),
      )
      worker.on('exit', (code) =>
        this.fail(worker, new Error(`Dictionary worker exited (${code})`)),
      )
    }
    const worker = this.worker
    const seq = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(seq, { resolve, reject })
      try {
        worker.postMessage({ seq, method, input })
      } catch (error) {
        this.pending.delete(seq)
        reject(error)
      }
    })
  }
  private fail(worker: Worker, error: Error) {
    if (this.worker !== worker) return
    this.worker = undefined
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
  async close() {
    this.closed = true
    const worker = this.worker
    if (!worker) return
    this.fail(worker, new Error('Dictionary packs are closed.'))
    await worker.terminate()
  }
}
