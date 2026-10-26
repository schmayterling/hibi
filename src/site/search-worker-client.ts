import type { SitePage } from './data'
import {
  createSiteSearch,
  type SearchEntry,
  type SiteSearchResult,
  searchRecords,
} from './search'
import type { SearchJob } from './search.worker'
import SearchWorker from './search.worker?worker&inline'

/** One owned worker; each hydration batch is acknowledged before sending more. */
export function createSiteSearchWorker(
  pages: readonly SitePage[],
  fallback: (page: SitePage) => { id: string; label: string }[],
) {
  let worker: Worker
  try {
    worker = new SearchWorker()
  } catch {
    return createSiteSearch(pages, fallback)
  }
  const controller = new AbortController()
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >()
  const cache = new Map<string, SiteSearchResult[]>()
  let local: ReturnType<typeof createSiteSearch> | undefined
  let sequence = 0
  const stop = (error: unknown) => {
    worker.terminate()
    for (const request of pending.values()) request.reject(error)
    pending.clear()
    cache.clear()
  }
  const recover = (error: unknown) => {
    if (local || controller.signal.aborted) return
    local = createSiteSearch(pages, fallback)
    stop(error)
  }
  worker.onmessage = ({
    data,
  }: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
    const request = pending.get(data.id)
    if (!request) return
    pending.delete(data.id)
    if (data.error !== undefined) request.reject(new Error(data.error))
    else request.resolve(data.result)
  }
  worker.addEventListener('error', (event) => {
    event.preventDefault()
    recover(new Error('Could not search this site.'))
  })
  worker.addEventListener('messageerror', () =>
    recover(new Error('Could not search this site.')),
  )
  const request = <T>(job: SearchJob): Promise<T> => {
    controller.signal.throwIfAborted()
    return new Promise<T>((resolve, reject) => {
      const id = ++sequence
      pending.set(id, { resolve: (value) => resolve(value as T), reject })
      try {
        worker.postMessage({ id, job })
      } catch (error) {
        pending.delete(id)
        reject(error)
      }
    })
  }
  let loading: Promise<void> | undefined
  const preload = () => {
    if (local) return local.preload()
    loading ??= (async () => {
      let batch: SearchEntry[] = [],
        characters = 0
      const flush = async () => {
        if (!batch.length) return
        await request({ kind: 'add', records: batch })
        batch = []
        characters = 0
      }
      for (const page of pages) {
        controller.signal.throwIfAborted()
        for (const record of searchRecords(page, fallback)) {
          const size =
            record.text.length +
            record.title.length +
            record.path.length +
            record.anchor.length
          if (batch.length && characters + size > 64 * 1024) await flush()
          batch.push(record)
          characters += size
          if (batch.length >= 16 || characters >= 64 * 1024) await flush()
        }
        // Legacy HTML preparation stays cooperative too.
        if (page.search?.version !== 1) await flush()
      }
      await flush()
    })().catch(async (error) => {
      controller.signal.throwIfAborted()
      recover(error)
      await local!.preload()
    })
    return loading
  }
  let ranking = Promise.resolve()
  return {
    preload,
    async find(
      query: string,
      signal?: AbortSignal,
    ): Promise<SiteSearchResult[]> {
      query = query.trim().toLowerCase()
      if (!query) return []
      signal?.throwIfAborted()
      try {
        await preload()
        controller.signal.throwIfAborted()
        signal?.throwIfAborted()
        if (local) return await local.find(query, signal)
        const result = ranking.then(async () => {
          controller.signal.throwIfAborted()
          signal?.throwIfAborted()
          if (local) return local.find(query, signal)
          let matches = cache.get(query)
          if (!matches) {
            matches = await request<SiteSearchResult[]>({ kind: 'find', query })
            controller.signal.throwIfAborted()
            cache.set(query, matches)
            if (cache.size > 20) cache.delete(cache.keys().next().value!)
          }
          return matches
        })
        ranking = result.then(
          () => {},
          () => {},
        )
        const matches = await result
        controller.signal.throwIfAborted()
        signal?.throwIfAborted()
        return matches
      } catch (error) {
        controller.signal.throwIfAborted()
        signal?.throwIfAborted()
        recover(error)
        return local!.find(query, signal)
      }
    },
    dispose() {
      controller.abort()
      stop(controller.signal.reason)
      local?.dispose()
    },
  }
}
