import {
  indentLess,
  indentMore,
  isolateHistory,
  redo,
  redoDepth,
  undo,
  undoDepth,
} from '@codemirror/commands'
import { EditorSelection, Transaction } from '@codemirror/state'
import type { EditorView, KeyBinding } from '@codemirror/view'
import type {
  DocumentEdit,
  DocumentFormat,
  DocumentSelection,
} from '../../addons/api'
import type { MediaAttachment } from '../../shared/media'

/** Same format actions as the toolbar; addon keymaps (including vim) run first. */
const formatBindings: [string, string][] = [
  ['Mod-b', 'bold'],
  ['Mod-i', 'italic'],
  ['Mod-e', 'inline-code'],
  ['Mod-Shift-x', 'strike'],
  ['Mod-Shift-7', 'numbered-list'],
  ['Mod-Shift-8', 'bullet-list'],
  ['Mod-Shift-9', 'checklist'],
  ['Mod-Shift-b', 'quote'],
  ['Mod-Alt-c', 'code-block'],
  ['Mod-Alt-0', 'paragraph'],
  ...Array.from({ length: 6 }, (_, i): [string, string] => [
    `Mod-Alt-${i + 1}`,
    `heading-${i + 1}`,
  ]),
]
export const formattingKeymap = (run: (id: string) => boolean): KeyBinding[] =>
  formatBindings.map(([key, id]) => ({ key, run: () => run(id) }))

