import { LANGS, type Lang } from './providers.ts'

/** A local word; its id survives note and language edits. */
export type CustomWord = {
  id?: string
  word: string
  lang?: Lang
  note?: string
}
const valid = new WeakSet<CustomWord>()
const keys = new WeakMap<CustomWord, string>()
export function customWordKey(word: CustomWord) {
  const cached = keys.get(word)
  if (cached !== undefined) return cached
  const key = `${word.word.normalize('NFC').toLowerCase()}\u0000${word.lang ?? ''}`
  if (Object.isFrozen(word)) keys.set(word, key)
  return key
}

export function wordText(word: string) {
  const text = word.trim().normalize('NFC')
  return text && !/\p{Cc}/u.test(text) ? text : undefined
}

/** Valid words only, first spelling kept for each word and language. */
export function customWords(value: unknown): CustomWord[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const words: CustomWord[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    let entry: CustomWord
    if (valid.has(item)) entry = item
    else {
      const { id, word, lang, note } = item as Record<string, unknown>
      if (typeof word !== 'string') continue
      const text = wordText(word)
      if (!text) continue
      entry = Object.freeze({
        ...(typeof id === 'string' && id && id.length <= 128 ? { id } : {}),
        word: text,
        ...(LANGS.includes(lang as Lang) ? { lang: lang as Lang } : {}),
        ...(typeof note === 'string' && note.trim()
          ? { note: note.trim() }
          : {}),
      })
      valid.add(entry)
    }
    const identity = customWordKey(entry)
    if (seen.has(identity)) continue
    seen.add(identity)
    words.push(entry)
  }
  return words
}
