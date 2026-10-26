import type { AddonContext } from '../api'
import type { PackEntry } from './pack-converters'
import { packIds, packs } from './packs.ts'
import {
  DictionaryError,
  type DictionaryProvider,
  type Lang,
  type Source,
} from './providers.ts'

type Native = AddonContext['native']

async function ask<T>(
  query: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted()
  let abort = () => {}
  const canceled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
  })
  try {
    const result = await Promise.race([query(), canceled])
    signal.throwIfAborted()
    return result
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

type Lane = {
  live: boolean
  waiting?: { run: () => void; drop: () => void } | undefined
}
const lanes = new WeakMap<Native, Lane>()

/**
 * Asks `native` with at most one live query per renderer-native context and
 * one waiting query; a newer call replaces the waiting one, which rejects as
 * aborted. Aborting settles the caller at once, but the next query starts
 * only when the live one's reply arrives, so canceled keystrokes never pile
 * up native work.
 */
export function queryLatest<T>(
  native: Native,
  method: string,
  input: unknown,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted()
  const current = lanes.get(native) ?? { live: false }
  lanes.set(native, current)
  const start = () => {
    current.live = true
    const reply = native.query<T>(method, input)
    void reply
      .catch(() => {})
      .finally(() => {
        current.live = false
        const next = current.waiting
        current.waiting = undefined
        next?.run()
      })
    return ask<T>(() => reply, signal)
  }
  if (!current.live) return start()
  current.waiting?.drop()
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      if (current.waiting === waiting) current.waiting = undefined
      reject(signal.reason)
    }
    const waiting = {
      run() {
        signal.removeEventListener('abort', abort)
        start().then(resolve, reject)
      },
      drop() {
        signal.removeEventListener('abort', abort)
        reject(new DOMException('Replaced by a newer query.', 'AbortError'))
      },
    }
    current.waiting = waiting
    signal.addEventListener('abort', abort, { once: true })
  })
}

/**
 * Completions from the installed packs of `langs` in one native request, in
 * that order. Packs that are missing or fail are left out. A newer request
 * replaces one still waiting for the previous reply.
 */
export async function completeAll(
  native: Native,
  langs: readonly Lang[],
  prefix: string,
  signal: AbortSignal,
  limit = 8,
): Promise<{ lang: Lang; words: string[] }[]> {
  if (!langs.length || !prefix.trim()) return []
  const found = await queryLatest<{ id: Lang; words: string[] }[]>(
    native,
    'packCompleteAll',
    { ids: langs, prefix, limit },
    signal,
  )
  return found.map(({ id, words }) => ({ lang: id, words }))
}

export function createOfflineProviders(native: Native): DictionaryProvider[] {
  const query = <T>(method: string, input: unknown, signal: AbortSignal) =>
    ask<T>(() => native.query<T>(method, input), signal)
  return packIds.map((id) => {
    const spec = packs[id]
    const source: Source = {
      name: spec.sources.map((item) => item.name).join(' + '),
      license: [...new Set(spec.sources.map((item) => item.license))].join(
        ' + ',
      ),
      url: {
        en: 'https://en-word.net/',
        zh: 'https://www.mdbg.net/chinese/dictionary?page=cedict',
        yue: 'https://cantonese.org/download.html',
        ja: 'https://www.edrdg.org/jmdict/j_jmdict.html',
        tl: 'https://kaikki.org/dictionary/Tagalog/',
        fr: 'https://kaikki.org/dictionary/French/',
        de: 'https://kaikki.org/dictionary/German/',
      }[id],
    }
    async function read(term: string, signal: AbortSignal) {
      return query<PackEntry[]>('packLookup', { id, word: term }, signal)
    }
    const provider: DictionaryProvider = {
      id: `offline-${id}`,
      label: spec.label,
      kind: 'offline',
      languages: [id],
      installed: () => native.query<boolean>('packInstalled', id),
      async lookup(term, lang, signal) {
        if (lang !== id) return []
        try {
          const entries = await read(term, signal)
          return entries.flatMap((entry) =>
            entry.meanings.map((meaning) => ({
              term: entry.word,
              lang,
              ...(entry.readings?.length
                ? { reading: entry.readings.join('; ') }
                : {}),
              ...(meaning.partOfSpeech
                ? { partOfSpeech: meaning.partOfSpeech }
                : {}),
              senses: meaning.definitions.map(({ definition, example }) => ({
                gloss: definition,
                ...(example ? { example } : {}),
              })),
              synonyms: meaning.synonyms,
              source:
                id === 'tl' || id === 'fr' || id === 'de'
                  ? {
                      ...source,
                      url: `https://en.wiktionary.org/wiki/${encodeURIComponent(entry.word)}#${id === 'fr' ? 'French' : id === 'de' ? 'German' : 'Tagalog'}`,
                    }
                  : source,
            })),
          )
        } catch (error) {
          if (signal.aborted) throw error
          throw new DictionaryError('unavailable')
        }
      },
      async complete(prefix, lang, signal, limit = 8) {
        signal.throwIfAborted()
        if (lang !== id || !prefix.trim()) return []
        try {
          const words = await query<string[]>(
            'packComplete',
            { id, prefix, limit },
            signal,
          )
          return words
        } catch (error) {
          if (signal.aborted) throw error
          throw new DictionaryError('unavailable')
        }
      },
      async related(term, lang, signal) {
        if (lang !== id) return null
        const entries = await read(term, signal)
        const synonyms = [
          ...new Set(entries.flatMap((entry) => entry.synonyms)),
        ].filter((word) => word.toLowerCase() !== term.toLowerCase())
        const antonyms = [
          ...new Set(entries.flatMap((entry) => entry.antonyms)),
        ]
        return synonyms.length || antonyms.length
          ? {
              synonyms: synonyms.slice(0, 64),
              antonyms: antonyms.slice(0, 64),
              source,
            }
          : null
      },
    }
    return provider
  })
}
