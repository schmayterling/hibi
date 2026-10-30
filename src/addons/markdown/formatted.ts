import {
  type ChangeDesc,
  ChangeSet,
  EditorSelection,
  EditorState,
  MapMode,
  StateEffect,
  StateField,
  type Text,
  Transaction,
} from '@codemirror/state'
import { type EditorView, ViewPlugin, WidgetType } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { documentRuntime } from '../../renderer/src/document-runtime.ts'
import {
  type FormattedContribution,
  formattedDocument,
  formattedRenderInputs,
  formattedSyntaxTree,
} from '../../renderer/src/formatted-contributions.ts'
import { formattedAlertText } from '../../shared/formatted-text-rules.ts'
import { GithubAlerts } from '../../shared/markdown-extra-syntax.ts'
import { alertMarker, alertType } from './alerts.ts'
import { calloutToggle, updateCalloutToggle } from './callout-toggle.ts'
import './formatted.css'

export { GithubAlerts } from '../../shared/markdown-extra-syntax.ts'

type Fold = { fold: string; expanded: boolean }
const setFold = StateEffect.define<Fold & { from: number }>()

function mapFolds(
  at: ReadonlyMap<number, Fold>,
  changes: ChangeDesc,
  keep = (_from: number, _pos: number) => true,
) {
  const mapped = new Map<number, Fold>()
  for (const [from, fold] of at) {
    // A callout whose first character goes takes its state with it.
    const pos = changes.mapPos(from, 1, MapMode.TrackAfter)
    if (pos !== null && keep(from, pos)) mapped.set(pos, fold)
  }
  return mapped
}

/** The text from `a` to `b` as one change, between their common start and end. */
function textChange(a: string, b: string) {
  const length = Math.min(a.length, b.length)
  let from = 0,
    end = 0
  while (from < length && a.charCodeAt(from) === b.charCodeAt(from)) from++
  while (
    end < length - from &&
    a.charCodeAt(a.length - 1 - end) === b.charCodeAt(b.length - 1 - end)
  )
    end++
  return ChangeSet.of(
    { from, to: a.length - end, insert: b.slice(from, b.length - end) },
    a.length,
  )
}

/**
 * Fold states of each open tab's last formatted view, for the session. Its
 * next view, after a tab switch or a reload of its file, starts with them,
 * mapped through the text that changed meanwhile. A closed tab's entry goes
 * with it.
 */
const kept = new Map<string, { doc: Text; at: ReadonlyMap<number, Fold> }>()
documentRuntime.subscribeCatalog(() => {
  for (const tabId of kept.keys())
    if (!documentRuntime.session(tabId)) kept.delete(tabId)
})

/**
 * Fold states set by the reader, by callout start. Renderers read `key`,
 * which only a toggle replaces, so edits that move callouts keep cached
 * layout and table cells.
 */
const folds = StateField.define<{
  at: ReadonlyMap<number, Fold>
  key: object
}>({
  create(state) {
    const { tabId } = state.facet(formattedDocument)
    const saved = tabId === null ? undefined : kept.get(tabId)
    if (!saved) return { at: new Map(), key: {} }
    if (saved.doc.eq(state.doc)) return { at: saved.at, key: {} }
    // The text can have changed meanwhile, as when a clean tab reloads its
    // file. A state stays with a title that still reads the same, not with
    // the next callout when the change moved it into this one's place.
    const change = textChange(saved.doc.toString(), state.doc.toString())
    const at = mapFolds(
      saved.at,
      change,
      (from, pos) => state.doc.lineAt(pos).text === saved.doc.lineAt(from).text,
    )
    return { at, key: {} }
  },
  update(value, transaction) {
    let { at, key } = value
    if (transaction.docChanged && at.size)
      at = mapFolds(at, transaction.changes)
    for (const effect of transaction.effects)
      if (effect.is(setFold)) {
        at = new Map(at).set(effect.value.from, effect.value)
        key = {}
      }
    return at === value.at ? value : { at, key }
  },
  provide: (field) => [
    formattedRenderInputs.compute([field], (state) => state.field(field).key),
    ViewPlugin.define((view) => ({
      destroy() {
        const { tabId } = view.state.facet(formattedDocument)
        const at = view.state.field(field, false)?.at
        // A closing tab's view goes after its document; nothing to keep for.
        if (tabId === null || !at || !documentRuntime.session(tabId)) return
        if (at.size) kept.set(tabId, { doc: view.state.doc, at })
        else kept.delete(tabId)
      },
    })),
  ],
})

