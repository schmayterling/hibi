import type { EditorState } from '@codemirror/state'
import { WidgetType } from '@codemirror/view'
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
  return {
    source: source.replace(/\\([!-/:-@[-`{-~])/g, '$1'),
    alt: decode(state.sliceDoc(node.from + 2, close.from)),
    title: title ? decode(state.sliceDoc(title.from + 1, title.to - 1)) : '',
    label: { from: node.from + 2, to: close.from },
  }
}

/** Display resolution kept for a widget DOM, released after its replacement subscribes. */
const releases = new WeakMap<HTMLElement, () => void>()

/**
 * An image or video from the note's source, resolved like the rich editor's
 * media for this document revision. Only widgets in view are drawn, so only
 * they resolve media.
 */
export class MediaWidget extends WidgetType {
  readonly source: string
  readonly alt: string
  readonly title: string
  readonly revision: number
  constructor(source: string, alt: string, title: string, revision: number) {
    super()
    this.source = source
    this.alt = alt
    this.title = title
    this.revision = revision
  }
  override eq(other: MediaWidget) {
    return (
      other.source === this.source &&
      other.alt === this.alt &&
      other.title === this.title &&
      other.revision === this.revision
    )
  }
  toDOM() {
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
    releases.set(
      container,
      observeDocumentMedia(this.source, this.revision, render),
    )
    return container
  }
  override destroy(dom: HTMLElement) {
    const media = dom.firstElementChild
    if (media instanceof HTMLElement) clear(media)
    // A replacement widget in the same update reuses the resolved media.
    const release = releases.get(dom)
    if (release) queueMicrotask(release)
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

/** `![description](path)` shows the image or video; its source shows beside it while revealed. */
export const contribution: FormattedContribution = {
  id: 'core.images',
  feature: 'core.images',
  views: [
    {
      nodes: ['Image'],
      decorate(node, out, { state, revealed }) {
        const image = imageOf(state, node)
        if (!image) return false
        const widget = new MediaWidget(
          image.source,
          image.alt,
          image.title,
          state.facet(formattedDocument).revision,
        )
        if (!revealed) {
          out.replace(node.from, node.to, widget)
          return false
        }
        out.syntax(node.from, image.label.from)
        out.syntax(image.label.to, node.to)
        out.widget(node.to, widget, 1)
        return false
      },
    },
  ],
}
