import {
  HOST_SELECTED_IO_MAX_BYTES,
  type HostSelectedIoHostApi,
} from '../../shared/host-selected-io.ts'
import type { AddonContext } from '../api'
import {
  type CustomWord,
  customWords,
  customWordKey as key,
  wordText,
} from './custom-word-data.ts'
import {
  type CustomWordStorage,
  IndexedCustomWords,
  openCustomWordStorage,
} from './custom-word-storage.ts'
import {
  type DictionaryProvider,
  type Entry,
  LANGS,
  type Lang,
} from './providers.ts'

export { type CustomWord, customWords } from './custom-word-data.ts'

// `label` and `detail` fields are collected into the UI copy catalog.
export const yours = {
  label: 'Your word',
  detail: 'Added to your dictionary.',
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
let handle: CustomWordStorage | IndexedCustomWords | null = null
let wordNative: AddonContext['native'] | null = null
let opening = 0
let failure = ''
let byTerm = new Map<string, CustomWord[]>()
export const customWordsFailure = () => failure
let fileIo: HostSelectedIoHostApi | null = null
let revision = 0
const listeners = new Set<() => void>()
let view = {
  words,
  indexed: null as IndexedCustomWords | null,
  count: 0,
  revision: 0,
  version: 0,
}
export const customWordsView = () => view
function publishView() {
  const indexed = handle instanceof IndexedCustomWords ? handle : null
  view = {
    words,
    indexed,
    count: indexed?.snapshot().count ?? words.length,
    revision,
    version: view.version + 1,
  }
  for (const listener of listeners) listener()
}
/** Complete vocabulary only when a consumer explicitly requests it. */
export async function readCustomWords() {
  const opened = handle
  if (opened instanceof IndexedCustomWords) {
    const loaded = await readAll(opened)
    if (handle !== opened)
      throw new Error('Turn on Dictionary and thesaurus to keep custom words.')
    return Object.freeze(loaded)
  }
  return words
}

function publish(next: CustomWord[]) {
  words = Object.freeze(next)
  byTerm = new Map()
  for (const word of wordNative ? [] : next) {
    const term = word.word.toLowerCase()
    const found = byTerm.get(term)
    if (found) found.push(word)
    else byTerm.set(term, [word])
  }
  publishView()
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
export async function openCustomWords(
  context: AddonContext,
  storage?: CustomWordStorage | IndexedCustomWords,
) {
  const captured = ++opening
  if (handle) {
    handle = null
    fileIo = null
    revision = 0
    publish([])
  }
  wordNative = storage ? null : context.native
  let opened: CustomWordStorage | IndexedCustomWords
  try {
    opened =
      storage ??
      (await openCustomWordStorage(
        context.native,
        // Profile storage stays available while a user-file dialog is open.
        <T>(method: string, input?: unknown) =>
          window.hibi.invokeAddonProfile(
            'dictionary',
            method,
            input,
          ) as Promise<T>,
      ))
  } catch (error) {
    if (captured === opening) {
      failure =
        error instanceof Error ? error.message : 'Could not save custom words.'
      publish([])
    }
    throw error
  }
  if (captured !== opening) {
    opened.close?.()
    return () => {}
  }
  failure = ''
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
      opening++
      wordNative = null
      handle = null
      fileIo = null
      revision = 0
      publish([])
    }
    opened.close?.()
  }
}

