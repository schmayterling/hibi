import type {
  BlockContext,
  LeafBlock,
  LeafBlockParser,
  MarkdownConfig,
} from '@lezer/markdown'
import { alertMarker } from '../addons/markdown/alerts.ts'

/** Lezer's task parser, for a marker with nothing after it on its line. */
class EmptyTaskParser implements LeafBlockParser {
  nextLine() {
    return false
  }
  finish(cx: BlockContext, leaf: LeafBlock) {
    cx.addLeafElement(
      leaf,
      cx.elt('Task', leaf.start, leaf.start + leaf.content.length, [
        cx.elt('TaskMarker', leaf.start, leaf.start + 3),
        ...cx.parser.parseInline(leaf.content.slice(3), leaf.start + 3),
      ]),
    )
    return true
  }
}

/** `- [ ]` alone on its line is a task too; GFM's syntax needs text after the marker. */
export const EmptyTask: MarkdownConfig = {
  parseBlock: [
    {
      name: 'EmptyTask',
      leaf: (cx, leaf) =>
        /^\[[ xX]\]$/.test(leaf.content) && cx.parentType().name === 'ListItem'
          ? new EmptyTaskParser()
          : null,
      after: 'SetextHeading',
    },
  ],
}

/** Where a `[^label]` that starts at `pos` ends, or -1. Labels have no spaces or `]`. */
function labelEnd(char: (pos: number) => number, pos: number, end: number) {
  let at = pos + 2
  while (at < end) {
    const next = char(at)
    if (next === 93 /* ] */) return at > pos + 2 ? at + 1 : -1
    if (next === 32 || next === 9 || next === 10 || next === 13) return -1
    at++
  }
  return -1
}

/**
 * GitHub footnotes: `[^label]` references and `[^label]:` definitions, whose
 * later lines continue when indented by four columns, as with
 * marked-github-footnote.
 */
export const Footnotes: MarkdownConfig = {
  defineNodes: [
    {
      name: 'FootnoteDefinition',
      block: true,
      composite(_cx, line, value) {
        if (line.next > -1 && line.indent < line.baseIndent + value)
          return false
        line.moveBaseColumn(line.baseIndent + value)
        return true
      },
    },
    { name: 'FootnoteReference' },
    { name: 'FootnoteMark' },
    { name: 'FootnoteLabel' },
  ],
  parseBlock: [
    {
      name: 'FootnoteDefinition',
      parse(cx, line) {
        if (line.next !== 91 /* [ */ || line.indent >= line.baseIndent + 4)
          return false
        const text = line.text
        const end = labelEnd(
          (pos) => text.charCodeAt(pos),
          line.pos,
          text.length,
        )
        if (end < 0 || text.charCodeAt(line.pos + 1) !== 94 /* ^ */)
          return false
        if (text.charCodeAt(end) !== 58 /* : */) return false
        const start = cx.lineStart + line.pos
        cx.startComposite('FootnoteDefinition', line.pos, 4)
        const close = cx.lineStart + end
        cx.addElement(cx.elt('FootnoteMark', start, start + 2))
        cx.addElement(cx.elt('FootnoteLabel', start + 2, close - 1))
        cx.addElement(cx.elt('FootnoteMark', close - 1, close + 1))
        line.moveBase(end + 1)
        return null
      },
      before: 'LinkReference',
    },
  ],
  parseInline: [
    {
      name: 'FootnoteReference',
      parse(cx, next, pos) {
        if (next !== 91 /* [ */ || cx.char(pos + 1) !== 94 /* ^ */) return -1
        const end = labelEnd((at) => cx.char(at), pos, cx.end)
        if (end < 0) return -1
        return cx.addElement(
          cx.elt('FootnoteReference', pos, end, [
            cx.elt('FootnoteMark', pos, pos + 2),
            cx.elt('FootnoteLabel', pos + 2, end - 1),
            cx.elt('FootnoteMark', end - 1, end),
          ]),
        )
      },
      before: 'Link',
    },
  ],
}

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
