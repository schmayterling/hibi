import {
  indentLess,
  indentMore,
  isolateHistory,
  redo,
  redoDepth,
  undo,
  undoDepth,
} from '@codemirror/commands'
import {
  type ChangeSet,
  EditorSelection,
  type EditorState,
  Facet,
  StateEffect,
  StateField,
  Transaction,
  type TransactionSpec,
} from '@codemirror/state'
import { EditorView, type KeyBinding, ViewPlugin } from '@codemirror/view'
import type { SyntaxNode, Tree } from '@lezer/common'
import type {
  DocumentEdit,
  DocumentFormat,
  DocumentSelection,
} from '../../addons/api'
import { inlineCodeInfo } from '../../shared/formatted-markdown.ts'
import {
  markdownLineStarts,
  markdownLiteral,
} from '../../shared/markdown-literal.ts'
import type { MediaAttachment } from '../../shared/media'
import { gapInput } from './formatted-commands.ts'
import {
  formattedDocument,
  formattedPrefix,
  formattedSyntaxTree,
} from './formatted-contributions.ts'
import {
  insertAfterBlock,
  selectBlock,
  selectedBlock,
} from './formatted-text-end.ts'
import {
  caretMarks,
  formattedStates,
  formattingAt,
  formattingBefore,
  unfenceChanges,
  unlinkChanges,
} from './formatted-toolbar-state.ts'
import {
  blockAction,
  formattedInputError,
  inlineAction,
  inlineInput,
  listAction,
  preserveActionSelection,
  quoteAction,
  rejectedInput,
  splitAction,
  typedLiteral,
} from './source-formatting-actions.ts'
import {
  sourceHistoryEffects,
  sourceHistorySelection,
} from './source-session.ts'

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

/** A view's table editing: whether the selection is in a table, and the toolbar's table actions. */
export type TableActions = {
  active: (view: EditorView) => boolean
  run: (view: EditorView, id: string, values?: InsertValues) => boolean
  state?: (
    view: EditorView,
    id: string,
  ) => { pressed: boolean; disabled: boolean } | null
}
export const tableActions = Facet.define<TableActions>()
const tableIds = [
  'row-before',
  'row-after',
  'row-delete',
  'column-before',
  'column-after',
  'column-delete',
  'table-delete',
]
/** Actions that make or change blocks, which a table cell cannot hold. */
const blockIds = [
  'paragraph',
  'subtext',
  'bullet-list',
  'numbered-list',
  'checklist',
  'quote',
  'code-block',
  'divider',
  'table',
  'indent',
  'outdent',
  ...Array.from({ length: 6 }, (_, i) => `heading-${i + 1}`),
]
const inTable = (view: EditorView) =>
  view.state.facet(tableActions).some((actions) => actions.active(view))
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
/** Delimiters the toolbar opened at the caret, with no text between them yet. */
function opened(state: EditorState, pos: number, token: string) {
  const before = state.sliceDoc(Math.max(0, pos - token.length - 1), pos)
  const after = state.sliceDoc(pos, pos + token.length + 1)
  return (
    before.endsWith(token) &&
    after.startsWith(token) &&
    before.at(-token.length - 1) !== token[0] &&
    after[token.length] !== token[0]
  )
}

/**
 * The marks text typed at the formatted view's caret takes, which a toolbar
 * action at the caret sets like the rich editor's stored marks. Typing keeps
 * them; moving the caret or an unrelated edit drops them.
 */