function expandedAt(state: EditorState, from: number, fold: string) {
  const saved = state.field(folds, false)?.at.get(from)
  return saved?.fold === fold ? saved.expanded : fold !== '-'
}

/** What a folded callout hides: from the end of its title line to its end. */
function foldedBody(state: EditorState, quote: SyntaxNode) {
  const title = firstBlock(quote)
  if (title?.name !== 'AlertTitle') return null
  const fold = titleOf(state.sliceDoc(title.from, title.to))?.fold
  if (!fold || expandedAt(state, quote.from, fold)) return null
  const from = state.doc.lineAt(title.to).to
  return from < quote.to ? { from, to: quote.to, fold } : null
}

/**
 * A selection end inside a folded body shows it, as find, the outline and
 * undo place one there, and so does one at its hidden end, where typing
 * would go into it.
 */
const revealFolds = EditorState.transactionExtender.of((transaction) => {
  const { state } = transaction
  const tree = formattedSyntaxTree(state)
  if (!tree) return null
  const effects: StateEffect<Fold & { from: number }>[] = []
  for (const range of state.selection.ranges)
    for (const pos of [range.anchor, range.head])
      for (
        let node: SyntaxNode | null = tree.resolve(pos, -1);
        node;
        node = node.parent
      ) {
        const body = node.name === 'Blockquote' && foldedBody(state, node)
        if (body && body.from < pos && pos <= body.to)
          effects.push(
            setFold.of({ from: node.from, fold: body.fold, expanded: true }),
          )
      }
  return effects.length ? { effects } : null
})

/**
 * A caret that nothing the reader did puts at a folded body's hidden end,
 * as the open caret of a note that ends in a folded callout, rests at the
 * title's end instead, where it shows and the callout stays folded. The
 * reader's own moves there show the body.
 */
const stayFolded = EditorState.transactionFilter.of((transaction) => {
  const { startState, selection } = transaction
  const tree =
    !transaction.docChanged &&
    transaction.annotation(Transaction.userEvent) === undefined &&
    formattedSyntaxTree(startState)
  if (!selection || !tree) return transaction
  // Nested callouts share their end. The outermost folded title shows; an
  // inner one sits in that body, where the caret would show it.
  const out = (pos: number) => {
    let to = pos
    for (
      let node: SyntaxNode | null = tree.resolve(pos, -1);
      node;
      node = node.parent
    ) {
      const body = node.name === 'Blockquote' && foldedBody(startState, node)
      if (body && pos === body.to) to = body.from
    }
    return to
  }
  let moved = false
  const ranges = selection.ranges.map((range) => {
    const anchor = out(range.anchor),
      head = out(range.head)
    if (anchor === range.anchor && head === range.head) return range
    moved = true
    return EditorSelection.range(anchor, head)
  })
  return moved
    ? [
        transaction,
        { selection: EditorSelection.create(ranges, selection.mainIndex) },
      ]
    : transaction
})

/**
 * Backspace or Delete beside a folded body, which would remove its hidden
 * text or pull the next line into it, shows the body instead, as the caret
 * reaching a fold does in Obsidian. The next press deletes what shows.
 */
const unfoldToDelete = EditorState.transactionFilter.of((transaction) => {
  const { startState } = transaction
  const tree =
    transaction.docChanged &&
    (transaction.isUserEvent('delete.backward') ||
      transaction.isUserEvent('delete.forward')) &&
    startState.selection.ranges.every((range) => range.empty) &&
    formattedSyntaxTree(startState)
  if (!tree) return transaction
  const effects: StateEffect<Fold & { from: number }>[] = []
  transaction.changes.iterChangedRanges((from, to) => {
    for (const [pos, side] of [
      [from - 1, -1],
      [from, 1],
      [to, -1],
    ] as const)
      for (
        let node: SyntaxNode | null = tree.resolve(Math.max(0, pos), side);
        node;
        node = node.parent
      ) {
        const body = node.name === 'Blockquote' && foldedBody(startState, node)
        if (body && from <= body.to + 1 && to > body.from)
          effects.push(
            setFold.of({ from: node.from, fold: body.fold, expanded: true }),
          )
      }
  })
  return effects.length ? { effects } : transaction
})

