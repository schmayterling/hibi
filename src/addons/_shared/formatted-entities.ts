import type { EditorState } from '@codemirror/state'
import { WidgetType } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { decodeHTMLStrict } from 'entities'
import {
  type FormattedDecorations,
  type FormattedRenderContext,
  formattedLinkAttributes,
  formattedLiteral,
} from '../../renderer/src/formatted-contributions.ts'

/*
 * Character references in addon syntax in the formatted view: each shows the
 * characters it stands for, as the rich view's text decodes them
 * (`decodeMarkdownEntities`), and its source under the caret. Only the
 * references the viewport shows are read and drawn, each whole.
 */

const references =
  /&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]+);/g
const reference = new RegExp(`^${references.source}$`)
/**
 * How far a reference that the viewport shows can reach beyond it: the
 * longest that decodes, `&CounterClockwiseContourIntegral;`, has 33 characters.
 */
const reach = 32

type Range = { from: number; to: number }
type Reference = Range & { parent?: SyntaxNode | null }

/** The characters a reference stands for, with the attributes of the text around it. */
class Glyphs extends WidgetType {
  readonly text: string
  readonly attributes: Record<string, string>
  constructor(text: string, attributes: Record<string, string>) {
    super()
    this.text = text
    this.attributes = attributes
  }
  override eq(other: Glyphs) {
    return (
      other.text === this.text &&
      JSON.stringify(other.attributes) === JSON.stringify(this.attributes)
    )
  }
  toDOM() {
    const span = document.createElement('span')
    for (const [name, value] of Object.entries(this.attributes))
      span.setAttribute(name, value)
    span.classList.add('hibi-lp-entity')
    span.textContent = this.text
    return span
  }
  // Clicks reach the editor, which places the caret or follows a link there.
  override ignoreEvent() {
    return false
  }
}

/** The part of `[from, to)` in the viewport. */
function shown({ visible }: FormattedRenderContext, from: number, to: number) {
  return visible
    ? { from: Math.max(from, visible.from), to: Math.min(to, visible.to) }
    : { from, to }
}

/** The references in `[from, to)` that overlap `part` of it, read only around it. */
function* referencesIn(
  state: EditorState,
  from: number,
  to: number,
  part: Range,
) {
  if (part.from >= part.to) return
  const start = Math.max(from, part.from - reach)
  const text = state.sliceDoc(start, Math.min(to, part.to + reach))
  for (const match of text.matchAll(references)) {
    const at = start + match.index
    if (at < part.to && at + match[0].length > part.from)
      yield { from: at, to: at + match[0].length }
  }
}

/**
 * The `Entity` nodes in `node` that overlap `visible`, outside the nodes in
 * it named `skip`, which show their own.
 */
export function* entityNodes(
  node: SyntaxNode,
  visible: Range | null,
  skip: string,
): Generator<SyntaxNode> {
  const { from, to } = visible ?? node
  for (
    let child = node.childAfter(from);
    child && child.from < to;
    child = child.nextSibling
  )
    if (child.name === 'Entity') yield child
    else if (child.name !== skip) yield* entityNodes(child, visible, skip)
}

/** The link mark may end at a replacement's boundary, outside its DOM. */
function glyphAttributes(
  state: EditorState,
  entity: Reference,
  attributes: Record<string, string> | null,
) {
  if (!state.facet(formattedLiteral).includes('Link'))
    for (let node = entity.parent; node; node = node.parent) {
      if (node.name !== 'Link') continue
      // Endpoints distinguish inline links from references without scanning the label.
      const open = node.firstChild
      if (
        open?.name === 'LinkMark' &&
        state.sliceDoc(open.from, open.to) === '[' &&
        state.sliceDoc(node.to - 1, node.to) === ')'
      )
        return {
          ...attributes,
          class: [attributes?.class, 'hibi-lp-link'].filter(Boolean).join(' '),
        }
    }
  return attributes ?? {}
}

/** The glyphs for `entity`, or null when it stands for itself. */
function decoded(
  state: EditorState,
  entity: Reference,
  attributes: Record<string, string> | null,
) {
  const source = state.sliceDoc(entity.from, entity.to)
  const text = reference.test(source) ? decodeHTMLStrict(source) : source
  return text === source
    ? null
    : new Glyphs(text, glyphAttributes(state, entity, attributes))
}

/**
 * Marks `[from, to)` with `attributes`, if any, and shows the references in
 * it as their characters, each until the caret touches it while the node is
 * revealed. `entities` are the references to show, by default every one in
 * the text; only those the viewport shows are drawn. A mark doesn't wrap a
 * replacement that ends where it ends, so the marks leave the references out
 * and their glyphs take the attributes.
 */
export function markDecoded(
  out: FormattedDecorations,
  context: FormattedRenderContext,
  from: number,
  to: number,
  attributes: Record<string, string> | null,
  entities?: Iterable<Reference>,
) {
  const { state, revealed } = context
  const part = shown(context, from, to)
  let at = part.from
  for (const entity of entities ?? referencesIn(state, from, to, part)) {
    if (
      revealed &&
      state.selection.ranges.some(
        (range) => range.from <= entity.to && range.to >= entity.from,
      )
    )
      continue
    const glyphs = decoded(state, entity, attributes)
    if (!glyphs) continue
    if (attributes && at < entity.from) out.mark(at, entity.from, attributes)
    out.replace(entity.from, entity.to, glyphs)
    at = entity.to
  }
  if (attributes && at < part.to) out.mark(at, part.to, attributes)
}

/**
 * Marks `[from, to)` with `attributes` as one piece of text around the
 * references in it, which show their characters until the node is revealed
 * and all of its source shows. With `link`, the text reads as a link. The
 * glyphs take the mark's class.
 */
export function wrapDecoded(
  out: FormattedDecorations,
  context: FormattedRenderContext,
  from: number,
  to: number,
  attributes: Record<string, string>,
  link = false,
) {
  const { state, revealed } = context
  const part = shown(context, from, to)
  if (part.from < part.to)
    if (link) out.link(part.from, part.to, attributes)
    else out.mark(part.from, part.to, attributes)
  if (revealed) return
  const glyph = {
    class:
      (link ? formattedLinkAttributes(attributes) : attributes).class ?? '',
  }
  for (const entity of referencesIn(state, from, to, part)) {
    const glyphs = decoded(state, entity, glyph)
    if (glyphs) out.replace(entity.from, entity.to, glyphs)
  }
}
