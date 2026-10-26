import { isolateHistory } from '@codemirror/commands'
import {
  type ChangeSpec,
  type EditorState,
  type Text,
  Transaction,
} from '@codemirror/state'
import { EditorView, type KeyBinding, WidgetType } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import {
  type FormattedNodeView,
  showMarkdownMarkers,
} from '../../renderer/src/formatted-contributions.ts'

/*
 * Fenced blocks that an addon renders in the formatted view, such as diagrams
 * and Typst: the rendering replaces a closed fence, and while the caret is in
 * the fence its source shows as a code block with the rendering after it.
 */

/** A closed fenced code block in the formatted view's syntax tree. */
export type Fence = {
  /** Info string after the opening fence. */
  info: string
  /** The opening fence characters, such as ``` or ~~~~. */
  marker: string
  /** Body lines inside the fence's containers, with the fence's own indentation. */
  lines: string[]
  /** Columns the fence is indented inside its containers. */
  indent: number
}

/** The fence of a `FencedCode` node, when it has a closing fence. */
export function readFence(doc: Text, node: SyntaxNode): Fence | null {
  const open = node.firstChild,
    close = node.lastChild
  const first = doc.lineAt(node.from)
  if (
    open?.name !== 'CodeMark' ||
    close?.name !== 'CodeMark' ||
    doc.lineAt(close.from).number === first.number
  )
    return null
  const info = node.getChild('CodeInfo')
  // Each body line's text, from its containers' content column; blank lines have none.
  const last = doc.lineAt(close.from).number
  const lines = Array.from({ length: last - first.number - 1 }, () => '')
  let base = -1
  for (let child = open.nextSibling; child; child = child.nextSibling) {
    if (child.name !== 'CodeText') continue
    for (let at = child.from; at < child.to; ) {
      const line = doc.lineAt(at)
      const end = Math.min(child.to, line.to)
      if (end > at) {
        lines[line.number - first.number - 1] += doc.sliceString(at, end)
        if (base < 0) base = at - line.from
      }
      at = line.to + 1
    }
  }
  return {
    info: info ? doc.sliceString(info.from, info.to) : '',
    marker: doc.sliceString(open.from, open.to),
    lines,
    indent: base < 0 ? 0 : Math.max(0, node.from - first.from - base),
  }
}

/** A fence's body as Marked's code token has it: lines lose up to an indented backtick fence's indentation. */
export const markedFenceText = ({ lines, marker, indent }: Fence) =>
  (marker.startsWith('`') && indent
    ? lines.map((line) =>
        line.slice(Math.min(/^\s*/.exec(line)?.[0].length ?? 0, indent)),
      )
    : lines
  ).join('\n')

/** A fence's body with its indentation removed from the lines that start with it. */
export const dedentedFenceText = ({ lines, indent }: Fence) =>
  lines
    .map((line) =>
      line.startsWith(' '.repeat(indent)) ? line.slice(indent) : line,
    )
    .join('\n')

/**
 * Changes that make `source` the body of the fence `node`, keeping its
 * opening and closing lines and writing each new line with the containers'
 * prefix. A longer fence keeps a body line that would close it inside.
 */
export function fenceBodyChanges(
  doc: Text,
  node: { from: number; to: number },
  source: string,
  fence: { indent: number; indented: boolean },
): ChangeSpec[] {
  const first = doc.lineAt(node.from),
    last = doc.lineAt(node.to)
  // List markers on the opening line become spaces on the lines below it.
  // The fence's own indentation goes on each line when readers remove it.
  const opening = first.text
    .slice(0, node.from - first.from)
    .replace(/[^>\t ]/g, ' ')
  const prefix = fence.indented
    ? opening
    : opening.slice(0, Math.max(0, opening.length - fence.indent))
  const marker = /^(`+|~+)/.exec(doc.sliceString(node.from, first.to))![0]
  const char = marker[0]!
  let length = marker.length
  const lines = source.split('\n')
  for (const line of lines) {
    const run = new RegExp(`^ {0,3}(\\${char}+)[ \\t]*$`).exec(line)?.[1]
    if (run && run.length >= length) length = run.length + 1
  }
  const changes: ChangeSpec[] = [
    {
      from: Math.min(first.to + 1, last.from),
      to: last.from,
      insert: source
        ? `${lines.map((line) => (line ? prefix + line : prefix.trimEnd())).join('\n')}\n`
        : '',
    },
  ]
  if (length > marker.length) {
    const closing = /^[ \t>]*([`~]+)/.exec(last.text)
    changes.push({
      from: node.from,
      to: node.from + marker.length,
      insert: char.repeat(length),
    })
    if (closing)
      changes.push({
        from: last.from + closing[0].length - closing[1]!.length,
        to: last.from + closing[0].length,
        insert: char.repeat(length),
      })
  }
  return changes
}