/** Fold or unfold the callout whose title starts where `button` is; folding moves the selection out of it. */
function toggleFold(view: EditorView, button: HTMLElement) {
  const { state } = view
  const at = view.posAtDOM(button)
  let quote = formattedSyntaxTree(state)?.resolve(at, 1) ?? null
  while (quote && quote.name !== 'Blockquote') quote = quote.parent
  const title = quote && firstBlock(quote)
  const fold =
    title?.from === at && titleOf(state.sliceDoc(title.from, title.to))?.fold
  if (!quote || !title || !fold) return
  const expanded = !expandedAt(state, quote.from, fold)
  const end = state.doc.lineAt(title.to).to
  const to = quote.to
  const out = (pos: number) => (pos > end && pos <= to ? end : pos)
  view.dispatch({
    effects: setFold.of({ from: quote.from, fold, expanded }),
    selection: expanded
      ? undefined
      : EditorSelection.create(
          state.selection.ranges.map((range) =>
            EditorSelection.range(out(range.anchor), out(range.head)),
          ),
          state.selection.mainIndex,
        ),
  })
}

class FoldToggleWidget extends WidgetType {
  readonly title: string
  readonly expanded: boolean
  constructor(title: string, expanded: boolean) {
    super()
    this.title = title
    this.expanded = expanded
  }
  override eq(other: FoldToggleWidget) {
    return this.title === other.title && this.expanded === other.expanded
  }
  toDOM(view: EditorView) {
    const button = calloutToggle(this.title, this.expanded, () =>
      toggleFold(view, button),
    )
    return button
  }
  override updateDOM(dom: HTMLElement, view: EditorView) {
    updateCalloutToggle(
      dom as HTMLButtonElement,
      this.title,
      this.expanded,
      () => toggleFold(view, dom),
    )
    return true
  }
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

/** A callout type's color, its own inside another callout's too. */
const alertColor = (type: string) =>
  `var(--hibi-alert-${type}, var(--status-info))`

/** The alert type of a title line's source. */
export function titleOf(source: string) {
  const marker = alertMarker(source)
  if (!marker) return null
  const type = alertType(marker[1]) ?? 'note'
  return { type, text: formattedAlertText(source), fold: marker[2] ?? '' }
}

/** The quote's first block. */
function firstBlock(quote: SyntaxNode) {
  // A lookup after the first quote marker, not a walk over the quote's children.
  const mark = quote.firstChild
  return mark ? quote.childAfter(mark.to) : null
}

export const contribution: FormattedContribution = {
  id: 'markdown.alerts',
  feature: 'markdown.alerts',
  flavor: 'markdown.github',
  syntax: GithubAlerts,
  extension: [folds, stayFolded, revealFolds, unfoldToDelete],
  views: [
    {
      // The alerts.css box: a 3px bar in the alert color over a 6% tint, 12px 16px inside.
      nodes: ['Blockquote'],
      layout(node, out, { state }) {
        const body = foldedBody(state, node.node)
        if (!body) return
        out.replace(body.from, body.to, undefined, { block: true })
        return false
      },
      container(node, { state }) {
        const title = firstBlock(node.node)
        if (title?.name !== 'AlertTitle') return undefined
        const type =
          titleOf(state.sliceDoc(title.from, title.to))?.type ?? 'note'
        const color = alertColor(type)
        const tint = `color-mix(in srgb, ${color} 6%, transparent)`
        return {
          width: '19px',
          class: `hibi-lp-alert hibi-lp-alert-${type}`,
          paint: (left, top, right, bottom) =>
            [
              `linear-gradient(${color}, ${color}) ${left} ${top} / 3px calc(100% - ${top} - ${bottom}) no-repeat`,
              `linear-gradient(${tint}, ${tint}) ${left} ${top} / calc(100% - ${left} - ${right}) calc(100% - ${top} - ${bottom}) no-repeat`,
            ].join(', '),
          padding: { top: 12, bottom: 12, right: 16 },
        }
      },
    },
    {
      nodes: ['AlertTitle'],
      // The title's margin below it, var(--space-2).
      space: { top: 0, bottom: 8 },
      decorate(node, out, { state, revealed }) {
        const title = titleOf(state.sliceDoc(node.from, node.to))
        if (!title) return false
        out.line(state.doc.lineAt(node.from).from, {
          class: 'hibi-lp-alert-title',
          style: `color: ${alertColor(title.type)}`,
        })
        const mark = node.node.getChild('AlertMark')
        if (revealed) {
          if (mark) out.mark(mark.from, mark.to, { class: 'hibi-lp-marker' })
        } else out.replace(node.from, node.to, new AlertTitleWidget(title.text))
        const quote = node.node.parent
        if (title.fold && quote?.name === 'Blockquote')
          out.widget(
            node.from,
            new FoldToggleWidget(
              title.text,
              expandedAt(state, quote.from, title.fold),
            ),
            -1,
          )
        return false
      },
    },
  ],
}