/** Publishes the handle's latest words; an older revision never replaces a newer one. */
function sync() {
  if (handle instanceof IndexedCustomWords) {
    const snapshot = handle.snapshot()
    if (snapshot.revision < revision) return
    if (snapshot.revision !== revision) {
      words = Object.freeze([])
    }
    revision = snapshot.revision
    publishView()
    return
  }
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
function queueSave<T>(
  change: (opened: CustomWordStorage | IndexedCustomWords) => Promise<T>,
) {
  const opened = handle
  const previous = saving.catch(() => {})
  const run = previous.then(async () => {
    if (failure) throw new Error(failure)
    if (!opened || handle !== opened)
      throw new Error('Turn on Dictionary and thesaurus to keep custom words.')
    const result = await change(opened)
    if (handle !== opened)
      throw new Error('Turn on Dictionary and thesaurus to keep custom words.')
    sync()
    return result
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

/** Explicit whole-list changes; ordinary row edits use keyed operations below. */
export function updateCustomWords(
  change: (
    current: readonly CustomWord[],
  ) => readonly CustomWord[] | Promise<readonly CustomWord[]>,
) {
  return queueSave(async (opened) => {
    const baseRevision = revision
    const current =
      opened instanceof IndexedCustomWords ? await readAll(opened) : words
    const changed = await change(current)
    if (revision !== baseRevision)
      throw new Error('Custom words changed in another window. Try again.')
    if (changed === current) return
    const next = withIds(customWords(changed))
    if (next.length !== changed.length)
      throw new Error('Could not save custom words.')
    if (opened instanceof IndexedCustomWords) {
      const old = new Map(current.map((word) => [word.id, word]))
      const upsert = next.filter((word) => {
        const prior = old.get(word.id)
        old.delete(word.id)
        return prior !== word
      })
      await opened.change(
        async (stage) => {
          await stage({
            upsert,
            remove: [...old.keys()].filter((id): id is string => !!id),
          })
        },
        { revision: baseRevision },
      )
    } else {
      const result = await opened.set(next)
      if (result.status === 'conflict')
        throw new Error('Custom words changed in another window. Try again.')
      if (result.status !== 'saved')
        throw new Error('Could not save custom words.')
    }
  })
}

async function readAll(opened: IndexedCustomWords) {
  const revision = opened.snapshot().revision
  const words: CustomWord[] = []
  let after = 0
  for (;;) {
    const page = await opened.page({ after, revision })
    words.push(...page.words)
    if (!page.more) return words
    after = page.after
  }
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
  if (handle instanceof IndexedCustomWords)
    return queueSave(async (opened) => {
      if (!(opened instanceof IndexedCustomWords) || !original.id)
        throw new Error('This word was removed or changed in another window.')
      const current = await opened.get(original.id)
      if (!current.word)
        throw new Error('This word was removed or changed in another window.')
      const [next] = customWords([{ ...change(current.word), id: original.id }])
      if (!next) throw new Error('Could not save custom words.')
      await opened.change(
        async (stage) => {
          await stage({ upsert: [next] })
        },
        { revision: current.revision, put: next },
      )
    })
  return updateCustomWords((current) => {
    const { id } = original
    const index = current.findIndex((item) => id && item.id === id)
    const item = current[index]
    if (!id || !item)
      throw new Error('This word was removed or changed in another window.')
    return current.with(index, { ...change(item), id })
  })
}

export function removeCustomWord(word: CustomWord) {
  if (handle instanceof IndexedCustomWords)
    return queueSave(async (opened) => {
      if (!(opened instanceof IndexedCustomWords) || !word.id)
        throw new Error('This word was removed or changed in another window.')
      const current = await opened.get(word.id)
      if (!current.word)
        throw new Error('This word was removed or changed in another window.')
      await opened.change(
        async (stage) => {
          await stage({ remove: [word.id as string] })
        },
        { revision: current.revision, remove: word.id },
      )
    })
  return updateCustomWords((current) =>
    current.filter((item) => item.id !== word.id),
  )
}

/** `incoming` words replace matching ones in place, keeping their ids; the rest are added at the end. */
export function mergeCustomWords(
  current: readonly CustomWord[],
  incoming: readonly CustomWord[],
) {
  const merged = new Map(current.map((item) => [key(item), item]))
  for (const item of customWords(incoming)) {
    const id = merged.get(key(item))?.id ?? item.id
    merged.set(key(item), id && id !== item.id ? { ...item, id } : item)
  }
  return [...merged.values()]
}

/** Adds `word`, or updates its note when it is already listed; a listed word keeps its note when `word` has none. */
export function addCustomWord(word: CustomWord) {
  const [added] = customWords([word])
  if (!added) return Promise.reject(new Error('Enter a word to add.'))
  if (handle instanceof IndexedCustomWords)
    return queueSave(async (opened) => {
      if (!(opened instanceof IndexedCustomWords))
        throw new Error('Could not save custom words.')
      await opened.change(async (stage) => {
        await stage({
          upsert: [added],
          merge: true,
          keepNote: word.note === undefined,
        })
      })
    })
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
      const snapshot = words
      let exported: string
      try {
        exported =
          opened instanceof IndexedCustomWords
            ? await exportIndexedWords(opened)
            : await exportWordsInSlices(snapshot)
      } catch (error) {
        if (tail !== saving) continue
        if (
          opened instanceof IndexedCustomWords &&
          error instanceof Error &&
          error.message.includes('Custom words changed in another window.')
        ) {
          await opened.refresh()
          continue
        }
        throw error
      }
      if (handle !== opened)
        throw new Error(
          'Turn on Dictionary and thesaurus to keep custom words.',
        )
      if (tail !== saving) continue
      return exported
    }
  } finally {
    active.delete(pending)
  }
}

/**
 * Parses one line at a time, skipping blanks and comments.
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
            .replaceAll('\t', ' ')
    words.push(
      Object.freeze({
        word,
        ...(lang ? { lang } : {}),
        ...(note ? { note } : {}),
      }),
    )
  }
  return words
}

function yieldToInput() {
  const channel = new MessageChannel()
  return new Promise<void>((resolve) => {
    channel.port1.onmessage = () => {
      channel.port1.close()
      channel.port2.close()
      resolve()
    }
    channel.port2.postMessage(null)
  })
}

/** Parse and assign ids in bounded slices while the save/export queue stays intact. */
export async function importSavedCustomWords(text: string) {
  if (handle instanceof IndexedCustomWords)
    return queueSave(async (opened) => {
      if (!(opened instanceof IndexedCustomWords))
        throw new Error('Could not save custom words.')
      const result = await opened.change(async (stage) => {
        for (let start = 0; start < text.length; ) {
          let end = text.indexOf('\n', start + 16384)
          if (end < 0) end = text.length
          const parsed = importCustomWords(text.slice(start, end))
          if (parsed.length)
            await stage({ upsert: parsed, merge: true, first: true })
          start = end + 1
          if (start < text.length) await yieldToInput()
        }
      })
      return result.changed
    })
  let count = 0
  await updateCustomWords(async (current) => {
    const imported = new Map<string, CustomWord>()
    for (let start = 0; start < text.length; ) {
      let end = text.indexOf('\n', start + 16384)
      if (end < 0) end = text.length
      const parsed = customWords(
        importCustomWords(text.slice(start, end)).map((word) => ({
          ...word,
          id: crypto.randomUUID(),
        })),
      )
      for (const word of parsed)
        if (!imported.has(key(word))) imported.set(key(word), word)
      start = end + 1
      if (start < text.length) await yieldToInput()
    }
    count = imported.size
    return count ? mergeCustomWords(current, [...imported.values()]) : current
  })
  return count
}

async function exportIndexedWords(opened: IndexedCustomWords) {
  const revision = opened.snapshot().revision
  const chunks: string[] = []
  const encoder = new TextEncoder()
  let bytes = 0
  let after = 0
  for (;;) {
    const page = await opened.page({ after, revision })
    const chunk = exportCustomWords(page.words)
    bytes += encoder.encode(chunk).length + (chunks.length ? 1 : 0)
    if (bytes > HOST_SELECTED_IO_MAX_BYTES)
      throw new Error(
        'This export exceeds the file or clipboard transfer limit.',
      )
    if (chunk) chunks.push(chunk)
    if (!page.more) return chunks.join('\n')
    after = page.after
  }
}

async function exportWordsInSlices(list: readonly CustomWord[]) {
  const chunks: string[] = []
  const encoder = new TextEncoder()
  let bytes = 0
  for (let start = 0; start < list.length; start += 256) {
    const chunk = exportCustomWords(list.slice(start, start + 256))
    bytes += encoder.encode(chunk).length + (start ? 1 : 0)
    // ponytail: host file/clipboard requests are bounded; stream export when chunked host io is available.
    if (bytes > HOST_SELECTED_IO_MAX_BYTES)
      throw new Error(
        'This export exceeds the file or clipboard transfer limit.',
      )
    chunks.push(chunk)
    if (start + 256 < list.length) await yieldToInput()
  }
  return chunks.join('\n')
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
    async lookup(term, lang, signal) {
      const wanted = term.trim().normalize('NFC').toLowerCase()
      const native = wordNative
      const matches = native
        ? (
            await Promise.all([
              native.query<CustomWord[]>('customWordsLookup', { term, lang }),
              first(term) === lang
                ? native.query<CustomWord[]>('customWordsLookup', {
                    term,
                    lang: '',
                  })
                : [],
            ])
          ).flat()
        : (byTerm.get(wanted) ?? [])
      signal?.throwIfAborted()
      if (native !== wordNative) return []
      return matches
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
