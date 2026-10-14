import type { AddonStorageHandle } from '../../shared/addon-storage'
import type { HostSelectedIoHostApi } from '../../shared/host-selected-io'
import type { AddonContext } from '../api'
import {
  type DictionaryProvider,
  type Entry,
  LANGS,
  type Lang,
} from './providers.ts'

/**
 * A word the user added. Without `lang`, it belongs to the word's first lookup
 * language. Listed words always have an `id` that stays the same when their
 * language or note changes.
 */
export type CustomWord = {
  id?: string
  word: string
  lang?: Lang
  note?: string
}

// `label` and `detail` fields are collected into the UI copy catalog.
export const yours = {
  label: 'Your word',
  detail: 'Added to your dictionary.',
}
const MAX_WORDS = 5000
const MAX_NOTE = 2000
const key = (word: CustomWord) =>
  `${word.word.normalize('NFC').toLowerCase()}\u0000${word.lang ?? ''}`

function wordText(word: string) {
  const text = word.trim().normalize('NFC')
  return text && text.length <= 64 && !/[\p{Cc}]/u.test(text) ? text : undefined
}

/** Valid words only, first spelling kept for each word and language. */
export function customWords(value: unknown, limit = MAX_WORDS): CustomWord[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const words: CustomWord[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const { id, word, lang, note } = item as Record<string, unknown>
    if (typeof word !== 'string') continue
    const text = wordText(word)
    if (!text) continue
    const entry: CustomWord = {
      ...(typeof id === 'string' && id && id.length <= 128 ? { id } : {}),
      word: text,
      ...(LANGS.includes(lang as Lang) ? { lang: lang as Lang } : {}),
      ...(typeof note === 'string' && note.trim()
        ? { note: note.trim().slice(0, MAX_NOTE) }
        : {}),
    }
    if (seen.has(key(entry))) continue
    seen.add(key(entry))
    words.push(Object.freeze(entry))
    if (words.length === limit) break
  }
  return words
}

/**
 * Gives each word a unique `id`. New words get a random one; words `loaded`
 * from before ids existed get one from their word and language, so it stays
 * the same until they are saved.
 */
function withIds(list: CustomWord[], loaded = false) {
  const ids = new Set<string>()
  return list.map((item) => {
    let id = item.id && !ids.has(item.id) ? item.id : loaded ? key(item) : ''
    if (!id || ids.has(id)) id = crypto.randomUUID()
    ids.add(id)
    return id === item.id ? item : Object.freeze({ ...item, id })
  })
}

let words: readonly CustomWord[] = Object.freeze([])
let handle: AddonStorageHandle<unknown> | null = null
let fileIo: HostSelectedIoHostApi | null = null
let revision = 0
const listeners = new Set<() => void>()

function publish(next: CustomWord[]) {
  words = Object.freeze(next)
  for (const listener of listeners) listener()
}

/** The user's words, in the order they were added. Local only; never sent. */
export function listCustomWords(): readonly CustomWord[] {
  return words
}

export function onCustomWordsChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** File picking for settings, which render without the addon's context; null while closed. */
export function customWordsFileIo() {
  return fileIo
}

/** Loads the saved words and follows changes made in other windows. */
export async function openCustomWords(context: AddonContext) {
  const opened = await context.storage.global<unknown>('custom-words', 1)
  handle = opened
  saving = Promise.resolve()
  pendingSaves = new Set()
  exportBarriers = new Set()
  fileIo = context.host.selectedIo
  revision = 0
  sync()
  const stop = opened.subscribe(sync)
  return () => {
    stop()
    if (handle === opened) {
      handle = null
      fileIo = null
    }
    revision = 0
    publish([])
  }
}

/** Publishes the handle's latest words; an older revision never replaces a newer one. */
function sync() {
  const snapshot = handle?.snapshot()
  if (!snapshot) return
  if (snapshot.status === 'ready') {
    if (snapshot.revision < revision) return
    revision = snapshot.revision
  }
  publish(
    snapshot.status === 'ready'
      ? withIds(customWords(snapshot.value), true)
      : [],
  )
}

let saving: Promise<unknown> = Promise.resolve()
let pendingSaves = new Set<Promise<unknown>>()
let exportBarriers = new Set<Set<Promise<unknown>>>()

/**
 * Saves `change` applied to the latest list. Changes run one at a time, so a
 * quick edit after another never works from a stale list. Rejects with a
 * message the UI can show.
 */
export function updateCustomWords(
  change: (current: readonly CustomWord[]) => readonly CustomWord[],
) {
  const opened = handle
  const previous = saving.catch(() => {})
  const run = previous.then(async () => {
    if (!opened || handle !== opened)
      throw new Error('Turn on Dictionary and thesaurus to keep custom words.')
    const next = withIds(customWords(change(words), Infinity))
    if (next.length > MAX_WORDS)
      throw new Error(
        'You can keep up to 5,000 custom words. Remove some to add more.',
      )
    const result = await opened.set(next)
    if (handle !== opened)
      throw new Error('Turn on Dictionary and thesaurus to keep custom words.')
    if (result.status === 'conflict')
      throw new Error('Custom words changed in another window. Try again.')
    if (result.status !== 'saved')
      throw new Error('Could not save custom words.')
    // A newer change from another window may have arrived before this reply.
    sync()
  })
  saving = run
  const pending = pendingSaves
  pending.add(run)
  for (const barrier of exportBarriers) barrier.add(run)
  void run.then(
    () => pending.delete(run),
    () => pending.delete(run),
  )
  return run
}

