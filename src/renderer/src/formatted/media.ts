import type { EditorState } from '@codemirror/state'
import {
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view'
import type { SyntaxNodeRef } from '@lezer/common'
import { decodeHTMLStrict } from 'entities'
import type { DocumentMedia } from '../../../shared/media.ts'
import {
  isMenuKey,
  menuImage,
  observeDocumentMedia,
  remoteImageMenu,
  remoteImageSource,
} from '../document-media.ts'
import { documentRuntime } from '../document-runtime.ts'
import type { EditorActionsRequest } from '../editor-interactions'
import {
  type FormattedContribution,
  formattedDocument,
  formattedSyntaxTree,
} from '../formatted-contributions.ts'
import './media.css'

const decode = (text: string) =>
  text
    .replace(/\\([!-/:-@[-`{-~])/g, '$1')
    .replace(
      /&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]+);/g,
      (entity) => decodeHTMLStrict(entity),
    )

/** An image's source path, description and title; reference images have none. */
export function imageOf(state: EditorState, node: SyntaxNodeRef) {
  const url = node.node.getChild('URL')
  const close = node.node
    .getChildren('LinkMark')
    .find((mark) => state.sliceDoc(mark.from, mark.to) === ']')
  if (!url || !close) return null
  let source = state.sliceDoc(url.from, url.to)
  if (source.startsWith('<') && source.endsWith('>'))
    source = source.slice(1, -1)
  const title = node.node.getChild('LinkTitle')
  // Line breaks in a description or title read as spaces, as in the rich editor.
  const text = (from: number, to: number) =>
    decode(state.sliceDoc(from, to)).replace(/[ \t]*\n[ \t]*/g, ' ')
  return {
    source: source.replace(/\\([!-/:-@[-`{-~])/g, '$1'),
    alt: text(node.from + 2, close.from),
    title: title ? text(title.from + 1, title.to - 1) : '',
    label: { from: node.from + 2, to: close.from },
  }
}

/**
 * Loaded remote images each open tab has drawn, most recent last. The image
 * cache answers with `no-store`, so a widget drawn again after scrolling back
 * or switching tabs would wait for its image to load again; while the page
 * holds the loaded one, it is drawn at once, in shape. A tab lets go of its
 * images when it closes.
 */
const held = new Map<string, Map<string, HTMLImageElement>>()
/** At most this many per tab, so a note full of remote images stays bounded. */
const HELD_PER_TAB = 200
let watching = false

/** Holds a destroyed widget's loaded remote image for its tab; false if it is not one. */
function hold(view: EditorView, media: Element) {
  const { tabId } = view.state.facet(formattedDocument)
  if (
    !tabId ||
    // A closing tab's view is destroyed after the runtime drops its session.
    !documentRuntime.session(tabId) ||
    !(media instanceof HTMLImageElement) ||
    // A lazy image kept waiting off screen is not complete, but it is sized
    // once a copy loaded for an earlier widget arrives.
    !media.naturalWidth ||
    !remoteImageSource(media)
  )
    return false
  if (!watching) {
    watching = true
    // The runtime drops a closed tab's session, and its images go with it.
    documentRuntime.subscribeCatalog(() => {
      for (const [id, images] of held)
        if (!documentRuntime.session(id)) {
          // One still loading would stay alive, and keep loading, until its
          // load ends.
          for (const image of images.values()) if (!image.complete) clear(image)
          held.delete(id)
        }
    })
  }
  let images = held.get(tabId)
  if (!images) {
    images = new Map()
    held.set(tabId, images)
  }
  // Out of its widget, the image keeps no destroyed view's DOM alive.
  media.remove()
  const previous = images.get(media.src)
  if (previous && previous !== media && !previous.complete) clear(previous)
  images.delete(media.src)
  images.set(media.src, media)
  const [oldest = ''] = images.keys()
  if (images.size > HELD_PER_TAB) {
    const evicted = images.get(oldest)
    images.delete(oldest)
    if (evicted && !evicted.complete) clear(evicted)
  }
  return true
}

/** A drawn widget's media resolution, rebound when the note's revision changes. */
type Binding = { bind(revision: number): void; release(): void }
const drawn = new WeakMap<EditorView, Set<Binding>>()
const bindings = new WeakMap<
  HTMLElement,
  { binding: Binding; view: EditorView }
>()

/**
 * An image or video from the note's source, resolved like the rich editor's
 * media for the view's document revision. Only widgets in view are drawn, so
 * only they resolve media.
 */
export class MediaWidget extends WidgetType {
  readonly source: string
  readonly alt: string
  readonly title: string
  /** Size in pixels from the note, such as an `<img>` tag's; 0 keeps the media's own. */
  readonly width: number
  readonly height: number
  constructor(
    source: string,
    alt: string,
    title: string,
    width = 0,
    height = 0,
  ) {
    super()
    this.source = source
    this.alt = alt
    this.title = title
    this.width = width
    this.height = height
  }
  override eq(other: MediaWidget) {
    return (
      other.source === this.source &&
      other.alt === this.alt &&
      other.title === this.title &&
      other.width === this.width &&
      other.height === this.height
    )
  }
  toDOM(view: EditorView) {
    const container = document.createElement('span')
    container.className = 'document-media'
    let media: HTMLImageElement | HTMLVideoElement =
      document.createElement('img')
    container.append(media)
    const render = (result: DocumentMedia | null) => {
      if ((result?.kind === 'video') !== media instanceof HTMLVideoElement) {
        clear(media)
        media = document.createElement(
          result?.kind === 'video' ? 'video' : 'img',
        )
        container.replaceChildren(media)
      }
      media.title = this.title
      if (this.width) media.width = this.width
      if (this.height) media.height = this.height
      // A column narrower than the width scales the height with it.
      if (this.width && this.height) keepShape(media, this.width, this.height)
      delete media.dataset.tooltip
      if (media instanceof HTMLVideoElement) {
        media.controls = true
        media.preload = 'metadata'
        media.setAttribute('aria-label', this.alt || 'Video attachment')
      } else {
        media.alt = this.alt
        media.loading = 'lazy'
        media.decoding = 'async'
      }
      if (result) {
        if (media.getAttribute('src') !== result.url) media.src = result.url
      } else {
        media.removeAttribute('src')
        media.removeAttribute('title')
        media.dataset.tooltip =
          'Could not load this media. Check the file path. Save the note first if the path is relative to it.'
      }
      // A height alone takes its width from the image's own shape before the
      // image is drawn stretched: at once for an image already in memory, else
      // as soon as its size reaches its box, and again when a new source loads.
      if (!this.width && this.height && media instanceof HTMLImageElement) {
        media.onload = fitLoaded
        if (!(media.complete && fitHeight(media))) {
          sizing ??= new ResizeObserver(fitResized)
          sizing.observe(media)
        }
      }
    }
    let release: (() => void) | null = null
    const binding: Binding = {
      bind: (revision) => {
        // The new resolution starts before the old one is let go.
        const previous = release
        release = observeDocumentMedia(
          this.source,
          revision,
          render,
          view.state.facet(formattedDocument).tabId,
        )
        previous?.()
      },
      release: () => {
        release?.()
        release = null
      },
    }
    binding.bind(view.state.facet(formattedDocument).revision)
    let views = drawn.get(view)
    if (!views) {
      views = new Set()
      drawn.set(view, views)
    }
    views.add(binding)
    bindings.set(container, { binding, view })
    return container
  }
  override destroy(dom: HTMLElement) {
    const media = dom.firstElementChild
    const entry = bindings.get(dom)
    if (media instanceof HTMLElement && !(entry && hold(entry.view, media)))
      clear(media)
    if (!entry) return
    drawn.get(entry.view)?.delete(entry.binding)
    // A replacement widget in the same update reuses the resolved media.
    queueMicrotask(entry.binding.release)
  }
  /** Video controls keep their events; clicks on images place the caret. */
  override ignoreEvent(event: Event) {
    return event.target instanceof Element && !!event.target.closest('video')
  }
}

/** Sizes media to `width` with this shape, so a narrower column scales its height too. */
function keepShape(
  media: HTMLImageElement | HTMLVideoElement,
  width: number,
  height: number,
) {
  media.width = width
  media.style.aspectRatio = `${width} / ${height}`
  media.style.height = 'auto'
}

/** Images with only a height wait here until their size is known. */
let sizing: ResizeObserver | undefined

/** Gives an image with only a height its own shape's width; false until that shape is known. */
function fitHeight(image: HTMLImageElement) {
  if (!image.naturalWidth || !image.naturalHeight) return false
  const height = Number(image.getAttribute('height'))
  keepShape(
    image,
    Math.round((height * image.naturalWidth) / image.naturalHeight),
    height,
  )
  sizing?.unobserve(image)
  return true
}

// Shared handlers, so an image keeps no widget's DOM or view alive.
const fitLoaded = ({ target }: Event) => {
  if (target instanceof HTMLImageElement) fitHeight(target)
}
const fitResized = (entries: ResizeObserverEntry[]) => {
  for (const { target } of entries)
    if (target instanceof HTMLImageElement) fitHeight(target)
}

function clear(media: Element) {
  sizing?.unobserve(media)
  media.removeAttribute('src')
  if (media instanceof HTMLVideoElement) {
    media.pause()
    media.load()
  }
}

/** Drawn media follow a new document revision or tab without being drawn again. */
const revisions = ViewPlugin.fromClass(
  class {
    update(update: ViewUpdate) {
      const { revision, tabId } = update.state.facet(formattedDocument)
      const previous = update.startState.facet(formattedDocument)
      if (revision === previous.revision && tabId === previous.tabId) return
      for (const binding of drawn.get(update.view) ?? []) binding.bind(revision)
    }
  },
)

/** The drawn remote image of the image whose source holds the selection, or null. */
function selectedRemoteImage(view: EditorView) {
  const tree = formattedSyntaxTree(view.state)
  const { head } = view.state.selection.main
  for (const side of [-1, 1] as const)
    for (
      let node = tree?.resolveInner(head, side) ?? null;
      node;
      node = node.parent
    ) {
      if (node.name !== 'Image' && node.name !== 'HTMLImage') continue
      for (const image of view.contentDOM.querySelectorAll('img')) {
        const at = view.posAtDOM(image)
        if (at >= node.from && at <= node.to && remoteImageSource(image))
          return image
      }
      break
    }
  return null
}

/**
 * Right-clicking a remote image, or Shift+F10 or the menu key with the
 * selection in one, offers to fetch it again, first among the editor's actions.
 */
const refreshMenu = ViewPlugin.fromClass(
  class {
    view: EditorView
    constructor(view: EditorView) {
      this.view = view
      view.dom.addEventListener('contextmenu', this.context, true)
      view.dom.addEventListener('keydown', this.key, true)
    }
    context = (event: MouseEvent) => {
      // The menu key's event comes from no button; its menu opens at the selection.
      if (event.button < 0) this.atSelection(event)
      else {
        const image = menuImage(event)
        if (image) this.open(event, image, event.clientX, event.clientY)
      }
    }
    key = (event: KeyboardEvent) => {
      if (isMenuKey(event)) this.atSelection(event)
    }
    /** Opens the actions of the remote image holding the selection, below it. */
    atSelection(event: Event) {
      const image = selectedRemoteImage(this.view)
      const caret =
        image && this.view.coordsAtPos(this.view.state.selection.main.head)
      if (image && caret) this.open(event, image, caret.left, caret.bottom + 6)
    }
    open(event: Event, image: HTMLImageElement, x: number, y: number) {
      const menu = remoteImageMenu(image, { x, y })
      if (!menu) return
      event.preventDefault()
      event.stopImmediatePropagation()
      const request = new CustomEvent<EditorActionsRequest>(
        'hibi:editor-actions-request',
        {
          cancelable: true,
          detail: {
            position: this.view.posAtDOM(image),
            x,
            y,
            items: menu.items,
          },
        },
      )
      if (this.view.contentDOM.dispatchEvent(request)) menu.open()
    }
    destroy() {
      this.view.dom.removeEventListener('contextmenu', this.context, true)
      this.view.dom.removeEventListener('keydown', this.key, true)
    }
  },
)

const marker = { class: 'hibi-lp-marker' }

/**
 * `![description](path)` shows the image or video, also when its source
 * spans lines; its source shows beside it while revealed.
 */
export const contribution: FormattedContribution = {
  id: 'core.images',
  feature: 'core.images',
  extension: [revisions, refreshMenu],
  views: [
    {
      nodes: ['Image'],
      layout(node, out, { state, revealed }) {
        const image = imageOf(state, node)
        if (!image) return false
        const widget = new MediaWidget(image.source, image.alt, image.title)
        if (revealed) out.widget(node.to, widget, { side: 1 })
        else out.replace(node.from, node.to, widget)
        return false
      },
      decorate(node, out, { state, revealed }) {
        const image = imageOf(state, node)
        if (!revealed || !image) return false
        out.mark(node.from, image.label.from, marker)
        out.mark(image.label.to, node.to, marker)
        return false
      },
    },
  ],
}
