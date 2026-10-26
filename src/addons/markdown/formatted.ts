import { WidgetType } from '@codemirror/view'
import type {
  BlockContext,
  LeafBlock,
  LeafBlockParser,
  MarkdownConfig,
} from '@lezer/markdown'
import type { FormattedContribution } from '../../renderer/src/formatted-contributions.ts'
import { alertMarker, alertType } from './alerts.ts'
import './formatted.css'

/** Where a quote starts on the line being parsed, per parse. */
const quoteStarts = new WeakMap<BlockContext, number>()

/** A quote's first line `[!type] title` is its alert title; the body starts on the next line. */
class AlertTitleParser implements LeafBlockParser {
  nextLine(cx: BlockContext, _line: unknown, leaf: LeafBlock) {
    return this.finish(cx, leaf)
  }
  finish(cx: BlockContext, leaf: LeafBlock) {
    const marker = alertMarker(leaf.content)
    if (!marker) return false
    // `[!`, the type, `]` and an optional fold sign.
    const mark = 3 + (marker[1]?.length ?? 0) + (marker[2]?.length ?? 0)
    cx.addLeafElement(
      leaf,
      cx.elt('AlertTitle', leaf.start, leaf.start + leaf.content.length, [
        cx.elt('AlertMark', leaf.start, leaf.start + mark),
      ]),
    )
    return true
  }
}

/** GitHub alerts: a quote whose first line is `[!type]`, with an optional title after it. */
export const GithubAlerts: MarkdownConfig = {
  defineNodes: [{ name: 'AlertTitle', block: true }, { name: 'AlertMark' }],
  parseBlock: [
    {
      name: 'AlertQuoteStart',
      parse(cx, line) {
        if (line.next === 62 /* > */) quoteStarts.set(cx, cx.lineStart)
        return false
      },
      before: 'Blockquote',
    },
    {
      name: 'AlertTitle',
      leaf: (cx, leaf) =>
        cx.parentType().name === 'Blockquote' &&
        quoteStarts.get(cx) === cx.lineStart &&
        alertMarker(leaf.content)
          ? new AlertTitleParser()
          : null,
      after: 'SetextHeading',
    },
  ],
}

/** The alert's type, or its own title, as the rich editor shows it. */
export class AlertTitleWidget extends WidgetType {
  readonly text: string
  constructor(text: string) {
    super()
    this.text = text
  }
  override eq(other: AlertTitleWidget) {
    return other.text === this.text
  }
  toDOM() {
    const title = document.createElement('span')
    title.className = 'hibi-lp-alert-title-text'
    title.textContent = this.text
    return title
  }
}

/** The alert type of a title line's source. */
export function titleOf(source: string) {
  const marker = alertMarker(source)
  if (!marker) return null
  const type = alertType(marker[1]) ?? 'note'
  return { type, text: marker[3]?.trim() || type }
}

export const contribution: FormattedContribution = {
  id: 'markdown.alerts',
  feature: 'markdown.alerts',
  syntax: GithubAlerts,
  views: [
    {
      nodes: ['AlertTitle'],
      decorate(node, out, { state, revealed }) {
        const title = titleOf(state.sliceDoc(node.from, node.to))
        if (!title) return false
        out.line(state.doc.lineAt(node.from).from, {
          class: 'hibi-lp-alert-title',
        })
        const mark = node.node.getChild('AlertMark')
        if (revealed) {
          if (mark) out.mark(mark.from, mark.to, { class: 'hibi-lp-marker' })
        } else out.replace(node.from, node.to, new AlertTitleWidget(title.text))
        return false
      },
    },
  ],
}
