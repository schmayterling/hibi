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

// Another origin than the app's: the page shows these images but, as with
// images from any other site, its scripts can't read them.
const REMOTE_IMAGE = 'app://remote-image/?'
/** Refreshed remote images, which take a new address so the page draws the new copy. */
const refreshes = new Map<string, number>()

/**
 * The address the main process serves a remote image at, from the image cache
 * of the note open in tab `tab`.
 */
export const remoteImageUrl = (source: string, tab: string | null) =>
  `${REMOTE_IMAGE}src=${encodeURIComponent(source)}${tab ? `&tab=${encodeURIComponent(tab)}` : ''}${refreshes.has(source) ? `&refresh=${refreshes.get(source)}` : ''}`

/** The remote source an image shows, or null for any other image. */
export const remoteImageSource = (image: HTMLImageElement) =>
  image.src.startsWith(REMOTE_IMAGE)
    ? new URL(image.src).searchParams.get('src')
    : null

const remoteImageTab = (image: HTMLImageElement) =>
  new URL(image.src).searchParams.get('tab')

/** Fetches a remote image again now, then draws the new copy wherever it shows. */
async function refreshRemoteImage(source: string, tab: string | null) {
  await window.hibi.refreshRemoteImage(source, tab)
  refreshes.set(source, (refreshes.get(source) ?? 0) + 1)
  for (const image of document.images)
    if (remoteImageSource(image) === source)
      image.src = remoteImageUrl(source, remoteImageTab(image))
}

/** Sanitized HTML ready to show in tab `tab`, its remote images drawn from the image cache. */
export function withCachedImages(html: string, tab: string) {
  const template = document.createElement('template')
  template.innerHTML = html
  for (const image of template.content.querySelectorAll('img')) {
    const source = image.getAttribute('src') ?? ''
    if (!/^https:\/\//i.test(source)) continue
    image.src = remoteImageUrl(source, tab)
    // The cache refuses loads that ask for CORS; a plain load draws the same.
    image.removeAttribute('crossorigin')
    // Focus lets the keyboard open the image's menu; a focused image needs a
    // name, so one without a description takes its file's.
    image.tabIndex = 0
    if (!image.alt) image.setAttribute('aria-label', imageName(source))
  }
  return template.content
}

function imageName(source: string) {
  try {
    const file = new URL(source).pathname.split('/').filter(Boolean).at(-1)
    return decodeURIComponent(file ?? '') || 'Image'
  } catch {
    return 'Image'
  }
}

const imageMenu = menus.scope(() => {})

/** A remote image's actions, or null for any other image. */
export function remoteImageMenu(
  image: HTMLImageElement,
  anchor: { x: number; y: number },
) {
  const source = remoteImageSource(image)
  if (!source) return null
  const tab = remoteImageTab(image)
  const items: MenuItem[] = [
    {
      id: 'refresh-image',
      label: 'Refresh image',
      onSelect: () => refreshRemoteImage(source, tab),
    },
  ]
  return {
    items,
    /** Shows the actions in a menu of their own at `anchor`. */
    open: () => imageMenu.api.open({ label: 'Image actions', anchor, items }),
  }
}

/**
 * The image a right-click or the keyboard's menu key is on, or null for any
 * other target. Control-Command-click follows links instead.
 */
export const menuImage = (event: MouseEvent) =>
  event.target instanceof HTMLImageElement && !(event.ctrlKey && event.metaKey)
    ? event.target
    : null

/** Shift+F10, which opens a context menu from the keyboard, as the menu key does. */
export const isMenuKey = (event: KeyboardEvent) =>
  event.key === 'F10' &&
  event.shiftKey &&
  !event.altKey &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.isComposing

/**
 * Right-clicking a remote image in a preview, or Shift+F10 or the menu key
 * on one with focus, offers to fetch it again.
 */
export function openRemoteImageMenu(event: MouseEvent | KeyboardEvent) {
  const image =
    event instanceof KeyboardEvent
      ? isMenuKey(event) && event.target instanceof HTMLImageElement
        ? event.target
        : null
      : menuImage(event)
  if (!image) return
  const box = image.getBoundingClientRect()
  // From the keyboard, whose menu key's event comes from no button, the menu
  // opens below the image.
  const menu = remoteImageMenu(
    image,
    event instanceof KeyboardEvent || event.button < 0
      ? { x: box.left, y: box.bottom }
      : { x: event.clientX, y: event.clientY },
  )
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

/**
 * Share display resolution and one path-filtered workspace subscription across
 * media views. Remote images come from the image cache of the note in `tab`.
 */
export function observeDocumentMedia(
  source: string,
  revision: number,
  listener: (media: DocumentMedia | null) => void,
  tab: string | null = null,
) {
  if (
    /^data:image\/(png|jpeg|gif|webp|avif|svg\+xml);base64,/i.test(source) ||
    /^https:\/\//i.test(source)
  ) {
    listener({
      kind: 'image',
      url: /^https:/i.test(source) ? remoteImageUrl(source, tab) : source,
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
