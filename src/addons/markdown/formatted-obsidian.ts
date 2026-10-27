import type { EditorState } from '@codemirror/state'
import { EditorView, WidgetType } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { observeDocumentMedia } from '../../renderer/src/document-media.ts'
import {
  type FormattedContribution,
  formattedDocument,
  formattedSyntaxTree,
  showMarkdownMarkers,
} from '../../renderer/src/formatted-contributions.ts'
import { wrapDecoded } from '../_shared/formatted-entities.ts'
import { obsidianSyntax, wikiText } from './formatted-syntax.ts'

const image = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i

/** Embeds the formatted view drew, for viewport tests. */
export const embedRenders = { count: 0 }

/**
 * A wikilink or embed's target, and its label's node: the alias, or else the
 * target. Their text was kept when they were parsed.
 */
function wikiParts(node: SyntaxNode, state: EditorState) {
  const target = node.getChild('WikiTarget')
  const label = node.getChild('WikiAlias') ?? target
  let text = target?.tree?.prop(wikiText)
  const aliased = node.getChildren('WikiMark').length === 3
  if (aliased && text?.endsWith('\\')) {
    let parent: SyntaxNode | null =
      formattedSyntaxTree(state)?.resolveInner(node.from, 1) ?? null
    while (parent && parent.name !== 'Table') parent = parent.parent
    // The table owns the slash before its alias pipe, not the wiki target.
    // Keep the parsed source ranges intact for both cell renderers.
    if (parent) text = text.slice(0, -1).trimEnd()
  }
  return label && text !== undefined ? { target: text, label, aliased } : null
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
        } else if (!['Alt', 'Control', 'Meta', 'Shift'].includes(event.key))
          // Other keys edit at the caret beside the embed, which the editor
          // keeps: it takes focus back before the key reaches it.
          view.focus()
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
    // Mouse events reach the editor, and so do keys the focused link leaves.
    return !(event instanceof MouseEvent) && event.defaultPrevented
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
  // Embeds, wikilinks and highlights start at `!`, `[` and `=`, so text
  // without them is still skipped.
  inlineStops: true,
  views: [
    {
      nodes: ['WikiLink'],
      decorate(node, out, context) {
        const parts = wikiParts(node.node, context.state)
        if (!parts) return false
        // The label reads as a link; brackets, and the target behind an alias, are syntax.
        const { from, to } = parts.label
        out.syntax(node.from, from)
        wrapDecoded(
          out,
          context,
          from,
          to,
          {
            'data-wiki-link': parts.target,
            'data-wiki-alias': String(parts.aliased),
          },
          true,
        )
        out.syntax(to, node.to)
        return false
      },
    },
    {
      nodes: ['WikiEmbed'],
      decorate(node, out, { state, revealed }) {
        const parts = wikiParts(node.node, state)
        const label =
          parts?.label.name === 'WikiTarget'
            ? parts.target
            : parts?.label.tree?.prop(wikiText)
        if (!parts || label === undefined) return false
        const widget = new EmbedWidget(
          parts.target,
          label,
          state.facet(formattedDocument).revision,
          node.to - node.from,
        )
        if (revealed) {
          out.syntax(node.from, node.from + 3)
          out.syntax(node.to - 2, node.to)
          // An image stays beside its source, as core images do; a note's
          // link would only repeat the label.
          if (image.test(parts.target.split('#')[0] ?? ''))
            out.widget(node.to, widget)
        } else out.replace(node.from, node.to, widget)
        return false
      },
    },
    {
      nodes: ['Highlight'],
      decorate(node, out, context) {
        out.syntax(node.from, node.from + 2)
        wrapDecoded(out, context, node.from + 2, node.to - 2, {
          class: 'hibi-lp-highlight',
        })
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
