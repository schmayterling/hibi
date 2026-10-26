import {
  type CompletionProvider,
  safeCompletionContext,
  sourceProseAllowed,
} from '../../shared/completions.ts'
import type { DictionaryApi } from '../dictionary/api.ts'
import { yours } from '../dictionary/custom-words.ts'
import { matchCase } from '../dictionary/lookup.ts'
import type { Lang } from '../dictionary/providers.ts'
import type { createLearning } from './learning.ts'
import { hasInternalCapitals, type PersonalScope } from './model.ts'
import type { AutocompletePreferences } from './settings.ts'

const MIN_PREFIX = 3
const MAX_ITEMS = 8
const wordKey = (word: string) => word.normalize('NFC').toLowerCase()
const partial =
  /(?:^|[^\p{L}\p{M}'’-])(\p{Script=Latin}[\p{Script=Latin}\p{M}'’-]*)$/u

// Only quotes, brackets, and emphasis may open a prose word.
const opening = /^(?:[("'“‘*_~]|\[(?!\[))*$/u

/** The Latin-script prose word being typed, excluding commands, code, and urls. */
export function prefixAt(before: string, after: string) {
  if (/^[\p{L}\p{M}]/u.test(after)) return null
  const word = partial.exec(before)?.[1]
  if (!word || word.length < MIN_PREFIX || word.length > 64) return null
  const line = before.slice(before.lastIndexOf('\n') + 1)
  const token = /\S*$/u.exec(line)?.[0] ?? ''
  return opening.test(token.slice(0, -word.length)) &&
    sourceProseAllowed(before) &&
    safeCompletionContext(before, before.length)
    ? word
    : null
}

/**
 * Orders pack matches for `prefix`, given in the user's language order. Match
 * quality comes first: words that start with the prefix as typed (accents
 * included) before accent-folded matches, single words before phrases, and
 * lowercase headwords before names unless the prefix is capitalized (German
 * capitalizes every noun, so its case is not held against it). Language order
 * comes next, then shorter words; packs carry no word frequencies. The same
 * word from several languages is kept once, and the prefix itself is dropped.
 */
export function rankWords(
  prefix: string,
  found: readonly { lang: Lang; words: readonly string[] }[],
) {
  const typed = wordKey(prefix)
  const capital = prefix[0] !== prefix[0]?.toLowerCase()
  const quality = (word: string, lang: Lang) =>
    Number(!wordKey(word).startsWith(typed)) * 4 +
    Number(/\s/.test(word)) * 2 +
    Number(lang !== 'de' && !capital && word[0] !== word[0]?.toLowerCase())
  const candidates = found.flatMap(({ lang, words }, order) =>
    words
      .filter((word) => word.length <= 64 && !/[\r\n]/.test(word))
      .map((word) => ({ word, lang, order, quality: quality(word, lang) })),
  )
  candidates.sort(
    (left, right) =>
      left.quality - right.quality ||
      left.order - right.order ||
      left.word.length - right.word.length ||
      left.word.localeCompare(right.word),
  )
  const seen = new Set([typed])
  const ranked: { word: string; lang: Lang }[] = []
  for (const { word, lang } of candidates) {
    const lower = wordKey(word)
    if (seen.has(lower)) continue
    seen.add(lower)
    ranked.push({ word, lang })
    if (ranked.length === MAX_ITEMS) break
  }
  return ranked
}

/** Match typed casing while retaining learned names with internal capitals. */
export function insertionText(
  prefix: string,
  word: string,
  source: 'baseline' | 'personal',
) {
  return source === 'personal' && hasInternalCapitals(word)
    ? word
    : matchCase(prefix, word)
}

export type TypingSession = {
  scope: PersonalScope
  documentId: string
  personal: boolean
}

/** At most two contiguous words, never joined across punctuation or a sentence. */
export function precedingWords(before: string): string[] {
  const line = before.slice(before.lastIndexOf('\n') + 1).trimEnd()
  const tail = line.split(/[ \t]+/).slice(-2)
  const invalid = tail.findLastIndex(
    (word) => !/^[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*$/u.test(word),
  )
  return tail.slice(invalid + 1)
}

export function autocompleteCompletions(
  dictionary: DictionaryApi,
  preferences: () => AutocompletePreferences,
  learning: Pick<ReturnType<typeof createLearning>, 'suggest' | 'epoch'>,
  session: () => TypingSession | null,
  languageName: (lang: Lang) => string,
): CompletionProvider {
  return async (request, signal) => {
    signal.throwIfAborted()
    const settings = preferences()
    const captured = session()
    const prose = request.prose
    const { anchor, head } = request.selection
    if (
      !settings.suggest ||
      !captured ||
      !prose ||
      anchor !== head ||
      captured.documentId !== request.view.documentId
    )
      return []
    const prefix = prefixAt(prose.before, prose.after)
    const nextWord =
      /[ \t]$/.test(prose.before) &&
      !/^[\p{L}\p{M}]/u.test(prose.after) &&
      !/\[\[[^\]\r\n]*$/.test(request.before)
    if (prefix === null && !nextWord) return []
    const typed = prefix ?? ''
    const context = precedingWords(
      prose.before.slice(0, prose.before.length - typed.length),
    )
    const epoch = learning.epoch()
    const available = dictionary.suggestionLanguages()
    const langs = settings.languages.filter((lang) => available.includes(lang))
    const firstLang = langs[0]
    if (!firstLang) return []
    const found = typed
      ? await dictionary.complete(typed, langs, 24, signal).catch((error) => {
          if (signal.aborted) throw error
          return []
        })
      : []
    signal.throwIfAborted()
    if (
      session() !== captured ||
      preferences() !== settings ||
      learning.epoch() !== epoch
    )
      return []
    const vocabulary = !typed
      ? []
      : dictionary.customCompletions
        ? await dictionary
            .customCompletions(typed, langs, 64, signal)
            .catch((error) => {
              if (signal.aborted) throw error
              return []
            })
        : await dictionary.customWords()
    signal.throwIfAborted()
    if (
      session() !== captured ||
      preferences() !== settings ||
      learning.epoch() !== epoch
    )
      return []
    const customNames = new Set<string>()
    const custom = vocabulary
      .filter(
        (item) =>
          (!item.lang || langs.includes(item.lang)) &&
          wordKey(item.word).startsWith(wordKey(typed)) &&
          wordKey(item.word) !== wordKey(typed),
      )
      .sort((a, b) => a.word.length - b.word.length)
      .filter((item) => {
        const key = wordKey(item.word)
        if (customNames.has(key)) return false
        customNames.add(key)
        return true
      })
      .slice(0, 64)
    const baseline = rankWords(typed, found).filter(
      (item) => !customNames.has(wordKey(item.word)),
    )
    const ranked = learning.suggest({
      scope: captured.scope,
      languages: langs,
      context,
      prefix: typed,
      baseline: [
        ...baseline,
        ...custom.map((item) => ({
          word: item.word,
          lang: item.lang ?? firstLang,
          custom: true,
        })),
      ],
      enabled: settings.learning && captured.personal,
      limit: MAX_ITEMS,
    })
    const several = langs.length > 1
    return ranked.map(({ word, lang, score, source }) => ({
      label: word,
      ...(customNames.has(wordKey(word))
        ? { detail: yours.label }
        : several
          ? { detail: languageName(lang) }
          : {}),
      insertText: insertionText(typed, word, source),
      from: head - typed.length,
      to: head,
      rank: score * 100,
      preselect: false,
      acceptOnEnter: typed ? 'selected' : false,
      ...(typed ? {} : { captureArrowKeys: false }),
      ...(typed && settings.tabAccepts ? {} : { acceptOnTab: false }),
    }))
  }
}