type StoredMarks = {
  pos: number
  marks: readonly string[]
  composition?: { before: StoredMarks; state: EditorState; changes: ChangeSet }
  inline?: { close: string; tail: string }
  code?: {
    from: number
    to: number
    fence: number
    pad: boolean
    first: string
    last: string
    blank: boolean
    head: number | null
    tail: number | null
    longest: number
  }
}
const storeMarks = StateEffect.define<StoredMarks | null>()
const markComposition = StateEffect.define<boolean>()
const storedMarks = StateField.define<StoredMarks | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(storeMarks))
        return transaction.newSelection.main.empty &&
          transaction.newSelection.main.head === effect.value?.pos
          ? effect.value
          : null
      if (effect.is(markComposition)) {
        if (!value) return null
        if (effect.value)
          return {
            ...value,
            composition: {
              before: value,
              state: transaction.startState,
              changes: transaction.changes,
            },
          }
        const composition = value.composition
        if (!composition) return value
        let changed = false
        composition.changes.iterChanges((from, to, _a, _b, inserted) => {
          if (!inserted.eq(composition.state.doc.slice(from, to)))
            changed = true
        })
        return !changed &&
          transaction.newSelection.main.head === composition.before.pos
          ? composition.before
          : null
      }
    }
    const { main } = transaction.newSelection
    if (value?.composition) {
      if (
        (transaction.docChanged &&
          !transaction.isUserEvent('input.type.compose')) ||
        (transaction.selection &&
          !transaction.docChanged &&
          main.head !== value.pos)
      )
        return null
      return {
        ...value,
        pos: main.head,
        composition: {
          ...value.composition,
          changes: value.composition.changes.compose(transaction.changes),
        },
      }
    }
    return value &&
      !transaction.docChanged &&
      main.empty &&
      main.head === value.pos
      ? value
      : null
  },
})
/** The marks a caret action stores, outermost first. */
const storable = ['bold', 'italic', 'strike', 'subscript', 'inline-code']

/** The stored marks at the caret of a formatted view. */
function storedAt(state: EditorState) {
  const stored = state.field(storedMarks, false)
  const { main } = state.selection
  return stored && main.empty && main.head === stored.pos ? stored.marks : null
}