/** A rendered block, and the view and widget that show it now. */
type Rendered = {
  key: string
  dom: HTMLElement
  dispose: () => void
  owner: { view: EditorView; widget: FenceWidget }
}

/** Rendered blocks kept after they leave the view, so a block that returns reuses its output. */
export class RenderedBlocks {
  private entries: Rendered[] = []
  private readonly limit: number
  /** After `clear`, blocks that leave the view are disposed at once. */
  private closed = false
  constructor(limit: number) {
    this.limit = limit
  }
  /** A kept rendering of `key` that is not shown anywhere. */
  take(key: string) {
    for (let index = this.entries.length - 1; index >= 0; index--) {
      const entry = this.entries[index]!
      if (entry.key !== key || entry.dom.isConnected) continue
      this.entries.splice(index, 1)
      return entry
    }
    return null
  }
  keep(entry: Rendered) {
    this.entries.push(entry)
    while (this.entries.length > (this.closed ? 0 : this.limit))
      this.entries.shift()?.dispose()
  }
  clear() {
    this.closed = true
    for (const entry of this.entries.splice(0)) entry.dispose()
  }
}

/** What renders a fence's block: its source, and the edit action of the widget that shows it. */
export type FenceBlock = {
  source: string
  edit: () => void
}

const mounted = new WeakMap<HTMLElement, Rendered>()

/** A fence's rendering, replacing the fence or after its source while the caret is in it. */
class FenceWidget extends WidgetType {
  readonly kind: FencedRenderer
  /** The fence node's text, which edits check before writing. */
  readonly text: string
  readonly source: string
  /** How edits write the fence's lines. */
  readonly indent: { indent: number; indented: boolean }
  /** Shown after the fence's source instead of replacing it. */
  readonly after: boolean
  constructor(
    kind: FencedRenderer,
    text: string,
    fence: Fence,
    after: boolean,
  ) {
    super()
    this.kind = kind
    this.text = text
    this.source = kind.source(fence)
    this.indent = { indent: fence.indent, indented: kind.indented(fence) }
    this.after = after
  }
  override eq(other: FenceWidget) {
    return (
      other.kind === this.kind &&
      other.text === this.text &&
      other.after === this.after
    )
  }
  toDOM(view: EditorView) {
    const key = `${this.kind.id}\n${this.source}`
    let entry = this.kind.blocks.take(key)
    if (entry) entry.owner = { view, widget: this }
    else {
      const dom = document.createElement('div')
      dom.className = this.kind.className
      const created: Rendered = {
        key,
        dom,
        dispose: () => {},
        owner: { view, widget: this },
      }
      created.dispose = this.kind.mount(created.dom, {
        source: this.source,
        edit: () => void created.owner.widget.edit(created),
      })
      // Arrow keys and Escape take the caret from the block's controls back
      // beside the block, on the side they point to.
      created.dom.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Escape'].includes(event.key)) return
        const { view, widget } = created.owner
        event.preventDefault()
        const at = view.posAtDOM(created.dom)
        const from = widget.after ? at - widget.text.length : at
        view.focus()
        view.dispatch({
          selection: {
            anchor:
              event.key === 'ArrowLeft' ? from : from + widget.text.length,
          },
        })
      })
      entry = created
    }
    mounted.set(entry.dom, entry)
    return entry.dom
  }
  /** Ask for new source and write it as one edit, unless the fence changed meanwhile. */
  async edit(entry: Rendered) {
    const { view } = entry.owner
    if (view.state.readOnly || !view.state.facet(EditorView.editable)) return
    const position = () => {
      const at = view.posAtDOM(entry.dom)
      return this.after ? at - this.text.length : at
    }
    const before = position()
    const source = await this.kind.ask(this.source)
    if (source === null || source === this.source) return
    const from = entry.dom.isConnected ? position() : before
    const doc = view.state.doc
    if (doc.sliceString(from, from + this.text.length) !== this.text) return
    view.dispatch({
      changes: fenceBodyChanges(
        doc,
        { from, to: from + this.text.length },
        source,
        this.indent,
      ),
      annotations: [
        Transaction.userEvent.of('input.format'),
        isolateHistory.of('full'),
      ],
    })
    view.focus()
  }
  override destroy(dom: HTMLElement) {
    const entry = mounted.get(dom)
    mounted.delete(dom)
    if (entry) this.kind.blocks.keep(entry)
  }
  override ignoreEvent(event: Event) {
    // Controls in the block handle their own input; other clicks place the caret.
    return !!(event.target as Element | null)?.closest?.(
      'button, a, input, textarea',
    )
  }
}

