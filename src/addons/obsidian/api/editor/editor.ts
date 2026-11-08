import {
  cursorCharLeft,
  cursorCharRight,
  cursorDocEnd,
  cursorDocStart,
  cursorGroupLeft,
  cursorGroupRight,
  cursorLineDown,
  cursorLineUp,
  deleteLine,
  indentLess,
  indentMore,
  insertNewlineAndIndent,
  moveLineDown,
  moveLineUp,
  selectAll,
} from '@codemirror/commands'
import { foldAll, foldCode, unfoldAll } from '@codemirror/language'
import { EditorSelection } from '@codemirror/state'
import { type Command, EditorView } from '@codemirror/view'
import type {
  DocumentTarget,
  ViewTarget,
} from '../../../../shared/foundation-contracts'
import { runSourceHistory } from '../../../../shared/source-history.ts'
import type { AddonContext } from '../../../api'
import { type EditorPosition, SourceText } from './text.ts'

export type { EditorPosition }
export type EditorRange = { from: EditorPosition; to: EditorPosition }
export type EditorSelectionRange = {
  anchor: EditorPosition
  head: EditorPosition
}
export type EditorChange = {
  text: string
  from: EditorPosition
  to?: EditorPosition | undefined
}
export type EditorTransaction = {
  replaceSelection?: string
  changes?: EditorChange[]
  selections?: { from: EditorPosition; to?: EditorPosition }[]
  selection?: { from: EditorPosition; to?: EditorPosition }
}

export type EditorHost = {
  hibi: AddonContext
  /** The pane's mounted CodeMirror view, for selection, focus and scrolling; null once the pane shows something else. */
  viewOf: (target: ViewTarget) => EditorView | null
  /** Whether the pane still shows this view and note generation. */
  isLive: (target: ViewTarget) => boolean
}

const commands: Record<string, Command> = {
  goUp: cursorLineUp,
  goDown: cursorLineDown,
  goLeft: cursorCharLeft,
  goRight: cursorCharRight,
  goStart: cursorDocStart,
  goEnd: cursorDocEnd,
  goWordLeft: cursorGroupLeft,
  goWordRight: cursorGroupRight,
  indentMore,
  indentLess,
  newlineAndIndent: insertNewlineAndIndent,
  swapLineUp: moveLineUp,
  swapLineDown: moveLineDown,
  deleteLine,
  selectAll,
  toggleFold: foldCode,
  foldAll,
  unfoldAll,
}

let requests = 0
const word = /^[\p{L}\p{N}\p{M}_]$/u

/**
 * Obsidian's Editor over Hibi's source session. Reads take the canonical
 * source; edits are one version-checked source edit each, so history,
 * autosave, recovery and every pane of the note stay consistent.
 */