/** Only inspect new text, retaining the run that may join its first backtick. */
function codeRuns(text: string, tail = 0) {
  let longest = 0,
    last = 0
  for (const match of text.matchAll(/`+/g)) {
    const length = match[0].length + (match.index === 0 ? tail : 0)
    longest = Math.max(longest, length)
    last = match.index + match[0].length === text.length ? length : 0
  }
  return { longest, tail: last }
}

/** Keep trailing spaces outside delimiters until more marked text follows. */
function continueInline(
  state: EditorState,
  stored: StoredMarks,
  text: string,
): TransactionSpec {
  const { close, tail } = stored.inline!
  const combined = tail + text
  const trailing = combined.match(/\s+$/u)?.[0] ?? ''
  const value = typedLiteral(
    state,
    combined.slice(0, combined.length - trailing.length),
  )
  const from = stored.pos - tail.length - (tail ? close.length : 0)
  const pos =
    from + value.length + (trailing ? close.length + trailing.length : 0)
  const pending = {
    ...stored,
    pos,
    marks: stored.marks.filter((id) => id !== 'subscript'),
  }
  if (stored.marks.includes('subscript')) delete pending.inline
  else pending.inline = { close, tail: trailing }
  return {
    changes: {
      from,
      to: stored.pos + (tail ? 0 : close.length),
      insert: value + close + trailing,
    },
    selection: EditorSelection.cursor(pos),
    effects: storeMarks.of(pending),
    userEvent: 'input.type',
    scrollIntoView: true,
  }
}

/** Use the parser's summary; ordinary input only needs the span's edges. */
function storedCode(
  state: EditorState,
  stored: StoredMarks,
  node: SyntaxNode,
): StoredMarks {
  const first = node.firstChild!,
    last = node.lastChild!
  const info = first.prop(inlineCodeInfo)
  // A contributed replacement for InlineCode may not supply the core summary.
  const raw = info
    ? ''
    : state.sliceDoc(first.to, last.from).replace(/\n/g, ' ')
  const blank = info?.blank ?? /^ *$/.test(raw)
  const char = (pos: number) => state.sliceDoc(pos, pos + 1).replace('\n', ' ')
  const pad = !blank && char(first.to) === ' ' && char(last.from - 1) === ' '
  const from = first.to + Number(pad),
    to = last.from - Number(pad)
  const pos = Math.max(from, Math.min(stored.pos, to))
  const longest = info?.longest ?? codeRuns(raw).longest
  const adjacent = (at: number) =>
    char(at) === '`' ? (longest === 1 ? 1 : null) : 0
  return {
    ...stored,
    pos,
    code: {
      from: node.from,
      to,
      fence: first.to - first.from,
      pad,
      first: char(from),
      last: char(to - 1),
      blank,
      head: pos === to ? 0 : adjacent(pos),
      tail: pos === from ? 0 : adjacent(pos - 1),
      longest,
    },
  }
}

/** Only a newly typed backtick needs the adjoining run, never the rest of the span. */
function codeRun(
  state: EditorState,
  at: number,
  limit: number,
  maximum = Infinity,
) {
  const direction = at < limit ? 1 : -1
  limit = at + direction * Math.min(Math.abs(limit - at), maximum)
  let length = 0
  while (at !== limit) {
    const end = at + direction * Math.min(64, Math.abs(limit - at))
    const text = state.sliceDoc(Math.min(at, end), Math.max(at, end))
    const run = text.match(direction === 1 ? /^`*/ : /`*$/)![0].length
    length += run
    if (run !== text.length) break
    at = end
  }
  return length
}

/** Extend our code span by editing only its fences and the text at the caret. */
function continueCode(
  state: EditorState,
  stored: StoredMarks,
  text: string,
): TransactionSpec {
  const code = stored.code!
  const oldOpen = code.fence + Number(code.pad)
  const tail = text.startsWith('`')
    ? (code.tail ?? codeRun(state, stored.pos, code.from + oldOpen))
    : 0
  const head = text.endsWith('`')
    ? (code.head ?? codeRun(state, stored.pos, code.to))
    : code.head
  const runs = codeRuns(text, tail)
  const longest = Math.max(code.longest, runs.longest, runs.tail + (head ?? 0))
  // Splitting an existing run can create a closing fence even without typing a backtick.
  const split =
    !runs.longest &&
    code.longest >= code.fence &&
    code.head !== 0 &&
    code.tail !== 0 &&
    ((code.tail ??
      codeRun(state, stored.pos, code.from + oldOpen, code.fence + 1)) ===
      code.fence ||
      (code.head ?? codeRun(state, stored.pos, code.to, code.fence + 1)) ===
        code.fence)
  const fence =
    runs.longest || split ? Math.max(code.fence, longest + 1) : code.fence
  const first = stored.pos === code.from + oldOpen ? text.charAt(0) : code.first
  const last = stored.pos === code.to ? text.charAt(text.length - 1) : code.last
  const blank = code.blank && /^ *$/.test(text)
  const pad =
    first === '`' || last === '`' || (!blank && first === ' ' && last === ' ')
  const open = '`'.repeat(fence) + (pad ? ' ' : '')
  const close = (pad ? ' ' : '') + '`'.repeat(fence)
  const shift = text.length + open.length - oldOpen
  const pos = stored.pos + shift
  return {
    changes: [
      { from: code.from, to: code.from + oldOpen, insert: open },
      { from: stored.pos, insert: text },
      { from: code.to, to: code.to + oldOpen, insert: close },
    ],
    selection: EditorSelection.cursor(pos),
    effects: storeMarks.of({
      ...stored,
      pos,
      code: {
        ...code,
        to: code.to + shift,
        fence,
        pad,
        first,
        last,
        blank,
        longest,
        head,
        tail: runs.tail,
      },
    }),
    userEvent: 'input.type',
    scrollIntoView: true,
  }
}

/**
 * `text` typed with the caret's stored marks. Formatting the text leaves
 * closes before it and opens again after it; formatting it takes wraps it,
 * with its outer spaces outside, as the rich editor saved them.
 */
function storedInput(
  state: EditorState,
  tree: Tree,
  stored: StoredMarks,
  text: string,
): TransactionSpec | null {
  if (stored.code) return continueCode(state, stored, text)
  if (stored.inline) return continueInline(state, stored, text)
  let at = stored.pos,
    close = '',
    reopen = '',
    kept = false
  const current = formattingAt(state, tree, at)
  if (stored.marks.includes('inline-code')) {
    const before = current.has('inline-code')
      ? null
      : formattingBefore(state, tree, at, 'inline-code')
    const node =
      current.get('inline-code') ??
      (before && formattingAt(state, tree, before.to).get('inline-code'))
    if (node) return continueCode(state, storedCode(state, stored, node), text)
  }
  if (
    !current.has('inline-code') &&
    stored.marks.every((id) => current.has(id))
  ) {
    let end = at,
      suffix = ''
    for (const [id, node] of current) {
      const last = node.lastChild
      if (!stored.marks.includes(id) || last?.from !== end) break
      suffix += state.sliceDoc(last.from, last.to)
      end = last.to
    }
    if (suffix)
      return continueInline(
        state,
        { ...stored, inline: { close: suffix, tail: '' } },
        text,
      )
  }
  // Innermost first, like the formatting a line break closes and opens.
  for (const [id, node] of current) {
    if (stored.marks.includes(id)) {
      kept = true
      continue
    }
    const first = node.firstChild,
      last = node.lastChild
    // Kept formatting inside it would have to close and open around the text too.
    if (kept || !first || !last) return null
    if (at === first.to) at = node.from
    else if (at === last.from) at = node.to
    else {
      close += state.sliceDoc(last.from, last.to)
      reopen = state.sliceDoc(first.from, first.to) + reopen
    }
  }
  const core = text.trim()
  let add = storable.filter(
    (id) => stored.marks.includes(id) && !current.has(id),
  )
  const joined =
    add.length === 1 && !close && !reopen && core
      ? formattingBefore(state, tree, at, add[0] as string)
      : null
  if (joined) {
    // Text next to the same formatting joins it rather than opening its own.
    at = joined.to
    add = []
  }
  const lead = core ? text.slice(0, text.indexOf(core)) : text
  const trail = core ? text.slice(lead.length + core.length) : ''
  const code = add.includes('inline-code') && !!core
  const value = code
    ? text.slice(lead.length)
    : stored.marks.includes('inline-code')
      ? core
      : typedLiteral(state, core)
  const pad = code && (value.startsWith('`') || value.endsWith('`')) ? ' ' : ''
  const delimiters = add.map((id) =>
    id === 'inline-code' ? '`'.repeat(fenceLength(value)) : marks[id],
  )
  const open = delimiters.join('') + pad
  const shut = pad + delimiters.toReversed().join('')
  const typed = core ? lead + open + value + shut + (code ? '' : trail) : text
  const insert = close + typed + reopen
  const keep = !code && add.length > 0 && (!core || !!trail)
  let caret =
    at + close.length + (keep ? typed.length : typed.length - shut.length)
  const pending: StoredMarks = {
    pos: caret,
    marks: stored.marks.filter((id) => id !== 'subscript'),
  }
  if (core && shut && !code && !stored.marks.includes('subscript'))
    pending.inline = { close: shut, tail: trail }
  if (code) {
    const runs = codeRuns(value)
    pending.code = {
      from: at + close.length + lead.length,
      to: caret,
      fence: fenceLength(value),
      pad: !!pad,
      first: value.charAt(0),
      last: value.charAt(value.length - 1),
      blank: false,
      head: 0,
      ...runs,
    }
  }
  const gap = gapInput(state, tree, at, at, insert)
  if (gap) {
    const shift = state.doc.lineAt(at).from + 1 - at
    caret += shift
    pending.pos = caret
    if (pending.code) {
      pending.code.from += shift
      pending.code.to += shift
    }
  }
  return {
    ...(gap ?? { changes: { from: at, insert }, userEvent: 'input.type' }),
    selection: EditorSelection.cursor(caret),
    effects: storeMarks.of(pending),
    scrollIntoView: true,
  }
}

/** Format only the committed native composition, without redrawing its candidates. */
function finishStoredComposition(view: EditorView) {
  const composition = view.state.field(storedMarks)?.composition
  if (!composition || view.composing || view.compositionStarted) return
  const { before, state, changes } = composition
  let text = '',
    valid = true
  changes.iterChanges((from, to, _a, _b, inserted) => {
    if (from !== before.pos || from !== to) valid = false
    text += inserted.toString()
  })
  const { main } = view.state.selection
  const tree = formattedSyntaxTree(state)
  const spec =
    valid &&
    text &&
    !/[\r\n]/.test(text) &&
    !view.state.readOnly &&
    main.empty &&
    main.head === before.pos + text.length &&
    tree
      ? storedInput(state, tree, before, text)
      : null
  if (!spec) {
    view.dispatch({ effects: markComposition.of(false) })
    return
  }
  view.dispatch({
    ...spec,
    changes: changes.invert(state.doc).compose(state.changes(spec.changes)),
    userEvent: 'input.type.compose',
  })
}

type WholeSelection = {
  from: number
  selection: EditorSelection
  document: { tabId: string | null; revision: number }
}
const storeWholeSelection = StateEffect.define<WholeSelection | null>()
function wholeSelectionAt(state: EditorState): WholeSelection | null {
  const { main } = state.selection
  if (main.empty || main.to !== state.doc.length) return null
  let body = 0
  for (const prefix of state.facet(formattedPrefix))
    body = Math.max(body, prefix(state))
  body = Math.min(body, state.doc.length)
  return main.from === 0 || main.from === body
    ? {
        from: body,
        selection: state.selection,
        document: state.facet(formattedDocument),
      }
    : null
}
const ownsWholeSelection = (value: WholeSelection, state: EditorState) => {
  const owner = state.facet(formattedDocument)
  return (
    value.document.tabId === owner.tabId &&
    value.document.revision === owner.revision
  )
}
const wholeSelection = StateField.define<WholeSelection | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects)
      if (effect.is(storeWholeSelection)) {
        const restored = effect.value
        return restored &&
          ownsWholeSelection(restored, transaction.state) &&
          restored.selection.eq(transaction.newSelection)
          ? restored
          : null
      }
    if (value && !ownsWholeSelection(value, transaction.state)) value = null
    if (transaction.docChanged)
      return value &&
        transaction.isUserEvent('input.format') &&
        !transaction.newSelection.main.empty
        ? {
            ...value,
            from: transaction.changes.mapPos(value.from, -1),
            selection: transaction.newSelection,
          }
        : null
    if (!transaction.selection) return value
    if (transaction.isUserEvent('select.all'))
      return wholeSelectionAt(transaction.state)
    return transaction.isUserEvent('input.format') &&
      value?.selection.eq(transaction.newSelection)
      ? value
      : null
  },
})

