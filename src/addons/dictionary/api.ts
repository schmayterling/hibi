import type { AddonContext } from '../api'
import type { CustomWord } from './custom-words.ts'
import { completeAll } from './offline.ts'
import type { Lang } from './providers.ts'

export type DictionaryWords = { lang: Lang; words: readonly string[] }

/** Local vocabulary only. Explicit dictionary lookups are a separate feature. */
export interface DictionaryApi {
  readonly version: 1
  complete: (
    prefix: string,
    langs: readonly Lang[],
    limit: number,
    signal?: AbortSignal,
  ) => Promise<readonly DictionaryWords[]>
  suggestionLanguages: () => readonly Lang[]
  customWords: () => readonly CustomWord[]
  customCompletions?: (
    prefix: string,
    langs: readonly Lang[],
    limit: number,
    signal?: AbortSignal,
  ) => Promise<readonly CustomWord[]>
}

export function createDictionaryApi(
  native: AddonContext['native'],
  suggestionLanguages: DictionaryApi['suggestionLanguages'],
  customWords: DictionaryApi['customWords'],
): DictionaryApi {
  return {
    version: 1,
    suggestionLanguages,
    customWords,
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
