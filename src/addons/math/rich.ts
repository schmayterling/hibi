import { InputRule, type NodeViewRenderer } from '@tiptap/core'
import { BlockMath, InlineMath } from '@tiptap/extension-mathematics'
import { blockMath, blockMathStart, richInlineMath } from './syntax'

/** The Tiptap editor's math nodes, drawn with the given formula views. */
export function mathNodes(view: (display: boolean) => NodeViewRenderer) {
  const inline = InlineMath.extend({
    // The rich editor preserves double-dollar source until it can draw display
    // math inline. Its line breaks read as spaces, as in the text around it.
    parseMarkdown: (token, helpers) =>
      token.display
        ? helpers.createTextNode(
            (token.raw ?? '').replace(/[ \t]*\n[ \t]*/g, ' '),
          )
        : helpers.createNode('inlineMath', { latex: token.latex }),
    markdownTokenizer: {
      name: 'inlineMath',
      level: 'inline',
      start: (source) => source.indexOf('$'),
      tokenize: richInlineMath,
    },
    addInputRules() {
      return [
        new InputRule({
          find: /(?:^|[^\\$])(\$(?!\$)(?:\\.|[^$\n])+?\$)$/,
          handler: ({ state, range, match }) => {
            const raw = match[1],
              token = raw && richInlineMath(raw)
            if (!token) return null
            state.tr.replaceWith(
              range.to - raw.length,
              range.to,
              this.type.create({ latex: token.latex }),
            )
          },
        }),
      ]
    },
    addNodeView: () => view(false),
  })
  const block = BlockMath.extend({
    markdownTokenizer: {
      name: 'blockMath',
      level: 'block',
      start: blockMathStart,
      tokenize: blockMath,
    },
    addInputRules() {
      return [
        new InputRule({
          find: /^\$\$([^$\n]+)\$\$$/,
          handler: ({ state, range, match }) => {
            const token = blockMath(match[0])
            const from = state.doc.resolve(range.from)
            if (!token || !from.depth || !from.parent.isTextblock) return null
            state.tr.replaceWith(
              from.before(),
              from.after(),
              this.type.create({ latex: token.latex }),
            )
          },
        }),
      ]
    },
    addNodeView: () => view(true),
  })
  return [inline, block]
}
