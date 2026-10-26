import { type SearchEntry, siteSearchIndex } from './search'

export type SearchJob =
  | { kind: 'add'; records: SearchEntry[] }
  | { kind: 'find'; query: string }

const index = siteSearchIndex()
self.addEventListener(
  'message',
  (event: MessageEvent<{ id: number; job: SearchJob }>) => {
    const { id, job } = event.data
    try {
      const result =
        job.kind === 'find'
          ? index.search(job.query).slice(0, 50)
          : index.addAll(job.records)
      self.postMessage({ id, result })
    } catch (error) {
      self.postMessage({
        id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  },
)
