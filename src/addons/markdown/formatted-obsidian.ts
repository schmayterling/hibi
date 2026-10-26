import type { EditorState } from '@codemirror/state'
import { EditorView, WidgetType } from '@codemirror/view'
import { decodeHTMLStrict } from 'entities'
import { observeDocumentMedia } from '../../renderer/src/document-media.ts'
import {
  type FormattedContribution,
  type FormattedDecorations,
  formattedDocument,
  showMarkdownMarkers,
} from '../../renderer/src/formatted-contributions.ts'
import { obsidianSyntax, wikiParts } from './formatted-syntax.ts'

const image = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i

/** Embeds the formatted view drew, for viewport tests. */
export const embedRenders = { count: 0 }

// The references the rich view's text decodes (`decodeMarkdownEntities`).
const entity = /&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]+);/g

/** The characters an entity stands for, styled as the text around them. */
class CharactersWidget extends WidgetType {
  readonly text: string
  readonly className: string
  constructor(text: string, className: string) {
    super()
    this.text = text
    this.className = className
  }
  override eq(other: CharactersWidget) {
    return other.text === this.text && other.className === this.className
  }
  toDOM() {
    const span = document.createElement('span')
    // Marks end at replaced text, so the widget takes the mark's class itself.
    span.className = `${this.className} hibi-lp-entity`
    span.textContent = this.text
    return span
  }
  override ignoreEvent() {
    return false
  }
}

/** Entities in `[from, to)` show their characters, as the rich view's text does, and their source under the caret. */
function decodeEntities(
  state: EditorState,
  out: FormattedDecorations,
  from: number,
  to: number,
  revealed: boolean,
  className: string,
) {
  if (revealed) return
  for (const match of state.sliceDoc(from, to).matchAll(entity)) {
    const decoded = decodeHTMLStrict(match[0])
    if (decoded === match[0]) continue
    const at = from + match.index
    out.replace(
      at,
      at + match[0].length,
      new CharactersWidget(decoded, className),
    )
  }
}

/**
 * `![[…]]`: the rich view's embed markup, an image read through the document's
 * media, or a link to the embedded note.
 */
class EmbedWidget extends WidgetType {
  readonly target: string
  readonly label: string
  readonly revision: number
  /** The length of the embed's source. */
  readonly length: number
  constructor(target: string, label: string, revision: number, length: number) {
    super()
    this.target = target
    this.label = label
    this.revision = revision
    this.length = length
  }
  override eq(other: EmbedWidget) {
    return (
      other.target === this.target &&
      other.label === this.label &&
      other.revision === this.revision &&
      other.length === this.length
    )
  }
  toDOM(view: EditorView) {
    embedRenders.count++
    const dom = document.createElement('span')
    dom.className = 'obsidian-embed'
    widgets.set(dom, this)
    const file = this.target.split('#')[0] ?? ''
    if (!image.test(file)) {
      // A link without a destination of its own: clicks reach the editor,
      // which places the caret, or follows the embed on shift-click as it does
      // links. The formatted view's link styles are the rich view's link's.
      const link = document.createElement('a')
      link.className = 'hibi-lp-link'
      link.role = 'link'
      link.tabIndex = -1
      link.dataset.wikiEmbed = this.target
      link.textContent = this.label
      link.addEventListener('keydown', (event) => {
        const view = EditorView.findFromDOM(dom)
        if (!view) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          const box = dom.getBoundingClientRect()
          dom.dispatchEvent(
            new MouseEvent('click', {
              bubbles: true,
              cancelable: true,
              shiftKey: true,
              clientX: box.left + box.width / 2,
              clientY: box.top + box.height / 2,
            }),
          )
        } else if (['ArrowLeft', 'ArrowRight', 'Escape'].includes(event.key)) {
          // Arrow keys and Escape take the caret back beside the embed.
          event.preventDefault()
          const from = view.posAtDOM(dom)
          view.focus()
          view.dispatch({
            selection: {
              anchor: event.key === 'ArrowLeft' ? from : from + this.length,
            },
          })
        }
      })
      dom.append(link)
      return dom
    }
    const img = document.createElement('img')
    img.loading = 'lazy'
    img.decoding = 'async'
    // A loaded image changes its line's height, which the editor measures
    // again so that positions below it stay right.
    img.addEventListener('load', () => view.requestMeasure())
    // A label of `200` or `200x100` sizes the image, as in Obsidian.
    const dimensions = /^(\d{1,4})(?:x(\d{1,4}))?$/.exec(this.label)
    img.alt = dimensions ? (file.split('/').at(-1) ?? file) : this.label
    if (dimensions) {
      img.width = Number(dimensions[1])
      if (dimensions[2]) img.height = Number(dimensions[2])
    }
    dom.append(img)
    stops.set(
      dom,
      observeDocumentMedia(
        file.includes('/') ? `/${file}` : file,
        this.revision,
        (media) => {
          if (media?.kind === 'image') img.src = media.url
          else img.removeAttribute('src')
        },
      ),
    )
    return dom
  }
  override ignoreEvent(event: Event) {
    // Mouse events reach the editor; keys stay with the focused link.
    return !(event instanceof MouseEvent)
  }
  override destroy(dom: HTMLElement) {
    stops.get(dom)?.()
    stops.delete(dom)
    dom.querySelector('img')?.removeAttribute('src')
  }
}

