import type { AddonContext } from '../api'
import {
  type CustomWord,
  customWordKey,
  customWords,
} from './custom-word-data.ts'

export type WordMetadata = { revision: number; count: number; notice?: string }
export type WordPage = {
  revision: number
  words: CustomWord[]
  after: number
  more: boolean
}
export type WordRange = { from: number; to: number }
type Stage = {
  upsert?: readonly CustomWord[]
  remove?: readonly string[]
  merge?: boolean
  keepNote?: boolean
  first?: boolean
}
type Commit = WordMetadata & { changed: number }
const encoder = new TextEncoder()
const conflict = (error: unknown) =>
  error instanceof Error &&
  error.message.includes('Custom words changed in another window.')
const unavailable = () =>
  new Error('Turn on Dictionary and thesaurus to keep custom words.')

/** A bounded viewport cache; the full dictionary stays in the native index. */
export class IndexedCustomWords {
  readonly kind = 'indexed'
  private state: WordMetadata & { version: number } = {
    revision: 0,
    count: 0,
    version: 0,
  }
  private rows = new Map<number, CustomWord>()
  private loaded = new Set<number>()
  private indices = new Map<string, number>()
  private listeners = new Set<() => void>()
  private channel = new BroadcastChannel('hibi-dictionary-custom-words')
  private closed = false
  private loading = 0
  private token: string | undefined
  private call: AddonContext['native']['invoke']
  constructor(call: AddonContext['native']['invoke']) {
    this.call = call
    this.channel.onmessage = () => {
      void this.refresh().catch(() => {})
    }
  }
  snapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  at = (index: number) => this.rows.get(index)
  indexOf = (id: string | undefined) =>
    id === undefined ? undefined : this.indices.get(id)
  private publish(metadata: WordMetadata = this.state) {
    if (this.closed) return
    this.state = { ...metadata, version: this.state.version + 1 }
    for (const listener of this.listeners) listener()
  }
  private reindex() {
    this.indices.clear()
    for (const [index, word] of this.rows)
      if (word.id) this.indices.set(word.id, index)
  }
  async refresh() {
    const metadata = await this.call<WordMetadata>('customWordsMetadata')
    if (this.closed || metadata.revision < this.state.revision) return
    if (metadata.revision !== this.state.revision) {
      this.loading++
      // Keep mounted rows until their replacements arrive, preserving browser Tab order.
      this.loaded.clear()
      for (const index of this.rows.keys())
        if (index >= metadata.count) this.rows.delete(index)
      this.reindex()
    }
    this.publish(metadata)
  }
  async dismissNotice() {
    if (this.closed) throw unavailable()
    await this.call('changeCustomWords', { type: 'dismissNotice' })
    await this.refresh()
    this.channel.postMessage(this.state.revision)
  }
  async get(id: string) {
    if (this.closed) throw unavailable()
    return this.call<{ revision: number; word: CustomWord | null }>(
      'customWordsGet',
      { id },
    )
  }
  async page(input: { after?: number; offset?: number; revision?: number }) {
    if (this.closed) throw unavailable()
    const page = await this.call<WordPage>('customWords', input)
    const words = customWords(page.words)
    if (words.length !== page.words.length)
      throw new Error(
        'Could not read your custom words. The original data has been kept.',
      )
    return { ...page, words }
  }
  async ensure(ranges: readonly WordRange[]) {
    const loading = ++this.loading
    const revision = this.state.revision
    // Keep the visible rows and focus neighbors, plus one native page on either side.
    for (const index of this.rows.keys())
      if (
        !ranges.some(({ from, to }) => index >= from - 256 && index < to + 256)
      ) {
        this.rows.delete(index)
        this.loaded.delete(index)
      }
    this.reindex()
    try {
      for (const { from, to } of ranges) {
        for (
          let index = Math.max(0, from);
          index < Math.min(to, this.state.count);
        ) {
          if (this.loaded.has(index)) {
            index++
            continue
          }
          const page = await this.page({ offset: index, revision })
          if (this.closed || loading !== this.loading) return
          if (!page.words.length) break
          for (const word of page.words) {
            this.rows.set(index, word)
            this.loaded.add(index++)
          }
          this.reindex()
          this.publish()
        }
      }
    } catch (error) {
      if (this.closed || loading !== this.loading) return
      if (conflict(error)) await this.refresh()
      else
        this.publish({
          ...this.state,
          notice:
            error instanceof Error
              ? error.message
              : 'Could not save custom words.',
        })
    }
  }
  async change(
    produce: (stage: (batch: Stage) => Promise<void>) => Promise<void>,
    options: { revision?: number; put?: CustomWord; remove?: string } = {},
  ): Promise<Commit> {
    if (this.closed) throw unavailable()
    let token: string | undefined
    let staged = 0
    let mergedRows: Map<string, number> | undefined
    let retainRows = true
    const changedRows = new Map<number, CustomWord>()
    try {
      const revision = options.revision ?? this.state.revision
      if (revision !== this.state.revision) await this.refresh()
      token = (
        await this.call<{ token: string }>('changeCustomWords', {
          type: 'begin',
          revision,
        })
      ).token
      this.token = token
      await produce(async ({ upsert = [], remove = [], ...flags }) => {
        let batch: CustomWord[] = []
        let bytes = 0
        const send = async (removed: readonly string[] = []) => {
          if (this.closed) throw unavailable()
          if (!batch.length && !removed.length) return
          const result = await this.call<{ count: number }>(
            'changeCustomWords',
            { type: 'stage', token, upsert: batch, remove: removed, ...flags },
          )
          staged = result.count
          if (!flags.merge || removed.length) retainRows = false
          if (flags.merge) {
            mergedRows ??= new Map(
              [...this.rows].map(([index, word]) => [
                customWordKey(word),
                index,
              ]),
            )
            for (const word of batch) {
              const index = mergedRows.get(customWordKey(word))
              if (
                index === undefined ||
                (flags.first && changedRows.has(index))
              )
                continue
              const previous = changedRows.get(index) ?? this.rows.get(index)
              const [next] = customWords([
                {
                  ...word,
                  id: previous?.id,
                  ...(flags.keepNote &&
                  word.note === undefined &&
                  previous?.note
                    ? { note: previous.note }
                    : {}),
                },
              ])
              if (next) changedRows.set(index, next)
            }
          }
          batch = []
          bytes = 0
        }
        for (const word of upsert) {
          const size = encoder.encode(JSON.stringify(word)).length
          if (
            batch.length &&
            (batch.length === 256 || bytes + size > 1024 * 1024)
          )
            await send()
          batch.push(word)
          bytes += size
        }
        await send()
        for (let offset = 0; offset < remove.length; offset += 256)
          await send(remove.slice(offset, offset + 256))
      })
      if (this.closed) throw unavailable()
      if (!staged) return { ...this.state, changed: 0 }
      const result = await this.call<Commit>('changeCustomWords', {
        type: 'commit',
        token,
      })
      token = undefined
      this.token = undefined
      if (!this.closed && result.revision >= this.state.revision) {
        this.loading++
        if (options.put?.id) {
          const index = this.indices.get(options.put.id)
          if (index !== undefined) this.rows.set(index, options.put)
        } else if (options.remove) {
          const removed = this.indices.get(options.remove)
          if (removed === undefined) this.rows.clear()
          else {
            const rows = new Map<number, CustomWord>()
            for (const [index, word] of this.rows)
              if (index !== removed)
                rows.set(index > removed ? index - 1 : index, word)
            this.loaded = new Set(
              [...this.loaded].flatMap((index) =>
                index === removed ? [] : [index > removed ? index - 1 : index],
              ),
            )
            this.rows = rows
          }
        } else if (retainRows) {
          for (const [index, word] of changedRows) this.rows.set(index, word)
        } else this.rows.clear()
        for (const index of this.loaded)
          if (!this.rows.has(index)) this.loaded.delete(index)
        this.reindex()
        this.publish(result)
        this.channel.postMessage(result.revision)
      }
      return result
    } catch (error) {
      if (conflict(error)) {
        await this.refresh()
        throw new Error('Custom words changed in another window. Try again.')
      }
      if (
        error instanceof Error &&
        error.message.includes('This word already exists in that language.')
      )
        throw new Error('This word already exists in that language.')
      if (
        error instanceof Error &&
        error.message.includes('storage request size.')
      )
        throw new Error('This custom word exceeds the storage request size.')
      throw new Error('Could not save custom words.')
    } finally {
      if (token)
        await this.call('changeCustomWords', { type: 'abort', token }).catch(
          () => {},
        )
      if (this.token === token) this.token = undefined
    }
  }
  close() {
    this.closed = true
    this.loading++
    this.channel.close()
    this.rows.clear()
    this.loaded.clear()
    this.indices.clear()
    this.listeners.clear()
    if (this.token)
      void this.call('changeCustomWords', {
        type: 'abort',
        token: this.token,
      }).catch(() => {})
  }
}

export async function openCustomWordStorage(
  native: AddonContext['native'],
  call: AddonContext['native']['invoke'] = native.invoke,
) {
  const store = new IndexedCustomWords(call)
  try {
    await store.refresh()
    return store
  } catch (error) {
    store.close()
    throw error
  }
}
