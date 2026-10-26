import { type DocumentMedia, mediaPathsChanged } from '../../shared/media.ts'

type Entry = {
  source: string
  revision: number
  paths: string[] | null
  generation: number
  request: string | null
  listeners: Set<(media: DocumentMedia | null) => void>
  media?: DocumentMedia | null
}
const entries = new Map<string, Entry>()
let unsubscribe: (() => void) | undefined
let unsubscribeScope: (() => void) | undefined

function resolve(entry: Entry) {
  const generation = ++entry.generation
  // A node removed in the same update must never start native I/O.
  queueMicrotask(() => {
    if (!entry.listeners.size || generation !== entry.generation) return
    const previous = entry.request
    const request = crypto.randomUUID()
    entry.request = request
    const result = window.hibi.resolveDocumentMedia(
      entry.source,
      entry.revision,
      request,
    )
    // Acquire the replacement lease before releasing an open stream's token.
    if (previous) void window.hibi.cancelDocumentMedia(previous).catch(() => {})
    void result
      .catch(() => null)
      .then((result) => {
        if (!entry.listeners.size || generation !== entry.generation) return
        entry.paths = result?.paths ?? null
        const media = result?.media ?? null
        const changed =
          entry.media === undefined ||
          entry.media?.url !== media?.url ||
          entry.media?.kind !== media?.kind
        entry.media = media
        if (changed) for (const listener of entry.listeners) listener(media)
      })
  })
}

/** Share display resolution and one path-filtered workspace subscription across media views. */
export function observeDocumentMedia(
  source: string,
  revision: number,
  listener: (media: DocumentMedia | null) => void,
) {
  if (/^data:image\/(png|jpeg|gif|webp|avif|svg\+xml);base64,/i.test(source)) {
    listener({ kind: 'image', url: source })
    return () => {}
  }
  const key = JSON.stringify([source, revision])
  let entry = entries.get(key)
  if (!entry) {
    entry = {
      source,
      revision,
      paths: null,
      generation: 0,
      request: null,
      listeners: new Set(),
    }
    entries.set(key, entry)
  }
  entry.listeners.add(listener)
  if (!unsubscribe)
    unsubscribe = window.hibi.onWorkspaceHeaderChanged((change) => {
      for (const entry of entries.values())
        if (mediaPathsChanged(entry.paths, change)) resolve(entry)
    })
  if (!unsubscribeScope)
    unsubscribeScope = window.hibi.onDocumentMediaScopeChanged((revision) => {
      for (const entry of entries.values()) {
        if (entry.revision !== revision) continue
        delete entry.media
        resolve(entry)
      }
    })
  if ('media' in entry) listener(entry.media ?? null)
  else if (entry.listeners.size === 1) resolve(entry)
  return () => {
    entry.listeners.delete(listener)
    if (entry.listeners.size) return
    entry.generation++
    if (entry.request)
      void window.hibi.cancelDocumentMedia(entry.request).catch(() => {})
    entries.delete(key)
    if (!entries.size) {
      unsubscribe?.()
      unsubscribe = undefined
      unsubscribeScope?.()
      unsubscribeScope = undefined
    }
  }
}
