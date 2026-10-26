import type { AddonStorageHandle } from '../../shared/addon-storage'
import type { AddonContext } from '../api'
import { type CustomWord, customWords } from './custom-word-data.ts'

const encoder = new TextEncoder()
type Page = {
  revision: number
  words: CustomWord[]
  after: number
  more: boolean
}
export type CustomWordStorage = AddonStorageHandle<unknown> & {
  close?: () => void
  normalized?: true
}

/** Adapts indexed native records to the dictionary's existing compare-and-set flow. */
export async function openCustomWordStorage(
  native: AddonContext['native'],
  write: AddonContext['native']['invoke'] = native.invoke,
): Promise<CustomWordStorage> {
  let state = {
    status: 'ready' as const,
    revision: 0,
    value: [] as CustomWord[],
  }
  const listeners = new Set<() => void>()
  const channel = new BroadcastChannel('hibi-dictionary-custom-words')
  let closed = false
  let refreshing: Promise<void> = Promise.resolve()
  const load = () => {
    const run = refreshing
      .catch(() => {})
      .then(async () => {
        let after = 0
        let revision: number | undefined
        const words: CustomWord[] = []
        for (;;) {
          const page = await native.query<Page>('customWords', {
            after,
            ...(revision === undefined ? {} : { revision }),
          })
          revision = page.revision
          const normalized = customWords(page.words)
          if (normalized.length !== page.words.length)
            throw new Error(
              'Could not read your custom words. The original data has been kept.',
            )
          words.push(...normalized)
          if (!page.more) break
          after = page.after
        }
        if (closed || revision < state.revision) return
        state = { status: 'ready', revision, value: words }
        for (const listener of listeners) listener()
      })
    refreshing = run
    return run
  }
  channel.onmessage = () => {
    void load().catch((error) =>
      console.error('could not refresh custom words:', error),
    )
  }
  try {
    await load()
  } catch (error) {
    channel.close()
    throw error
  }
  return {
    normalized: true,
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close() {
      closed = true
      channel.close()
      listeners.clear()
    },
    async set(value) {
      if (closed || !Array.isArray(value))
        return { status: 'unavailable', reason: 'stale-activation' }
      const base = state
      const old = new Map(base.value.map((word) => [word.id, word]))
      const next = value as CustomWord[]
      const upsert = next.filter((word) => {
        const saved = old.get(word.id)
        old.delete(word.id)
        return (
          !saved ||
          saved.word !== word.word ||
          saved.lang !== word.lang ||
          saved.note !== word.note
        )
      })
      const remove = [...old.keys()]
      if (!upsert.length && !remove.length)
        return { status: 'saved', revision: base.revision, value: base.value }
      let token: string | undefined
      try {
        const transaction = await write<{ token: string }>(
          'changeCustomWords',
          { type: 'begin', revision: base.revision },
        )
        token = transaction.token
        let batch: CustomWord[] = []
        let bytes = 0
        const stage = async () => {
          if (closed)
            throw new Error(
              'Turn on Dictionary and thesaurus to keep custom words.',
            )
          if (batch.length)
            await write('changeCustomWords', {
              type: 'stage',
              token,
              upsert: batch,
              remove: [],
            })
          batch = []
          bytes = 0
        }
        for (const word of upsert) {
          const size = encoder.encode(JSON.stringify(word)).length
          if (
            batch.length &&
            (batch.length === 256 || bytes + size > 1024 * 1024)
          )
            await stage()
          batch.push(word)
          bytes += size
        }
        await stage()
        for (let offset = 0; offset < remove.length; offset += 256)
          await write('changeCustomWords', {
            type: 'stage',
            token,
            upsert: [],
            remove: remove.slice(offset, offset + 256),
          })
        if (closed)
          throw new Error(
            'Turn on Dictionary and thesaurus to keep custom words.',
          )
        const { revision } = await write<{ revision: number }>(
          'changeCustomWords',
          { type: 'commit', token },
        )
        token = undefined
        if (!closed && revision >= state.revision) {
          state = { status: 'ready', revision, value: next }
          for (const listener of listeners) listener()
        }
        if (!closed) channel.postMessage(revision)
        return { status: 'saved', revision, value: next }
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes('Custom words changed in another window.')
        ) {
          await load()
          return { status: 'conflict', current: state }
        }
        if (
          error instanceof Error &&
          error.message.includes('storage request size.')
        )
          throw new Error('This custom word exceeds the storage request size.')
        throw new Error('Could not save custom words.')
      } finally {
        if (token)
          await write('changeCustomWords', { type: 'abort', token }).catch(
            () => {},
          )
      }
    },
  }
}