/** How an addon renders a kind of fenced block in the formatted view. */
export type FencedRenderer = {
  id: string
  /** Class of the element `mount` renders into. */
  className: string
  /** Whether a fence's info string is this kind. */
  matches: (info: string) => boolean
  /** The block's source from the fence, as the rich view reads it. */
  source: (fence: Fence) => string
  /** Whether that reading removes the fence's indentation from its lines. */
  indented: (fence: Fence) => boolean
  /** Render into `dom`; returns the cleanup. */
  mount: (dom: HTMLElement, block: FenceBlock) => () => void
  /** The addon's edit dialog; resolves to the new source, or null. */
  ask: (source: string) => Promise<string | null>
  blocks: RenderedBlocks
}

/**
 * With Markdown markers hidden a fence's source never shows, so an arrow key
 * toward a rendered block beside the caret focuses the block's first control.
 */
export function fenceKeys(kind: FencedRenderer): KeyBinding[] {
  const enter = (view: EditorView, forward: boolean) => {
    const { main, ranges } = view.state.selection
    if (
      view.state.facet(showMarkdownMarkers) ||
      ranges.length > 1 ||
      !main.empty
    )
      return false
    for (const element of view.contentDOM.querySelectorAll<HTMLElement>(
      `.${kind.className}`,
    )) {
      const entry = mounted.get(element)
      if (!entry || entry.owner.widget.after) continue
      const from = view.posAtDOM(element)
      const to = from + entry.owner.widget.text.length
      if ((forward ? from : to) !== main.head) continue
      const control = element.querySelector<HTMLElement>('button')
      if (!control) return false
      control.focus()
      return true
    }
    return false
  }
  return [
    { key: 'ArrowRight', run: (view) => enter(view, true) },
    { key: 'ArrowLeft', run: (view) => enter(view, false) },
  ]
}

/** Renders closed fences of one kind; others stay code blocks. */
export function fencedView(kind: FencedRenderer): FormattedNodeView {
  const fenceOf = (state: EditorState, node: SyntaxNode) => {
    const fence = readFence(state.doc, node)
    return fence && kind.matches(fence.info.trim()) ? fence : null
  }
  return {
    nodes: ['FencedCode'],
    layout(node, out, { state, revealed }) {
      const fence = fenceOf(state, node.node)
      if (!fence) return undefined
      const text = state.sliceDoc(node.from, node.to)
      // A replaced range keeps its first line's container indent and spacing.
      if (revealed)
        out.widget(node.to, new FenceWidget(kind, text, fence, true), {
          side: 1,
        })
      else
        out.replace(
          node.from,
          node.to,
          new FenceWidget(kind, text, fence, false),
        )
      // While the caret is in it, the fence lines show too.
      return false
    },
    decorate(node, out, { state, revealed }) {
      if (!revealed || !fenceOf(state, node.node)) return undefined
      const first = state.doc.lineAt(node.from)
      out.syntax(node.from, first.to)
      const close = node.node.lastChild!
      out.syntax(close.from, close.to)
      return undefined
    },
  }
}
