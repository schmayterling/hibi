import { type DocumentMedia, mediaPathsChanged } from '../../shared/media.ts'
import { menus } from '../../ui/menu-store.ts'
import type { MenuItem } from '../../ui/menus'

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

const REMOTE_IMAGE = 'app://hibi/remote-image?'
/** Refreshed remote images, which take a new address so the page draws the new copy. */
const refreshes = new Map<string, number>()

/** The address the main process serves a remote image at, from the note's image cache. */
export const remoteImageUrl = (source: string) =>
  `${REMOTE_IMAGE}src=${encodeURIComponent(source)}${refreshes.has(source) ? `&refresh=${refreshes.get(source)}` : ''}`

/** The remote source an image shows, or null for any other image. */
export const remoteImageSource = (image: HTMLImageElement) =>
  image.src.startsWith(REMOTE_IMAGE)
    ? new URL(image.src).searchParams.get('src')
    : null

/** Fetches a remote image again now, then draws the new copy wherever it shows. */
async function refreshRemoteImage(source: string) {
  await window.hibi.refreshRemoteImage(source)
  refreshes.set(source, (refreshes.get(source) ?? 0) + 1)
  for (const image of document.images)
    if (remoteImageSource(image) === source) image.src = remoteImageUrl(source)
}

/** Sanitized HTML ready to show, its remote images drawn from the image cache. */
export function withCachedImages(html: string) {
  const template = document.createElement('template')
  template.innerHTML = html
  for (const image of template.content.querySelectorAll('img')) {
    const source = image.getAttribute('src') ?? ''
    if (/^https:\/\//i.test(source)) image.src = remoteImageUrl(source)
  }
  return template.content
}

const imageMenu = menus.scope(() => {})

/**
 * The remote image a right-click is on and its actions, or null for any other
 * target. Control-Command-click follows links instead.
 */
export function remoteImageMenu(event: MouseEvent) {
  const image = event.target instanceof HTMLImageElement ? event.target : null
  const source = image && remoteImageSource(image)
  if (!image || !source || (event.ctrlKey && event.metaKey)) return null
  const items: MenuItem[] = [
    {
      id: 'refresh-image',
      label: 'Refresh image',
      onSelect: () => refreshRemoteImage(source),
    },
  ]
  const anchor = { x: event.clientX, y: event.clientY }
  return {
    image,
    items,
    /** Shows the actions in a menu of their own at the pointer. */
    open: () => imageMenu.api.open({ label: 'Image actions', anchor, items }),
  }
}

/** Right-clicking a remote image in a preview offers to fetch it again. */
export function openRemoteImageMenu(event: MouseEvent) {
  const menu = remoteImageMenu(event)
  if (!menu) return
  event.preventDefault()
  menu.open()
}

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
  if (
    /^data:image\/(png|jpeg|gif|webp|avif|svg\+xml);base64,/i.test(source) ||
    /^https:\/\//i.test(source)
  ) {
    listener({
      kind: 'image',
      url: /^https:/i.test(source) ? remoteImageUrl(source) : source,
    })
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