/**
 * Applies `change` to the saved entry with `original`'s id when its turn
 * comes, so queued edits to different fields of one word all keep. Rejects
 * when the word is no longer listed.
 */
export function editCustomWord(
  original: CustomWord,
  change: (current: CustomWord) => CustomWord,
) {
  return updateCustomWords((current) => {
    const { id } = original
    const index = current.findIndex((item) => id && item.id === id)
    const item = current[index]
    if (!id || !item)
      throw new Error('This word was removed or changed in another window.')
    return current.with(index, { ...change(item), id })
  })
}

/** `incoming` words replace matching ones in place, keeping their ids; the rest are added at the end. */
export function mergeCustomWords(
  current: readonly CustomWord[],
  incoming: readonly CustomWord[],
) {
  const merged = new Map(current.map((item) => [key(item), item]))
  for (const { id: _id, ...item } of customWords(incoming, Infinity)) {
    const id = merged.get(key(item))?.id
    merged.set(key(item), id ? { ...item, id } : item)
  }
  return [...merged.values()]
}

/** Adds `word`, or updates its note when it is already listed; a listed word keeps its note when `word` has none. */
export function addCustomWord(word: CustomWord) {
  const [added] = customWords([word])
  if (!added) return Promise.reject(new Error('Enter a word to add.'))
  return updateCustomWords((current) => {
    const note =
      word.note === undefined
        ? current.find((item) => key(item) === key(added))?.note
        : undefined
    return mergeCustomWords(current, [note ? { ...added, note } : added])
  })
}

/**
 * One word per line: `word`, then optional tab-separated language code and
 * note. A backslash goes before a word starting with `#` (after any
 * backslashes) so it is not read back as a comment.
 */
export function exportCustomWords(list: readonly CustomWord[]) {
  return list
    .map((item) =>
      [
        item.word.replace(/^(?=\\*#)/, '\\'),
        item.lang ?? '',
        item.note?.replace(/\s+/g, ' ') ?? '',
      ]
        .join('\t')
        .trimEnd(),
    )
    .join('\n')
}

/**
 * Exports after every captured or joining save settles; any failure rejects.
 * `ready` waits for file selection; false cancels without waiting for saves.
 */
export async function exportSavedCustomWords(ready?: Promise<boolean>) {
  const opened = handle
  const active = exportBarriers
  const pending = new Set([...pendingSaves, saving])
  active.add(pending)
  try {
    if (ready && !(await ready)) return ''
    for (;;) {
      const tail = saving
      const results = await Promise.allSettled(pending)
      if (!opened || handle !== opened)
        throw new Error(
          'Turn on Dictionary and thesaurus to keep custom words.',
        )
      if (tail !== saving) continue
      const failure = results.find((result) => result.status === 'rejected')
      if (failure) throw failure.reason
      return exportCustomWords(words)
    }
  } finally {
    active.delete(pending)
  }
}

/**
 * Parses one line at a time, skipping blanks and comments. Keeps one word over
 * capacity so the queued merge rejects the whole import instead of a partial list.
 */
export function importCustomWords(text: string) {
  const words: CustomWord[] = []
  const seen = new Set<string>()
  for (let start = 0; start < text.length; ) {
    const newline = text.indexOf('\n', start)
    const end = newline < 0 ? text.length : newline
    const line = text.slice(start, end)
    start = end + 1
    if (line.trimStart().startsWith('#')) continue
    const first = line.indexOf('\t')
    const word = wordText(
      (first < 0 ? line : line.slice(0, first))
        .trim()
        .replace(/^\\(?=\\*#)/, ''),
    )
    if (!word) continue
    const second = first < 0 ? -1 : line.indexOf('\t', first + 1)
    const code =
      first < 0
        ? undefined
        : line.slice(first + 1, second < 0 ? undefined : second).trim()
    const lang = LANGS.includes(code as Lang) ? (code as Lang) : undefined
    const id = `${word.toLowerCase()}\u0000${lang ?? ''}`
    if (seen.has(id)) continue
    seen.add(id)
    const note =
      second < 0
        ? ''
        : line
            .slice(second + 1)
            .trim()
            .slice(0, MAX_NOTE)
            .replaceAll('\t', ' ')
    words.push(
      Object.freeze({
        word,
        ...(lang ? { lang } : {}),
        ...(note ? { note } : {}),
      }),
    )
    if (words.length > MAX_WORDS) break
  }
  return words
}

/**
 * Lookups for the user's words, marked as theirs. `first` names the language
 * a word without one belongs to, so it is answered once.
 */
export function customWordsProvider(
  first: (term: string) => Lang | undefined,
): DictionaryProvider {
  return {
    id: 'custom-words',
    label: 'Your words',
    kind: 'offline',
    languages: LANGS,
    async lookup(term, lang) {
      const wanted = term.trim().normalize('NFC').toLowerCase()
      return words
        .filter(
          (item) =>
            item.word.toLowerCase() === wanted &&
            (item.lang ?? first(item.word)) === lang,
        )
        .map(
          (item): Entry => ({
            term: item.word,
            lang,
            senses: [{ gloss: item.note ?? yours.detail }],
            source: { name: yours.label, license: '' },
          }),
        )
    },
  }
}
