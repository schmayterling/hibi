/** Lookup languages. `zh` covers simplified and traditional Mandarin; `yue` is Cantonese. */
export type Lang = 'en' | 'zh' | 'yue' | 'ja' | 'tl' | 'fr' | 'de'
export const LANGS: readonly Lang[] = [
  'en',
  'zh',
  'yue',
  'ja',
  'tl',
  'fr',
  'de',
]

/** Shown with every result so attribution travels with the text. */
export type Source = { name: string; license: string; url?: string }
export type Sense = { gloss: string; example?: string }
export type Entry = {
  term: string
  lang: Lang
  /** Pinyin, jyutping, kana, or another pronunciation aid. */
  reading?: string
  partOfSpeech?: string
  senses: Sense[]
  synonyms?: string[]
  source: Source
}
export type Related = { synonyms: string[]; antonyms: string[]; source: Source }

export type DictionaryFailure =
  | 'offline'
  | 'rate-limited'
  | 'denied'
  | 'unavailable'
  | 'not-installed'
/** Providers throw this; any other error is treated as `unavailable`. */
export class DictionaryError extends Error {
  readonly reason: DictionaryFailure
  constructor(reason: DictionaryFailure) {
    super(reason)
    this.reason = reason
  }
}

export interface DictionaryProvider {
  /** Unique within the addon, such as `wiktionary` or `cedict`. */
  readonly id: string
  readonly label: string
  readonly kind: 'online' | 'offline'
  readonly languages: readonly Lang[]
  /** Offline packs return false until installed. Omit when always usable. */
  installed?(): boolean | Promise<boolean>
  /**
   * An empty array means the provider has no entry for the term. With
   * `cachedOnly`, answer only from data already fetched and send nothing.
   */
  lookup(
    term: string,
    lang: Lang,
    signal: AbortSignal,
    cachedOnly?: boolean,
  ): Promise<Entry[]>
  /** Prefix matches retain source spelling. Defaults to 8 results, at most 32. */
  complete?(
    prefix: string,
    lang: Lang,
    signal: AbortSignal,
    limit?: number,
  ): Promise<string[]>
  /** Null means no related words were found. `cachedOnly` works as in `lookup`. */
  related?(
    term: string,
    lang: Lang,
    signal: AbortSignal,
    cachedOnly?: boolean,
  ): Promise<Related | null>
}

/** Local command ID (`dictionary.install-pack`) that offers to install a pack for `lang`. */
export const INSTALL_PACK_COMMAND = 'install-pack'

/** Providers the UI asks, offline packs first and online services as fallback. */
export function createRegistry() {
  const providers: DictionaryProvider[] = []
  return {
    register(provider: DictionaryProvider) {
      if (providers.some((item) => item.id === provider.id))
        throw new Error(`Duplicate dictionary provider: ${provider.id}`)
      providers.push(provider)
      return () => {
        const index = providers.indexOf(provider)
        if (index >= 0) providers.splice(index, 1)
      }
    },
    async providers(lang: Lang, need: 'lookup' | 'related') {
      const usable: DictionaryProvider[] = []
      for (const provider of providers)
        if (
          provider.languages.includes(lang) &&
          (need === 'lookup' || provider.related) &&
          ((await provider.installed?.()) ?? true)
        )
          usable.push(provider)
      return usable.sort(
        (left, right) =>
          Number(left.kind === 'online') - Number(right.kind === 'online'),
      )
    },
    /** True when an offline provider supports `lang` but is not installed. */
    async installable(lang: Lang) {
      for (const provider of providers)
        if (
          provider.kind === 'offline' &&
          provider.languages.includes(lang) &&
          !((await provider.installed?.()) ?? true)
        )
          return true
      return false
    },
  }
}
export type DictionaryRegistry = ReturnType<typeof createRegistry>

export type Gathered<T> = {
  found: { lang: Lang; value: T }[]
  /** The first failure, reported only when nothing was found. */
  failure?: DictionaryFailure
  /** Languages with no usable provider whose offline pack can be installed. */
  installable: Lang[]
}

/**
 * Asks installed offline packs for every language first. Online providers run
 * only when no pack answers, in language order. After the first online answer,
 * later languages are asked with `cachedOnly`, so nothing more is sent.
 */
export async function gather<T>(
  registry: DictionaryRegistry,
  langs: readonly Lang[],
  need: 'lookup' | 'related',
  ask: (
    provider: DictionaryProvider,
    lang: Lang,
    cachedOnly: boolean,
  ) => Promise<T | null>,
): Promise<Gathered<T>> {
  const result: Gathered<T> = { found: [], installable: [] }
  const fail = (error: unknown) => {
    result.failure ??=
      error instanceof DictionaryError ? error.reason : 'unavailable'
  }
  const candidates = []
  for (const lang of langs) {
    try {
      const providers = await registry.providers(lang, need)
      if (!providers.length && (await registry.installable(lang)))
        result.installable.push(lang)
      candidates.push({ lang, providers })
    } catch (error) {
      // Packs that cannot say whether they are installed, as while closing.
      fail(error)
    }
  }
  for (const kind of ['offline', 'online'] as const) {
    for (const { lang, providers } of candidates) {
      const cachedOnly = kind === 'online' && result.found.length > 0
      for (const provider of providers) {
        if (provider.kind !== kind) continue
        try {
          const value = await ask(provider, lang, cachedOnly)
          if (value === null || (Array.isArray(value) && !value.length))
            continue
          result.found.push({ lang, value })
          break
        } catch (error) {
          fail(error)
        }
      }
    }
    if (result.found.length) {
      delete result.failure
      return result
    }
  }
  return result
}
