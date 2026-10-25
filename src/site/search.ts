import MiniSearch from 'minisearch'
import type { SitePage } from './data'

export type SearchEntry = {
  id: string
  path: string
  anchor: string
  title: string
  text: string
}

export type SiteSearchResult = Pick<
  SearchEntry,
  'id' | 'path' | 'anchor' | 'title'
>

export function siteSearchIndex() {
  return new MiniSearch<SearchEntry>({
    fields: ['title', 'text'],
    storeFields: ['path', 'anchor', 'title'],
    searchOptions: {
      prefix: true,
      fuzzy: 0.2,
      boost: { title: 4 },
      combineWith: 'AND',
    },
  })
}

export function* searchRecords(
  page: SitePage,
  fallback: (page: SitePage) => { id: string; label: string }[],
): Generator<SearchEntry> {
  const data = page.search?.version === 1 ? page.search : undefined
  yield {
    id: page.path,
    path: page.path,
    anchor: '',
    title: page.title,
    text: page.path + ' ' + page.markdown,
  }
  for (const heading of data?.headings ?? fallback(page)) {
    const anchor = 'anchor' in heading ? heading.anchor : heading.id.slice(4)
    yield {
      id: page.path + '#doc-' + anchor,
      path: page.path,
      anchor,
      title: heading.label,
      text: page.title,
    }
  }
}

export function createSiteSearch(
  pages: readonly SitePage[],
  fallback: (page: SitePage) => { id: string; label: string }[],
) {
  const controller = new AbortController()
  const cache = new Map<string, SiteSearchResult[]>()
  let pending: Promise<MiniSearch<SearchEntry>> | undefined
  const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
  const preload = () => {
    pending ??= (async () => {
      await turn()
      const index = siteSearchIndex()
      let batch = 0,
        deadline = performance.now() + 4
      for (const page of pages) {
        controller.signal.throwIfAborted()
        for (const record of searchRecords(page, fallback)) {
          controller.signal.throwIfAborted()
          index.add(record)
          if (++batch >= 32 || performance.now() >= deadline) {
            await turn()
            batch = 0
            deadline = performance.now() + 4
          }
        }
      }
      controller.signal.throwIfAborted()
      return index
    })()
    return pending
  }
  return {
    preload,
    async find(query: string, signal?: AbortSignal) {
      query = query.trim().toLowerCase()
      if (!query) return []
      signal?.throwIfAborted()
      const index = await preload()
      controller.signal.throwIfAborted()
      signal?.throwIfAborted()
      let result = cache.get(query)
      if (!result) {
        // The palette renders at most 50 results; retain only those rows per query.
        result = index
          .search(query)
          .slice(0, 50) as unknown as SiteSearchResult[]
        cache.set(query, result)
        if (cache.size > 20) cache.delete(cache.keys().next().value!)
      }
      return result
    },
    dispose() {
      controller.abort()
      cache.clear()
    },
  }
}
