import { join } from 'node:path'
import { app, clipboard } from 'electron'
import { HOST_SELECTED_IO_MAX_BYTES } from '../../shared/host-selected-io'
import type { NativeAddon } from '../api'
import { CustomWordStore } from './custom-word-store'
import manifest from './manifest'
import { completionLimit, completionPrefix } from './pack-runtime'
import { PackStore } from './pack-store'
import { lookupInput, packId } from './packs'

let current: PackStore | undefined
let words: CustomWordStore | undefined
let closing = Promise.resolve()
let generation = 0
let closeFailures = 0
let retryAfter = 0
async function waitForClose(captured: number) {
  // Retain the old stores until their close succeeds, sharing any retry.
  const previous = closing
  await previous.catch((error) => {
    if (captured !== generation) return
    if (closing !== previous) return closing
    // Inside the backoff window a request fails fast instead of sending another close.
    if (Date.now() < retryAfter) throw error
    return closeStores()
  })
}
async function store() {
  const captured = generation
  await waitForClose(captured)
  if (captured !== generation) throw new Error('Dictionary packs are closed.')
  current ??= new PackStore(
    join(app.getPath('userData'), 'dictionary-packs'),
    join(app.getAppPath(), 'out/main/dictionary-pack-worker.js'),
  )
  return current
}
async function wordStore() {
  const captured = generation
  await waitForClose(captured)
  if (captured !== generation) throw new Error('Dictionary packs are closed.')
  words ??= new CustomWordStore(
    join(app.getAppPath(), 'out/main/dictionary-custom-words-worker.js'),
    app.getPath('userData'),
  )
  return words
}
function closeStores() {
  const packs = current
  const customWords = words
  closing = Promise.all([
    closing.catch(() => {}),
    packs?.close(),
    customWords?.close(),
  ]).then(
    () => {
      if (current === packs) current = undefined
      if (words === customWords) words = undefined
      closeFailures = 0
    },
    (error) => {
      // Open-driven retries back off from 1 s, doubling to 30 s; stop and quit always try.
      retryAfter = Date.now() + Math.min(30_000, 1000 * 2 ** closeFailures++)
      throw error
    },
  )
  return closing
}
function stop() {
  generation++
  return closeStores()
}
app.on('before-quit', () => {
  void stop().catch((error) =>
    console.error('could not close dictionary packs:', error),
  )
})

const wordQueries = {
  customWords: async (input: unknown) =>
    (await wordStore()).request('page', input),
  customWordsMetadata: async () => (await wordStore()).request('metadata'),
  customWordsGet: async (input: unknown) =>
    (await wordStore()).request('get', input),
  customWordsLookup: async (input: unknown) =>
    (await wordStore()).request('lookup', input),
  customWordsComplete: async (input: unknown) =>
    (await wordStore()).request('complete', input),
}

export default {
  id: manifest.id,
  stop,
  queries: {
    ...wordQueries,
    packs: async () => (await store()).list(),
    async packComplete(input) {
      if (!input || typeof input !== 'object')
        throw new Error('Invalid dictionary completion')
      const { id, prefix, limit } = input as Record<string, unknown>
      return (await store()).complete(
        packId(id),
        completionPrefix(prefix),
        completionLimit(limit),
      )
    },
    async packCompleteAll(input) {
      if (!input || typeof input !== 'object')
        throw new Error('Invalid dictionary completion')
      const { ids, prefix, limit } = input as Record<string, unknown>
      return (await store()).completeAll(
        ids,
        completionPrefix(prefix),
        completionLimit(limit),
      )
    },
    packInstalled: async (input) => (await store()).installed(input),
    async packLookup(input) {
      const { id, word } = lookupInput(input)
      return (await store()).lookup(id, word)
    },
  },
  profileMethods: {
    ...wordQueries,
    changeCustomWords: async (input, context) =>
      (await wordStore()).request('change', input, context.isCurrent),
  },
  methods: {
    async copyCustomWords(input) {
      if (
        typeof input !== 'string' ||
        Buffer.byteLength(input) > HOST_SELECTED_IO_MAX_BYTES
      )
        throw new TypeError('Invalid custom words text')
      return clipboard.writeText(input)
    },
    installPack: async (input) => (await store()).install(input),
    cancelPack: async (input) => (await store()).cancel(input),
    uninstallPack: async (input) => (await store()).uninstall(input),
  },
} satisfies NativeAddon
