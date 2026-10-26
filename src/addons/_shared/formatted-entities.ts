import type { EditorState } from '@codemirror/state'
import { WidgetType } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { decodeHTMLStrict } from 'entities'
import {
  type FormattedDecorations,
  formattedLiteral,
} from '../../renderer/src/formatted-contributions.ts'

/*
 * Character references in addon syntax in the formatted view: each shows the
 * characters it stands for, as the rich view's text decodes them
 * (`decodeMarkdownEntities`), and its source under the caret.
 */

const references =
  /&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]+);/g
const reference = new RegExp(`^${references.source}$`)

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

/** The references in `[from, to)` of the document. */
function* referencesIn(state: EditorState, from: number, to: number) {
  for (const match of state.sliceDoc(from, to).matchAll(references))
    yield {
      from: from + match.index,
      to: from + match.index + match[0].length,
    }
}

/** The link mark may end at a replacement's boundary, outside its DOM. */
function glyphAttributes(
  state: EditorState,
  entity: { parent?: SyntaxNode | null },
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

/**
 * Marks `[from, to)` with `attributes`, if any, and shows the references in
 * it as their characters, each until the caret touches it while `revealed`.
 * `entities` are the ranges to read, by default every reference in the
 * text. A mark doesn't wrap a replacement that ends where it ends, so the
 * marks leave the references out and their glyphs take the attributes.
 */
export function markDecoded(
  state: EditorState,
  out: FormattedDecorations,
  from: number,
  to: number,
  attributes: Record<string, string> | null,
  revealed: boolean,
  entities: Iterable<{
    from: number
    to: number
    parent?: SyntaxNode | null
  }> = referencesIn(state, from, to),
) {
  let at = from
  for (const entity of entities) {
    if (
      revealed &&
      state.selection.ranges.some(
        (range) => range.from <= entity.to && range.to >= entity.from,
      )
    )
      continue
    const source = state.sliceDoc(entity.from, entity.to)
    const text = reference.test(source) ? decodeHTMLStrict(source) : source
    if (text === source) continue
    if (attributes && at < entity.from) out.mark(at, entity.from, attributes)
    out.replace(
      entity.from,
      entity.to,
      new Glyphs(text, glyphAttributes(state, entity, attributes)),
    )
    at = entity.to
  }
  if (attributes && at < to) out.mark(at, to, attributes)
}
