import {
  HOST_SELECTED_IO_MAX_BYTES,
  type HostSelectedIoHostApi,
} from '../../shared/host-selected-io.ts'
import type { AddonContext } from '../api'
import { type CustomWord, customWords, wordText } from './custom-word-data.ts'
import {
  type IndexedCustomWords,
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

let handle: IndexedCustomWords | null = null
let wordNative: AddonContext['native'] | null = null
let opening = 0
let failure = ''
export const customWordsFailure = () => failure
let fileIo: HostSelectedIoHostApi | null = null
let revision = 0
const listeners = new Set<() => void>()
let view = {
  indexed: null as IndexedCustomWords | null,
  count: 0,
  revision: 0,
  version: 0,
}
export const customWordsView = () => view
function publishView() {
  view = {
    indexed: handle,
    count: handle?.snapshot().count ?? 0,
    revision,
    version: view.version + 1,
  }
  for (const listener of listeners) listener()
}
/** Complete vocabulary only when a consumer explicitly requests it. */
export async function readCustomWords() {
  const opened = handle
  if (!opened) return Object.freeze([])
  const loaded = await readAll(opened)
  if (handle !== opened)
    throw new Error('Turn on Dictionary and thesaurus to keep custom words.')
  return Object.freeze(loaded)
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
  storage?: IndexedCustomWords,
) {
  const captured = ++opening
  if (handle) {
    handle = null
    fileIo = null
    revision = 0
    publishView()
  }
  wordNative = context.native
  let opened: IndexedCustomWords
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
      publishView()
    }
    throw error
  }
  if (captured !== opening) {
    opened.close()
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
      publishView()
    }
    opened.close()
  }
}

/** Publishes metadata and visible-page changes; older revisions never replace newer ones. */
function sync() {
  const snapshot = handle?.snapshot()
  if (!snapshot || snapshot.revision < revision) return
  revision = snapshot.revision
  publishView()
}

let saving: Promise<unknown> = Promise.resolve()
let pendingSaves = new Set<Promise<unknown>>()
let exportBarriers = new Set<Set<Promise<unknown>>>()

/** Runs keyed saves in order; later edits fetch the latest saved record. */
function queueSave<T>(change: (opened: IndexedCustomWords) => Promise<T>) {
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
  return queueSave(async (opened) => {
    if (!original.id)
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
}

export function removeCustomWord(word: CustomWord) {
  return queueSave(async (opened) => {
    const id = word.id
    if (!id)
      throw new Error('This word was removed or changed in another window.')
    const current = await opened.get(id)
    if (!current.word)
      throw new Error('This word was removed or changed in another window.')
    await opened.change(
      async (stage) => {
        await stage({ remove: [id] })
      },
      { revision: current.revision, remove: id },
    )
  })
}

/** Adds a word or updates its note; a listed word keeps its note when none is supplied. */
export function addCustomWord(word: CustomWord) {
  const [added] = customWords([word])
  if (!added) return Promise.reject(new Error('Enter a word to add.'))
  return queueSave(async (opened) => {
    await opened.change(async (stage) => {
      await stage({
        upsert: [added],
        merge: true,
        keepNote: word.note === undefined,
      })
    })
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
      let exported: string
      try {
        exported = await exportIndexedWords(opened)
      } catch (error) {
        if (tail !== saving) continue
        if (
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

/** Parses bounded slices while the save/export queue stays intact. */
export function importSavedCustomWords(text: string) {
  return queueSave(async (opened) => {
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
      const captured = opening
      if (!native) return []
      const matches = (
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
      signal?.throwIfAborted()
      if (native !== wordNative || captured !== opening) return []
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
