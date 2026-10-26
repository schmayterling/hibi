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
import { observeDocumentMedia } from '../document-media.ts'
import {
  type FormattedContribution,
  formattedDocument,
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
  constructor(source: string, alt: string, title: string) {
    super()
    this.source = source
    this.alt = alt
    this.title = title
  }
  override eq(other: MediaWidget) {
    return (
      other.source === this.source &&
      other.alt === this.alt &&
      other.title === this.title
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
    }
    let release: (() => void) | null = null
    const binding: Binding = {
      bind: (revision) => {
        // The new resolution starts before the old one is let go.
        const previous = release
        release = observeDocumentMedia(this.source, revision, render)
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
    if (media instanceof HTMLElement) clear(media)
    const entry = bindings.get(dom)
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

function clear(media: Element) {
  media.removeAttribute('src')
  if (media instanceof HTMLVideoElement) {
    media.pause()
    media.load()
  }
}

/** Drawn media follow a new document revision without being drawn again. */
const revisions = ViewPlugin.fromClass(
  class {
    update(update: ViewUpdate) {
      const { revision } = update.state.facet(formattedDocument)
      if (revision === update.startState.facet(formattedDocument).revision)
        return
      for (const binding of drawn.get(update.view) ?? []) binding.bind(revision)
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
  extension: revisions,
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