export type InsertValues = { url: string; alt: string }
export type SourceFormatting = ReturnType<typeof sourceFormatting>
const marks: Record<string, string> = {
  bold: '**',
  italic: '*',
  strike: '~~',
  subscript: '~',
  'inline-code': '`',
}
const prefixes: Record<string, string> = {
  'bullet-list': '- ',
  'numbered-list': '1. ',
  checklist: '- [ ] ',
  quote: '> ',
  subtext: '-# ',
}
const fenceLength = (text: string, minimum = 0) =>
  Array.from(text.matchAll(/`+/g)).reduce(
    (longest, match) => Math.max(longest, match[0].length),
    minimum,
  ) + 1

/** One transaction per action: preserve selections and isolate the undo step. */
function validEdit(
  edit: DocumentEdit | null | undefined,
  length: number,
): edit is DocumentEdit {
  if (
    !edit ||
    !Number.isInteger(edit.from) ||
    !Number.isInteger(edit.to) ||
    edit.from < 0 ||
    edit.to < edit.from ||
    edit.to > length ||
    typeof edit.insert !== 'string'
  )
    return false
  const start = edit.selection?.from ?? edit.insert.length,
    end = edit.selection?.to ?? start
  return (
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end >= start &&
    end <= edit.insert.length
  )
}

export function sourceFormatting(
  view: EditorView,
  format: DocumentFormat['formatting'] | null = 'markdown',
  media = false,
  history?: {
    undo: () => boolean
    redo: () => boolean
    state: () => { canUndo: boolean; canRedo: boolean }
  },
) {
  const editable = () => !view.state.readOnly
  let lastDocument = view.state.doc,
    text = lastDocument.toString()
  const selection = (values?: InsertValues): DocumentSelection => {
    if (lastDocument !== view.state.doc) {
      lastDocument = view.state.doc
      text = lastDocument.toString()
    }
    const range = view.state.selection.main
    return { source: text, from: range.from, to: range.to, values }
  }
  const supported = (id: string) =>
    ['undo', 'redo', 'indent', 'outdent'].includes(id) ||
    (media && id === 'image') ||
    format === 'markdown' ||
    !!format?.actions.includes(id)
  const applyEdit = (edit: DocumentEdit) => {
    if (!validEdit(edit, view.state.doc.length)) return false
    const start = edit.selection?.from ?? edit.insert.length,
      end = edit.selection?.to ?? start
    view.dispatch({
      changes: { from: edit.from, to: edit.to, insert: edit.insert },
      selection: EditorSelection.single(edit.from + start, edit.from + end),
      annotations: [
        Transaction.userEvent.of('input.format'),
        isolateHistory.of('full'),
      ],
      scrollIntoView: true,
    })
    view.focus()
    return true
  }
  const marked = (id: string) => {
    const selection = view.state.selection.main
    const token = marks[id]
    if (id === 'italic') {
      const before = view.state.doc.lineAt(selection.from)
      const after = view.state.doc.lineAt(selection.to)
      return (
        (before.text
          .slice(0, selection.from - before.from)
          .match(/(?<!\\)\*+$/)?.[0].length ?? 0) %
          2 ===
          1 &&
        (after.text.slice(selection.to - after.from).match(/^\*+/)?.[0]
          .length ?? 0) %
          2 ===
          1
      )
    }
    return (
      !!token &&
      view.state.sliceDoc(
        Math.max(0, selection.from - token.length),
        selection.from,
      ) === token &&
      view.state.sliceDoc(selection.to, selection.to + token.length) === token
    )
  }
  const run = (id: string, values?: InsertValues) => {
    if (!editable() || !supported(id)) return false
    if (id === 'undo' || id === 'redo' || id === 'indent' || id === 'outdent') {
      const done = {
        undo: history?.undo ?? undo,
        redo: history?.redo ?? redo,
        indent: indentMore,
        outdent: indentLess,
      }[id](view)
      view.focus()
      return done
    }
    if (view.state.selection.ranges.length !== 1) return false
    const range = view.state.selection.main
    const doc = view.state.doc
    let from = range.from,
      to = range.to
    const selected = doc.sliceString(from, to)
    let insert = selected,
      start = 0,
      end = selected.length
    const token = marks[id]
    if (format !== 'markdown') {
      const edit = format?.apply(id, selection(values))
      if (!validEdit(edit, doc.length)) return false
      from = edit.from
      to = edit.to
      insert = edit.insert
      start = edit.selection?.from ?? insert.length
      end = edit.selection?.to ?? start
      if (
        ![start, end].every(Number.isInteger) ||
        start < 0 ||
        end < start ||
        end > insert.length
      )
        return false
    } else if (token) {
      if (marked(id)) {
        from -= token.length
        to += token.length
      } else if (
        selected.startsWith(token) &&
        selected.endsWith(token) &&
        selected.length >= token.length * 2 &&
        (id !== 'italic' ||
          ((selected.match(/^\*+/)?.[0].length ?? 0) % 2 === 1 &&
            (selected.match(/(?<!\\)\*+$/)?.[0].length ?? 0) % 2 === 1))
      ) {
        insert = selected.slice(token.length, -token.length)
        end = insert.length
      } else {
        const delimiter =
          id === 'inline-code' ? '`'.repeat(fenceLength(selected)) : token
        const pad = id === 'inline-code' && /^`|`$/.test(selected) ? ' ' : ''
        insert = `${delimiter}${pad}${selected}${pad}${delimiter}`
        start = delimiter.length + pad.length
        end = start + selected.length
      }
    } else if (
      id === 'paragraph' ||
      id.startsWith('heading-') ||
      prefixes[id]
    ) {
      from = doc.lineAt(from).from
      to = doc.lineAt(to > from && doc.lineAt(to).from === to ? to - 1 : to).to
      const lines = doc.sliceString(from, to).split('\n')
      const prefix = id.startsWith('heading-')
        ? `${'#'.repeat(Number(id.slice(-1)))} `
        : (prefixes[id] ?? '')
      const existing =
        /^( {0,3})(?:#{1,6} |[-+*] (?:\[[ xX]\] )?|\d+[.)] |> |-# )/
      const remove =
        !!prefix &&
        lines.every((line) =>
          id === 'numbered-list'
            ? /^\s*\d+[.)] /.test(line)
            : id === 'checklist'
              ? /^\s*[-+*] \[[ xX]\] /.test(line)
              : line.trimStart().startsWith(prefix),
        )
      insert = lines
        .map((line, index) => {
          const body = line.replace(existing, '$1')
          return remove || id === 'paragraph'
            ? body
            : body.replace(
                /^( {0,3})/,
                `$1${id === 'numbered-list' ? `${index + 1}. ` : prefix}`,
              )
        })
        .join('\n')
      start = range.empty
        ? Math.max(
            0,
            Math.min(
              insert.length,
              range.from - from + insert.length - (to - from),
            ),
          )
        : 0
      end = range.empty ? start : insert.length
    } else if (id === 'link' || id === 'image') {
      if (!values) return false
      const label = (
        id === 'image' ? values.alt : selected || values.url
      ).replace(/[\\[\]]/g, '\\$&')
      const url = values.url
        .replace(/\\/g, '\\\\')
        .replace(/[()]/g, '\\$&')
        .replace(/ /g, '%20')
      insert = `${id === 'image' ? '!' : ''}[${label}](${url})`
      end = insert.length
    } else if (id === 'unlink') {
      insert = selected.replace(/\[([^\]]+)\]\((?:\\.|[^)])*\)/g, '$1')
      end = insert.length
    } else {
      const fence = '`'.repeat(fenceLength(selected, 2))
      const block =
        id === 'code-block'
          ? `${fence}\n${selected}\n${fence}`
          : id === 'divider'
            ? '---'
            : id === 'table'
              ? '| column 1 | column 2 |\n| --- | --- |\n|  |  |'
              : null
      if (id === 'hard-break') {
        insert = '  \n'
        start = end = insert.length
      } else if (block !== null) {
        const before =
          from && !doc.sliceString(0, from).endsWith('\n\n')
            ? doc.sliceString(0, from).endsWith('\n')
              ? '\n'
              : '\n\n'
            : ''
        const after =
          to < doc.length && !doc.sliceString(to).startsWith('\n\n')
            ? doc.sliceString(to).startsWith('\n')
              ? '\n'
              : '\n\n'
            : '\n\n'
        insert = before + block + after
        start =
          id === 'code-block' ? before.length + fence.length + 1 : insert.length
        end = id === 'code-block' ? start + selected.length : start
      } else return false
    }
    return applyEdit({ from, to, insert, selection: { from: start, to: end } })
  }
  const inspect = () => {
    const state = view.state
    const range = state.selection.main
    const line =
      format === 'markdown' ? state.doc.lineAt(range.from).text.trimStart() : ''
    let activeSelection: DocumentSelection | undefined
    const selected = () => {
      if (!activeSelection) activeSelection = selection()
      return activeSelection
    }
    return {
      state(id: string, checkPressed = true) {
        if (!supported(id))
          return { supported: false, pressed: false, disabled: true }
        const blockActive = id.startsWith('heading-')
          ? line.startsWith(`${'#'.repeat(Number(id.slice(-1)))} `)
          : id === 'numbered-list'
            ? /^\d+[.)] /.test(line)
            : id === 'bullet-list'
              ? /^[-+*] (?!\[[ xX]\] )/.test(line)
              : id === 'checklist'
                ? /^[-+*] \[[ xX]\] /.test(line)
                : prefixes[id]
                  ? line.startsWith(prefixes[id])
                  : false
        return {
          supported: true,
          pressed:
            checkPressed &&
            (format === 'markdown'
              ? marked(id) || blockActive
              : (format?.isActive?.(id, { ...selected() }) ?? false)),
          disabled:
            state.readOnly ||
            (state.selection.ranges.length !== 1 &&
              !['undo', 'redo', 'indent', 'outdent'].includes(id)) ||
            (id === 'undo'
              ? !(history ? history.state().canUndo : undoDepth(state))
              : id === 'redo'
                ? !(history ? history.state().canRedo : redoDepth(state))
                : id === 'unlink'
                  ? !/\[[^\]]+\]\(/.test(state.sliceDoc(range.from, range.to))
                  : false),
        }
      },
    }
  }
  return {
    focus: () => view.focus(),
    run,
    state(id: string) {
      return inspect().state(id)
    },
    inspect,
    capture(coords?: { x: number; y: number }) {
      const doc = view.state.doc,
        position = coords ? view.posAtCoords(coords) : null,
        selection =
          position == null
            ? view.state.selection
            : EditorSelection.single(position)
      return {
        text: view.state.sliceDoc(selection.main.from, selection.main.to),
        insertMarkdown(insert: string) {
          if (!view.dom.isConnected || view.state.doc !== doc || !editable())
            return false
          const { from, to } = selection.main
          return applyEdit({ from, to, insert })
        },
        insertMedia(items: readonly MediaAttachment[]) {
          if (
            !format ||
            format === 'markdown' ||
            !view.dom.isConnected ||
            view.state.doc !== doc ||
            !editable()
          )
            return false
          let source = doc.toString(),
            from = selection.main.from,
            to = selection.main.to
          for (const [index, values] of items.entries()) {
            if (index) {
              source = source.slice(0, from) + '\n\n' + source.slice(from)
              from += 2
              to = from
            }
            const edit = format.apply(
              /\.(mp4|webm|ogv|mov)$/i.test(values.url) ? 'link' : 'image',
              { source, from, to, values },
            )
            if (!validEdit(edit, source.length)) return false
            source =
              source.slice(0, edit.from) + edit.insert + source.slice(edit.to)
            from = to = edit.from + (edit.selection?.to ?? edit.insert.length)
          }
          return applyEdit({
            from: 0,
            to: doc.length,
            insert: source,
            selection: { from, to },
          })
        },
        run(id: string, values: InsertValues) {
          if (!view.dom.isConnected || view.state.doc !== doc) return false
          view.dispatch({ selection })
          return run(id, values)
        },
      }
    },
  }
}
