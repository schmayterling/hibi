import { WidgetType } from '@codemirror/view'
import { decodeHTMLStrict } from 'entities'
import type { FormattedContribution } from '../formatted-contributions.ts'

/** The character an entity stands for, shown in place of its source. */
export class EntityWidget extends WidgetType {
  readonly text: string
  constructor(text: string) {
    super()
    this.text = text
  }
  override eq(other: EntityWidget) {
    return other.text === this.text
  }
  toDOM() {
    const glyph = document.createElement('span')
    glyph.className = 'hibi-lp-entity'
    glyph.textContent = this.text
    return glyph
  }
}

/** `&amp;`, `&#169;` and `&#x1F600;` show their characters; the source shows while revealed. */
export const contribution: FormattedContribution = {
  id: 'core.entities',
  views: [
    {
      nodes: ['Entity'],
      decorate(node, out, { state, revealed }) {
        const source = state.sliceDoc(node.from, node.to)
        const text = decodeHTMLStrict(source)
        // Unknown names are text, as in the rich editor.
        if (text === source) return false
        if (revealed) out.mark(node.from, node.to, { class: 'hibi-lp-marker' })
        else out.replace(node.from, node.to, new EntityWidget(text))
        return false
      },
    },
  ],
}