/** Physical keys replace a whole-note selection as a document; direct text input keeps its block context. */
export const wholeSelectionInput = [
  wholeSelection,
  sourceHistoryEffects.of((state) => {
    const whole = state.field(wholeSelection)
    if (!whole) return [storeWholeSelection.of(null)]
    const { tabId, revision } = whole.document
    return [
      storeWholeSelection.of(whole),
      sourceHistorySelection.of((current, selection) => {
        const owner = current.facet(formattedDocument),
          selected = current.field(wholeSelection, false)
        return owner.tabId === tabId &&
          owner.revision === revision &&
          !selected?.selection.eq(current.selection)
          ? EditorSelection.single(selection.main.to)
          : selection
      }),
    ]
  }),
  EditorView.domEventHandlers({
    keypress(event, view) {
      const { state } = view
      const whole = state.field(wholeSelection)
      if (
        !whole ||
        !whole.selection.eq(state.selection) ||
        !ownsWholeSelection(whole, state) ||
        state.readOnly ||
        !state.facet(EditorView.editable) ||
        !view.hasFocus ||
        event.target !== view.contentDOM ||
        event.defaultPrevented ||
        view.composing ||
        view.compositionStarted ||
        event.isComposing ||
        !event.charCode ||
        (event.ctrlKey && !event.altKey) ||
        event.metaKey ||
        event.key === 'Dead' ||
        event.key === 'Process'
      )
        return false
      const text = String.fromCodePoint(event.charCode)
      if (/[\r\n\t]/.test(text)) return false
      const literal = markdownLineStarts(markdownLiteral(text))
      event.preventDefault()
      const insert = () =>
        state.update({
          changes: { from: whole.from, to: state.doc.length, insert: literal },
          selection: EditorSelection.cursor(whole.from + literal.length),
          userEvent: 'input.type',
          scrollIntoView: true,
        })
      // Input handlers, an addon's among them, see the typing first.
      if (
        !state
          .facet(EditorView.inputHandler)
          .some((handler) =>
            handler(view, whole.from, state.doc.length, text, insert),
          )
      )
        view.dispatch(insert())
      return true
    },
  }),
]