const stops = new WeakMap<HTMLElement, () => void>()
const widgets = new WeakMap<HTMLElement, EmbedWidget>()

/**
 * With Markdown markers hidden an embed's source never shows, so an arrow key
 * toward an embedded note beside the caret focuses its link.
 */
function enterEmbed(view: EditorView, forward: boolean) {
  const { main, ranges } = view.state.selection
  if (view.state.facet(showMarkdownMarkers) || ranges.length > 1 || !main.empty)
    return false
  for (const link of view.contentDOM.querySelectorAll<HTMLElement>(
    '.obsidian-embed > a',
  )) {
    const dom = link.parentElement
    const widget = dom && widgets.get(dom)
    if (!widget) continue
    const from = view.posAtDOM(dom)
    if ((forward ? from : from + widget.length) !== main.head) continue
    link.focus()
    return true
  }
  return false
}

/** Wikilinks, embeds and highlights in documents that use the Obsidian flavor. */
export const contribution: FormattedContribution = {
  id: 'markdown.obsidian',
  flavor: 'markdown.obsidian',
  syntax: obsidianSyntax,
  views: [
    {
      nodes: ['WikiLink'],
      decorate(node, out, { state, revealed }) {
        const parts = wikiParts(state.sliceDoc(node.from, node.to))
        if (!parts) return false
        // The label reads as a link; brackets, and the target behind an alias, are syntax.
        const from = node.from + parts.labelFrom,
          to = node.from + parts.labelTo
        out.syntax(node.from, from)
        out.mark(from, to, {
          class: 'hibi-lp-link',
          'data-wiki-link': parts.target,
        })
        decodeEntities(state, out, from, to, revealed, 'hibi-lp-link')
        out.syntax(to, node.to)
        return false
      },
    },
    {
      nodes: ['WikiEmbed'],
      decorate(node, out, { state, revealed }) {
        const parts = wikiParts(state.sliceDoc(node.from, node.to))
        if (!parts) return false
        if (revealed) {
          out.syntax(node.from, node.from + 3)
          out.syntax(node.to - 2, node.to)
        } else
          out.replace(
            node.from,
            node.to,
            new EmbedWidget(
              parts.target,
              parts.label,
              state.facet(formattedDocument).revision,
              node.to - node.from,
            ),
          )
        return false
      },
    },
    {
      nodes: ['Highlight'],
      decorate(node, out, { state, revealed }) {
        out.syntax(node.from, node.from + 2)
        out.mark(node.from + 2, node.to - 2, { class: 'hibi-lp-highlight' })
        decodeEntities(
          state,
          out,
          node.from + 2,
          node.to - 2,
          revealed,
          'hibi-lp-highlight',
        )
        out.syntax(node.to - 2, node.to)
        return false
      },
    },
  ],
  keys: [
    { key: 'ArrowRight', run: (view) => enterEmbed(view, true) },
    { key: 'ArrowLeft', run: (view) => enterEmbed(view, false) },
  ],
  // The colors of the rich view's `<mark>`, which only the browser styles.
  extension: EditorView.baseTheme({
    '.hibi-lp-highlight': { backgroundColor: 'Mark', color: 'MarkText' },
  }),
}
