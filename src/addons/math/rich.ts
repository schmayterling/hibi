import { InputRule, type NodeViewRenderer } from '@tiptap/core'
import { BlockMath, InlineMath } from '@tiptap/extension-mathematics'
import { leafBlock } from '../../shared/marked-leaf-blocks.ts'
import { blockStart } from '../_shared/block-start.ts'
import { formulaLimit } from './inline-display.ts'
import { blockMath, richInlineMath } from './syntax'

// Tiptap draws display math only as blocks: a formula alone on its line, which
// Obsidian reads as display math in a paragraph, stays a block here, and a
// display block over the formula limit stays paragraph text.
const richBlockMathStart = blockStart(/ {0,3}\$\$/)
const lineMath = /^ {0,3}\$\$((?:\\.|(?!\$\$)[^\\\n])+?)\$\$[ \t]*(?:\n|$)/
function richBlockMath(source: string) {
  const [raw, body = ''] = lineMath.exec(source) ?? []
  if (raw && body.trim() && body.length <= formulaLimit)
    return leafBlock({ type: 'blockMath', raw, latex: body.trim() })
  const token = blockMath(source)
  return token?.type === 'blockMath' ? token : undefined
}

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
      start: richBlockMathStart,
      tokenize: richBlockMath,
    },
    addInputRules() {
      return [
        new InputRule({
          find: /^\$\$([^$\n]+)\$\$$/,
          handler: ({ state, range, match }) => {
            const token = richBlockMath(match[0])
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