/** Stored marks for a formatted view, which wrap the text typed next at their caret. */
export const storedMarkInput = [
  storedMarks,
  sourceHistoryEffects.of((state) => {
    const stored = state.field(storedMarks)
    return [storeMarks.of(stored?.composition?.before ?? stored)]
  }),
  ViewPlugin.fromClass(
    class {
      frame = 0
      destroy() {
        cancelAnimationFrame(this.frame)
        this.frame = 0
      }
    },
    {
      eventObservers: {
        compositionstart(_event, view) {
          cancelAnimationFrame(this.frame)
          this.frame = 0
          if (view.state.field(storedMarks))
            view.dispatch({ effects: markComposition.of(true) })
        },
        compositionend(_event, view) {
          const frame = requestAnimationFrame(() => {
            this.frame = 0
            finishStoredComposition(view)
          })
          this.frame = frame
          // The native observer flushes its last candidate after this event.
          queueMicrotask(() =>
            queueMicrotask(() => {
              if (this.frame === frame) finishStoredComposition(view)
            }),
          )
        },
      },
    },
  ),
  EditorView.inputHandler.of((view, from, to, text) => {
    if (view.state.readOnly) return false
    let stored = view.state.field(storedMarks)
    if (
      stored?.composition &&
      !view.composing &&
      !view.compositionStarted &&
      from === to &&
      from === stored.pos
    ) {
      finishStoredComposition(view)
      stored = view.state.field(storedMarks)
      from = to = view.state.selection.main.head
    }
    const tree = formattedSyntaxTree(view.state)
    if (
      tree &&
      !view.composing &&
      !view.compositionStarted &&
      (from !== to || !stored)
    ) {
      let spec: TransactionSpec | null
      try {
        spec = inlineInput(view.state, tree, from, to, text)
      } catch (error) {
        if (!(error instanceof Error) || error.cause !== formattedInputError)
          throw error
        view.dispatch({ annotations: rejectedInput.of(error) })
        return true
      }
      if (spec) {
        view.dispatch(spec)
        return true
      }
    }
    if (
      !stored ||
      !tree ||
      view.composing ||
      view.compositionStarted ||
      from !== stored.pos ||
      to !== from ||
      /[\r\n]/.test(text)
    )
      return false
    const spec = storedInput(view.state, tree, stored, text)
    if (!spec) return false
    view.dispatch(spec)
    return true
  }),
]

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
    if (
      !editable() ||
      !supported(id) ||
      ((id === 'link' || id === 'image') && !values)
    )
      return false
    if (blockIds.includes(id) && inTable(view)) return false
    if (
      id === 'undo' ||
      id === 'redo' ||
      ((id === 'indent' || id === 'outdent') &&
        (!formattedSyntaxTree(view.state) ||
          view.state.selection.ranges.length !== 1))
    ) {
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
    // A table writes a cell's line break as `<br>`.
    if (tableIds.includes(id) || (id === 'hard-break' && inTable(view)))
      return view.state
        .facet(tableActions)
        .some((actions) => actions.run(view, id))
    if (inTable(view) && [...storable, 'link', 'unlink'].includes(id)) {
      const done = view.state
        .facet(tableActions)
        .some((actions) => actions.run(view, id, values))
      if (done || view.state.selection.main.empty) return done
    }
    const range = view.state.selection.main
    const doc = view.state.doc
    const tree = format === 'markdown' ? formattedSyntaxTree(view.state) : null
    if (
      tree &&
      formattedStates(view.state, tree, range, storedAt(view.state)).disabled(
        id,
      )
    )
      return false
    if (
      range.empty &&
      tree &&
      storable.includes(id) &&
      view.state.field(storedMarks, false) !== undefined &&
      !inTable(view)
    ) {
      // Like the rich editor, a caret action formats the text typed next.
      const current = storedAt(view.state) ?? [
        ...caretMarks(view.state, tree, range.head).keys(),
      ]
      view.dispatch({
        effects: storeMarks.of({
          pos: range.head,
          marks: current.includes(id)
            ? current.filter((mark) => mark !== id)
            : id === 'inline-code'
              ? [id]
              : [...current, id],
        }),
      })
      view.focus()
      return true
    }
    const inline = tree && inlineAction(view.state, tree, id, values?.url)
    if (inline) {
      view.dispatch({
        ...inline,
        annotations: [
          Transaction.userEvent.of('input.format'),
          isolateHistory.of('full'),
        ],
        scrollIntoView: true,
      })
      view.focus()
      return true
    }
    // The formatted view removes links and code fences by their syntax, as the rich editor does.
    const structural =
      tree && id === 'unlink'
        ? unlinkChanges(view.state, tree, range)
        : tree &&
            id === 'code-block' &&
            formattedStates(view.state, tree, range).pressed(id)
          ? unfenceChanges(tree, range)
          : null
    if (structural) {
      // An action with nothing to change still returns focus to the note, like any action.
      if (!structural.length) {
        view.focus()
        return false
      }
      view.dispatch({
        changes: structural,
        annotations: [
          Transaction.userEvent.of('input.format'),
          isolateHistory.of('full'),
        ],
        scrollIntoView: true,
      })
      view.focus()
      return true
    }
    // As over the rich editor's node selection, a block selected whole
    // takes a divider after it, and stays selected in its quote.
    const held = tree && selectedBlock(view.state)
    if (held && id === 'divider') {
      view.dispatch({
        ...insertAfterBlock(view.state, tree, held, true),
        annotations: [
          Transaction.userEvent.of('input.format'),
          isolateHistory.of('full'),
        ],
        scrollIntoView: true,
      })
      view.focus()
      return true
    }
    const block =
      tree &&
      (blockAction(view.state, tree, id) ??
        splitAction(view.state, tree, id) ??
        listAction(view.state, tree, id) ??
        (id === 'quote' ? quoteAction(view.state, tree) : null))
    if (block) {
      // A quote adds its marks at line starts: the block's ends keep their
      // distance from their lines' ends.
      const after = held && view.state.changes(block.changes).apply(doc)
      const kept = (at: number) =>
        after!.line(doc.lineAt(at).number).to - (doc.lineAt(at).to - at)
      view.dispatch({
        ...preserveActionSelection(view.state, tree!, block),
        ...(held && selectBlock(kept(held.from), kept(held.to))),
        annotations: [
          Transaction.userEvent.of('input.format'),
          isolateHistory.of('full'),
        ],
        scrollIntoView: true,
      })
      view.focus()
      return true
    }
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
      // A view that edits tables in place inserts the rich editor's table: a
      // header and two empty rows, with the caret in the first header cell.
      const cells = id === 'table' && view.state.facet(tableActions).length > 0
      const block =
        id === 'code-block'
          ? `${fence}\n${selected}\n${fence}`
          : id === 'divider'
            ? '---'
            : cells
              ? '|  |  |\n| --- | --- |\n|  |  |\n|  |  |'
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
          id === 'code-block'
            ? before.length + fence.length + 1
            : cells
              ? before.length + 2
              : insert.length
        end = id === 'code-block' ? start + selected.length : start
      } else return false
    }
    // An action that changes no Markdown leaves the note unedited.
    if (format === 'markdown' && insert === doc.sliceString(from, to)) {
      view.focus()
      return false
    }
    return applyEdit({ from, to, insert, selection: { from: start, to: end } })
  }
  const inspect = () => {
    const state = view.state
    const range = state.selection.main
    const tree = format === 'markdown' ? formattedSyntaxTree(state) : null
    // The formatted view reads its syntax tree; a source pane reads the selection's line.
    const stored = tree ? storedAt(state) : null
    const formatted = tree && formattedStates(state, tree, range, stored)
    const line =
      format === 'markdown' && !formatted
        ? state.doc.lineAt(range.from).text.trimStart()
        : ''
    let activeSelection: DocumentSelection | undefined
    const selected = () => {
      if (!activeSelection) activeSelection = selection()
      return activeSelection
    }
    const table = inTable(view)
    return {
      /** The selection is in a table whose actions this view runs. */
      table,
      state(id: string, checkPressed = true) {
        if (!supported(id))
          return { supported: false, pressed: false, disabled: true }
        if (tableIds.includes(id))
          return {
            supported: true,
            pressed: false,
            disabled:
              state.readOnly || !table || state.selection.ranges.length !== 1,
          }
        const cellState =
          table && [...storable, 'link', 'unlink'].includes(id)
            ? state
                .facet(tableActions)
                .map((actions) => actions.state?.(view, id))
                .find(Boolean)
            : null
        if (cellState)
          return {
            supported: true,
            ...cellState,
            disabled: state.readOnly || cellState.disabled,
          }
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
            (formatted
              ? formatted.pressed(id) ||
                // Delimiters typed in code are its text, not an open mark.
                (!stored &&
                  range.empty &&
                  !!marks[id] &&
                  !formatted.disabled(id) &&
                  opened(state, range.from, marks[id]))
              : format === 'markdown'
                ? marked(id) || blockActive
                : (format?.isActive?.(id, { ...selected() }) ?? false)),
          disabled:
            state.readOnly ||
            (table && blockIds.includes(id)) ||
            (state.selection.ranges.length !== 1 &&
              !['undo', 'redo', 'indent', 'outdent'].includes(id)) ||
            (id === 'undo'
              ? !(history ? history.state().canUndo : undoDepth(state))
              : id === 'redo'
                ? !(history ? history.state().canRedo : redoDepth(state))
                : formatted
                  ? formatted.disabled(id)
                  : id === 'unlink' &&
                    !/\[[^\]]+\]\(/.test(state.sliceDoc(range.from, range.to))),
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
