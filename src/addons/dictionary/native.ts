import { join } from 'node:path'
import { app, clipboard } from 'electron'
import { HOST_SELECTED_IO_MAX_BYTES } from '../../shared/host-selected-io'
import type { NativeAddon } from '../api'
import manifest from './manifest'
import { completionLimit, completionPrefix } from './pack-runtime'
import { PackStore } from './pack-store'
import { lookupInput, packId } from './packs'

let current: PackStore | undefined
let closing = Promise.resolve()
let generation = 0
async function store() {
  const captured = generation
  await closing
  if (captured !== generation) throw new Error('Dictionary packs are closed.')
  current ??= new PackStore(
    join(app.getPath('userData'), 'dictionary-packs'),
    join(app.getAppPath(), 'out/main/dictionary-pack-worker.js'),
  )
  return current
}
function stop() {
  generation++
  if (!current) return
  closing = current
    .close()
    .catch((error) => console.error('could not close dictionary packs:', error))
  current = undefined
}
app.on('before-quit', stop)

export default {
  id: manifest.id,
  stop,
  queries: {
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
  methods: {
    async copyCustomWords(input) {
      // A valid 5,000-word export fits this character bound, including its notes.
      if (
        typeof input !== 'string' ||
        input.length > HOST_SELECTED_IO_MAX_BYTES
      )
        throw new TypeError('Invalid custom words text')
      return clipboard.writeText(input)
    },
    installPack: async (input) => (await store()).install(input),
    cancelPack: async (input) => (await store()).cancel(input),
    uninstallPack: async (input) => (await store()).uninstall(input),
  },
} satisfies NativeAddon
