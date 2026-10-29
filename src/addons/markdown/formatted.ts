import {
  EditorSelection,
  EditorState,
  MapMode,
  StateEffect,
  StateField,
} from '@codemirror/state'
import { type EditorView, WidgetType } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import {
  type FormattedContribution,
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
/**
 * Fold states set by the reader, by callout start. Renderers read `key`,
 * which only a toggle replaces, so edits that move callouts keep cached
 * layout and table cells.
 */
const folds = StateField.define<{
  at: ReadonlyMap<number, Fold>
  key: object
}>({
  create: () => ({ at: new Map(), key: {} }),
  update(value, transaction) {
    let { at, key } = value
    if (transaction.docChanged && at.size) {
      const mapped = new Map<number, Fold>()
      for (const [from, fold] of at) {
        // A callout whose first character goes takes its state with it.
        const pos = transaction.changes.mapPos(from, 1, MapMode.TrackAfter)
        if (pos !== null) mapped.set(pos, fold)
      }
      at = mapped
    }
    for (const effect of transaction.effects)
      if (effect.is(setFold)) {
        at = new Map(at).set(effect.value.from, effect.value)
        key = {}
      }
    return at === value.at ? value : { at, key }
  },
  provide: (field) =>
    formattedRenderInputs.compute([field], (state) => state.field(field).key),
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
 * undo place one there.
 */
const revealFolds = EditorState.transactionExtender.of((transaction) => {
  const { state } = transaction
  const tree = formattedSyntaxTree(state)
  if (!tree) return null
  const effects: StateEffect<Fold & { from: number }>[] = []
  for (const range of state.selection.ranges)
    for (const pos of [range.anchor, range.head])
      for (
        let node: SyntaxNode | null = tree.resolve(pos, 1);
        node;
        node = node.parent
      ) {
        const body = node.name === 'Blockquote' && foldedBody(state, node)
        if (body && body.from < pos && pos < body.to)
          effects.push(
            setFold.of({ from: node.from, fold: body.fold, expanded: true }),
          )
      }
  return effects.length ? { effects } : null
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
  extension: [folds, revealFolds],
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
        const type = titleOf(state.sliceDoc(title.from, title.to))?.type
        return {
          width: '19px',
          class: `hibi-lp-alert hibi-lp-alert-${type ?? 'note'}`,
          paint: (left, top) =>
            [
              `linear-gradient(var(--alert-color), var(--alert-color)) ${left} ${top} / 3px calc(100% - ${top}) no-repeat`,
              `linear-gradient(var(--alert-tint), var(--alert-tint)) ${left} ${top} / calc(100% - ${left}) calc(100% - ${top}) no-repeat`,
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