export class Editor {
  #cache: {
    version: number
    text: SourceText
    target: DocumentTarget
  } | null = null

  private readonly host: EditorHost
  readonly target: ViewTarget

  /**
   * Hibi editors draw one selection range, so further ranges a plugin sets
   * live here while the note and the drawn range are unchanged.
   */
  #multi: {
    version: number
    ranges: { anchor: number; head: number }[]
    main: number
  } | null = null

  constructor(host: EditorHost, target: ViewTarget) {
    this.host = host
    this.target = target
  }

  /** The pane's CodeMirror view, as `editor.cm` in Obsidian. */
  get cm(): EditorView | null {
    return this.host.viewOf(this.target)
  }

  /** An Editor whose pane moved to another note or view refuses, never retargets. */
  #live() {
    if (!this.host.isLive(this.target))
      throw new Error('This editor is no longer open in its pane.')
  }

  #source() {
    const document = {
      documentId: this.target.documentId,
      documentGeneration: this.target.documentGeneration,
    }
    const { documents } = this.host.hibi
    const metadata = documents.getMetadata(document)
    if (
      metadata.status === 'read' &&
      this.#cache?.version === metadata.metadata.target.contentVersion
    )
      return this.#cache
    const read = documents.readSource(document)
    if (read.status !== 'read') throw new Error(read.message)
    this.#cache = {
      version: read.target.contentVersion,
      text: new SourceText(read.source),
      target: read.target,
    }
    return this.#cache
  }
  #text() {
    return this.#source().text
  }

  getDoc() {
    return this
  }
  refresh() {}
  getValue() {
    return this.#text().text
  }
  setValue(content: string) {
    const text = this.#text()
    this.transaction({
      changes: [
        {
          text: content,
          from: { line: 0, ch: 0 },
          to: text.offsetToPos(text.length),
        },
      ],
    })
  }
  getLine(line: number) {
    return this.#text().getLine(line)
  }
  setLine(line: number, replacement: string) {
    const text = this.#text()
    if (line < 0 || line >= text.lineCount()) return
    this.replaceRange(
      replacement,
      { line, ch: 0 },
      { line, ch: text.getLine(line).length },
    )
  }
  lineCount() {
    return this.#text().lineCount()
  }
  lastLine() {
    return this.lineCount() - 1
  }
  posToOffset(position: EditorPosition) {
    return this.#text().posToOffset(position)
  }
  offsetToPos(offset: number) {
    return this.#text().offsetToPos(offset)
  }
  getRange(from: EditorPosition, to: EditorPosition) {
    const text = this.#text()
    const [start, end] = [text.posToOffset(from), text.posToOffset(to)].sort(
      (a, b) => a - b,
    )
    return text.text.slice(start, end)
  }
  replaceRange(
    replacement: string,
    from: EditorPosition,
    to?: EditorPosition,
    _origin?: string,
  ) {
    this.transaction({ changes: [{ text: replacement, from, to }] })
  }

  #drawn(): { anchor: number; head: number } {
    this.#live()
    const cm = this.cm
    if (cm) {
      const { anchor, head } = cm.state.selection.main
      return { anchor, head }
    }
    const selection = this.host.hibi.editorViews.getSelection(this.target)
    return selection.ok
      ? { anchor: selection.value.anchor, head: selection.value.head }
      : { anchor: 0, head: 0 }
  }
  #ranges(): { ranges: { anchor: number; head: number }[]; main: number } {
    const drawn = this.#drawn()
    const multi = this.#multi
    const kept = multi?.ranges[multi.main]
    if (
      multi &&
      kept &&
      multi.version === this.#source().version &&
      kept.anchor === drawn.anchor &&
      kept.head === drawn.head
    )
      return multi
    this.#multi = null
    return { ranges: [drawn], main: 0 }
  }
  listSelections(): EditorSelectionRange[] {
    const text = this.#text()
    return this.#ranges().ranges.map(({ anchor, head }) => ({
      anchor: text.offsetToPos(anchor),
      head: text.offsetToPos(head),
    }))
  }
  getCursor(which: 'from' | 'to' | 'head' | 'anchor' = 'head') {
    const { ranges, main } = this.#ranges()
    const { anchor, head } = ranges[main]!
    const at =
      which === 'from'
        ? Math.min(anchor, head)
        : which === 'to'
          ? Math.max(anchor, head)
          : which === 'anchor'
            ? anchor
            : head
    return this.#text().offsetToPos(at)
  }
  somethingSelected() {
    return this.#ranges().ranges.some(({ anchor, head }) => anchor !== head)
  }
  getSelection() {
    const { ranges, main } = this.#ranges()
    const { anchor, head } = ranges[main]!
    return this.#text().text.slice(
      Math.min(anchor, head),
      Math.max(anchor, head),
    )
  }
  setSelections(ranges: EditorSelectionRange[], main = ranges.length - 1) {
    const text = this.#text()
    const offsets = ranges.map(({ anchor, head }) => ({
      anchor: text.posToOffset(anchor),
      head: text.posToOffset(head ?? anchor),
    }))
    if (!offsets.length) return
    this.#live()
    const index = Math.max(0, Math.min(main, offsets.length - 1))
    const primary = offsets[index]!
    const cm = this.cm
    if (cm) cm.dispatch({ selection: primary })
    else {
      const current = this.host.hibi.editorViews.getSelection(this.target)
      if (!current.ok) throw new Error(current.message)
      const result = this.host.hibi.editorViews.setSelection({
        ...current.value,
        ...primary,
      })
      if (!result.ok) throw new Error(result.message)
    }
    this.#multi =
      offsets.length > 1
        ? { version: this.#source().version, ranges: offsets, main: index }
        : null
  }
  setSelection(anchor: EditorPosition, head?: EditorPosition) {
    this.setSelections([{ anchor, head: head ?? anchor }])
  }
  setCursor(position: EditorPosition | number, ch?: number) {
    const at =
      typeof position === 'number' ? { line: position, ch: ch ?? 0 } : position
    this.setSelection(at)
  }
  replaceSelection(replacement: string, _origin?: string) {
    this.transaction({ replaceSelection: replacement })
  }
  wordAt(position: EditorPosition): EditorRange | null {
    const text = this.#text()
    const line = text.getLine(position.line)
    let from = Math.max(0, Math.min(position.ch, line.length))
    // Whole code points, so astral letters count and pairs never split.
    if (from > 0 && /[\uDC00-\uDFFF]/.test(line[from] ?? '')) from--
    let to = from
    const before = (at: number) => {
      const low = line.charCodeAt(at - 1)
      return line.slice(
        at > 1 && low >= 0xdc00 && low <= 0xdfff ? at - 2 : at - 1,
        at,
      )
    }
    while (from > 0 && word.test(before(from))) from -= before(from).length
    while (to < line.length) {
      const next = String.fromCodePoint(line.codePointAt(to)!)
      if (!word.test(next)) break
      to += next.length
    }
    return from === to
      ? null
      : {
          from: { line: position.line, ch: from },
          to: { line: position.line, ch: to },
        }
  }

  /** All changes are one source edit, so one undo step. */
  transaction(transaction: EditorTransaction, _origin?: string) {
    const source = this.#source()
    const { text } = source
    const edits: { from: number; to: number; insert: string }[] = []
    for (const change of transaction.changes ?? []) {
      const [from, to] = [
        text.posToOffset(change.from),
        text.posToOffset(change.to ?? change.from),
      ].sort((a, b) => a - b) as [number, number]
      edits.push({ from, to, insert: change.text })
    }
    if (transaction.replaceSelection !== undefined)
      for (const { anchor, head } of this.#ranges().ranges)
        edits.push({
          from: Math.min(anchor, head),
          to: Math.max(anchor, head),
          insert: transaction.replaceSelection,
        })
    edits.sort((a, b) => a.from - b.from || a.to - b.to)
    // Where each insert ends once all of them apply, in editor offsets.
    const ends: number[] = []
    let shift = 0
    for (const edit of edits) {
      const length = edit.insert.replace(/\r\n?/g, '\n').length
      ends.push(edit.from + shift + length)
      shift += length - (edit.to - edit.from)
    }
    if (edits.length) {
      const result = this.host.hibi.documents.applyEdits({
        requestId: `obsidian-editor-${++requests}`,
        target: {
          documentId: source.target.documentId,
          documentGeneration: source.target.documentGeneration,
          contentVersion: source.version,
        },
        changes: edits.map(({ from, to, insert }) => {
          const rawFrom = text.toRaw(from)
          const rawTo = text.toRaw(to)
          return {
            from: rawFrom,
            to: rawTo,
            insert: text.toRawInsert(insert),
            expectedText: text.raw.slice(rawFrom, rawTo),
          }
        }),
      })
      if (result.status !== 'applied') throw new Error(result.message)
    }
    const selections =
      transaction.selections ??
      (transaction.selection ? [transaction.selection] : null)
    if (selections)
      this.setSelections(
        selections.map(({ from, to }) => ({ anchor: from, head: to ?? from })),
      )
    else if (transaction.replaceSelection !== undefined && ends.length) {
      const after = this.#text()
      this.setSelections(
        ends.map((end) => ({
          anchor: after.offsetToPos(end),
          head: after.offsetToPos(end),
        })),
      )
    }
  }

  /** The pane's own history, not the focused pane's. */
  #history(direction: 'undo' | 'redo') {
    this.#live()
    const cm = this.cm
    if (cm) {
      runSourceHistory(cm, direction)
      return
    }
    const active = this.host.hibi.editorViews.getActive()
    if (
      active?.viewId === this.target.viewId &&
      active.viewGeneration === this.target.viewGeneration
    )
      void this.host.hibi.editor.runCommand(direction)
  }
  undo() {
    this.#history('undo')
  }
  redo() {
    this.#history('redo')
  }
  exec(command: string) {
    if (command === 'undo') return this.undo()
    if (command === 'redo') return this.redo()
    const run = commands[command]
    this.#live()
    const cm = this.cm
    if (run && cm) run(cm)
  }

  focus() {
    this.cm?.focus()
  }
  blur() {
    this.cm?.contentDOM.blur()
  }
  hasFocus() {
    return this.cm?.hasFocus ?? false
  }
  scrollIntoView(range: EditorRange, center?: boolean) {
    const cm = this.cm
    if (!cm) return
    const text = this.#text()
    cm.dispatch({
      effects: EditorView.scrollIntoView(
        EditorSelection.range(
          text.posToOffset(range.from),
          text.posToOffset(range.to),
        ),
        { y: center ? 'center' : 'nearest' },
      ),
    })
  }
  getScrollInfo() {
    const dom = this.cm?.scrollDOM
    return {
      top: dom?.scrollTop ?? 0,
      left: dom?.scrollLeft ?? 0,
      height: dom?.scrollHeight ?? 0,
      width: dom?.scrollWidth ?? 0,
      clientHeight: dom?.clientHeight ?? 0,
      clientWidth: dom?.clientWidth ?? 0,
    }
  }
  scrollTo(x?: number | null, y?: number | null) {
    const dom = this.cm?.scrollDOM
    if (!dom) return
    if (typeof x === 'number') dom.scrollLeft = x
    if (typeof y === 'number') dom.scrollTop = y
  }
}
