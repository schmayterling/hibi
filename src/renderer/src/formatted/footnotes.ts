import {
  type EditorState,
  StateEffect,
  StateField,
  type Text,
} from '@codemirror/state'
import { type EditorView, ViewPlugin } from '@codemirror/view'
import type { MarkdownConfig } from '@lezer/markdown'
import {
  type FormattedContribution,
  formattedRefresh,
} from '../formatted-contributions.ts'
import './footnotes.css'

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

/*
 * A reference is a footnote only when the note defines its label, as in
 * marked-github-footnote. Definitions are indexed from the text: opening a
 * note reads one slice, idle time reads the rest, and an edit reads only the
 * lines it changed.
 */

/** A definition's first line: `[^label]:` after quote markers and up to three spaces. */
const definitionLine = /^(?:[ \t]*>)*[ ]{0,3}\[\^([^\]\s]+)\]:/

/** The label a line defines, lowercased as references match it. */
function definedLabel(text: string) {
  if (!text.includes('[^')) return null
  return definitionLine.exec(text)?.[1]?.toLowerCase() ?? null
}

/** Characters read per slice, and lines read, for scale tests. */
export const footnoteScan = { slice: 1 << 20, lines: 0 }

type Definitions = {
  /** Definitions per label in the read part of the note. */
  labels: ReadonlyMap<string, number>
  /** The note is read up to this line start; past its end once all of it is read. */
  read: number
}

function count(labels: Map<string, number>, label: string | null, by: number) {
  if (!label) return
  const next = (labels.get(label) ?? 0) + by
  if (next > 0) labels.set(label, next)
  else labels.delete(label)
}

/** Read about one slice of lines from the line start `from` into `labels`; returns where reading stopped and whether it found definitions. */
function readSlice(doc: Text, from: number, labels: Map<string, number>) {
  let at = from,
    found = false
  if (from > doc.length) return { at, found }
  const stop = from + footnoteScan.slice
  for (
    const iter = doc.iterLines(doc.lineAt(from).number);
    at <= stop && !iter.next().done;
  ) {
    footnoteScan.lines++
    const label = definedLabel(iter.value)
    if (label) {
      count(labels, label, 1)
      found = true
    }
    at += iter.value.length + 1
  }
  return { at, found }
}

/** Reads the next slice of the note for definitions; formatted views dispatch it in idle time. */
export const readDefinitions = StateEffect.define<null>()

export const footnoteDefinitions = StateField.define<Definitions>({
  create(state) {
    const labels = new Map<string, number>()
    return { labels, read: readSlice(state.doc, 0, labels).at }
  },
  update(value, transaction) {
    let { labels, read } = value
    if (transaction.docChanged) {
      const before = transaction.startState.doc,
        doc = transaction.state.doc
      const removed = new Set<number>(),
        added = new Set<number>()
      read =
        value.read > before.length
          ? doc.length + 1
          : transaction.changes.mapPos(value.read, -1)
      transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
        // Unread text is read later, edited or not.
        if (fromA >= value.read) return
        const last = before.lineAt(Math.min(toA, value.read - 1)).number
        for (let n = before.lineAt(fromA).number; n <= last; n++) removed.add(n)
        const end = doc.lineAt(toB)
        for (let n = doc.lineAt(fromB).number; n <= end.number; n++)
          added.add(n)
        read = Math.max(read, end.to + 1)
      })
      const changed: [string, number][] = []
      for (const n of removed) {
        footnoteScan.lines++
        const label = definedLabel(before.line(n).text)
        if (label) changed.push([label, -1])
      }
      for (const n of added) {
        footnoteScan.lines++
        const label = definedLabel(doc.line(n).text)
        if (label) changed.push([label, 1])
      }
      if (changed.length) {
        const next = new Map(labels)
        for (const [label, by] of changed) count(next, label, by)
        labels = next
      }
    }
    if (transaction.effects.some((effect) => effect.is(readDefinitions))) {
      const next = new Map(labels)
      const slice = readSlice(transaction.state.doc, read, next)
      read = slice.at
      if (slice.found) labels = next
    }
    return labels === value.labels && read === value.read
      ? value
      : { labels, read }
  },
})

/** Reads the rest of a long note in idle slices. */
const reader = ViewPlugin.fromClass(
  class {
    private idle = 0
    private readonly view: EditorView
    constructor(view: EditorView) {
      this.view = view
      this.schedule()
    }
    update() {
      this.schedule()
    }
    schedule() {
      if (
        this.idle ||
        this.view.state.field(footnoteDefinitions).read >
          this.view.state.doc.length
      )
        return
      this.idle = requestIdleCallback(() => {
        this.idle = 0
        const { labels } = this.view.state.field(footnoteDefinitions)
        this.view.dispatch({ effects: readDefinitions.of(null) })
        // References in view follow the definitions just read.
        if (this.view.state.field(footnoteDefinitions).labels !== labels)
          this.view.dispatch({ effects: formattedRefresh.of(null) })
      })
    }
    destroy() {
      if (this.idle) cancelIdleCallback(this.idle)
    }
  },
)

/** Whether the note defines a reference's label. */
export function defined(state: EditorState, label: string) {
  return !!state
    .field(footnoteDefinitions, false)
    ?.labels.has(label.toLowerCase())
}

/** A CSS string for a list marker. */
const cssString = (text: string) => `"${text.replace(/["\\]/g, '\\$&')}"`

/** References render as superscript labels and definitions as notes labelled in their margin, both editable in place. */
export const contribution: FormattedContribution = {
  id: 'markdown.footnotes',
  extension: [footnoteDefinitions, reader],
  flavor: 'markdown.github',
  syntax: Footnotes,
  // References start at `[`, so text without one is still skipped.
  inlineStops: true,
  views: [
    {
      nodes: ['FootnoteReference'],
      decorate(node, out, { state }) {
        const [open, close] = node.node.getChildren('FootnoteMark')
        const label = node.node.getChild('FootnoteLabel')
        // Without a definition, the reference is text, as in exports.
        if (
          !open ||
          !close ||
          !label ||
          !defined(state, state.sliceDoc(label.from, label.to))
        )
          return false
        out.syntax(open.from, open.to)
        out.mark(label.from, label.to, { class: 'hibi-lp-footnote-ref' })
        out.syntax(close.from, close.to)
        return false
      },
    },
    {
      nodes: ['FootnoteDefinition'],
      // A note's lines hang like a list item's, its label in the margin.
      container: () => ({
        width: 'calc(1.5 * var(--text-editor))',
        class: 'hibi-lp-footnote',
      }),
      decorate(node, out, { state }) {
        const label = node.node.getChild('FootnoteLabel')
        if (!label) return undefined
        // The marker before the note's text is hidden with the line's prefix.
        out.line(state.doc.lineAt(node.from).from, {
          class: 'hibi-lp-footnote-label',
          style: `list-style-type: ${cssString(`${state.sliceDoc(label.from, label.to)} `)}`,
        })
        return undefined
      },
      layout(node, out, { state }) {
        // Continuation lines flow after a space, so their indentation is hidden.
        for (const block of node.node.getChildren('Paragraph')) {
          const first = state.doc.lineAt(block.from).number
          const last = state.doc.lineAt(block.to).number
          for (let number = first + 1; number <= last; number++) {
            const line = state.doc.line(number)
            const indent =
              line.text.length - line.text.replace(/^[ \t]+/, '').length
            if (indent) out.replace(line.from, line.from + indent)
          }
        }
        return undefined
      },
    },
  ],
}
