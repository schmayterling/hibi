import type { AddonContext } from '../api'
import type { CustomWord } from './custom-words.ts'
import { completeAll } from './offline.ts'
import type { Lang } from './providers.ts'

export type DictionaryWords = { lang: Lang; words: readonly string[] }

/** Local vocabulary only. Explicit dictionary lookups are a separate feature. */
type DictionaryBase = {
  complete: (
    prefix: string,
    langs: readonly Lang[],
    limit: number,
    signal?: AbortSignal,
  ) => Promise<readonly DictionaryWords[]>
  suggestionLanguages: () => readonly Lang[]
  customCompletions?: (
    prefix: string,
    langs: readonly Lang[],
    limit: number,
    signal?: AbortSignal,
  ) => Promise<readonly CustomWord[]>
}

/** Version 2 reads the complete custom list asynchronously, only on request. */
export type DictionaryApi = DictionaryBase &
  (
    | { readonly version: 1; customWords: () => readonly CustomWord[] }
    | { readonly version: 2; customWords: () => Promise<readonly CustomWord[]> }
  )

export function createDictionaryApi(
  native: AddonContext['native'],
  suggestionLanguages: DictionaryApi['suggestionLanguages'],
  customWords: () => readonly CustomWord[] | Promise<readonly CustomWord[]>,
): DictionaryApi {
  return {
    version: 2,
    suggestionLanguages,
    customWords: async () => customWords(),
    async customCompletions(prefix, langs, limit, signal) {
      signal?.throwIfAborted()
      const words = await native.query<CustomWord[]>('customWordsComplete', {
        prefix,
        langs,
        limit,
      })
      signal?.throwIfAborted()
      return words
    },
    async complete(
      prefix,
      langs,
      limit,
      signal = new AbortController().signal,
    ) {
      signal.throwIfAborted()
      if (!prefix.trim() || prefix.length > 64 || !Number.isFinite(limit))
        return []
      const count = Math.max(1, Math.min(64, Math.floor(limit)))
      return completeAll(native, [...new Set(langs)], prefix, signal, count)
    },
  }
}
