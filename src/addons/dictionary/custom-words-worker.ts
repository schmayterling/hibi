import { parentPort, workerData } from 'node:worker_threads'
import { CustomWordDatabase } from './custom-word-database'

const port = parentPort
if (!port) throw new Error('Dictionary worker requires parent port')
let database: Promise<CustomWordDatabase> | undefined
let queue = Promise.resolve()
port.on('message', (job: { seq: number; method: string; input: unknown }) => {
  queue = queue.then(async () => {
    try {
      if (!database) {
        const opening = CustomWordDatabase.open(workerData.profile)
        database = opening
        void opening.catch(() => {
          if (database === opening) database = undefined
        })
      }
      const store = await database
      const result =
        job.method === 'metadata'
          ? store.metadata()
          : job.method === 'get'
            ? store.get(job.input)
            : job.method === 'page'
              ? store.page(job.input)
              : job.method === 'lookup'
                ? store.lookup(job.input)
                : job.method === 'complete'
                  ? store.complete(job.input)
                  : job.method === 'change'
                    ? store.change(job.input)
                    : undefined
      if (result === undefined) throw new Error('Invalid custom words request.')
      port.postMessage({ seq: job.seq, result })
    } catch (error) {
      port.postMessage({
        seq: job.seq,
        error:
          error instanceof Error
            ? error.message
            : 'Could not save custom words.',
      })
    }
  })
})
