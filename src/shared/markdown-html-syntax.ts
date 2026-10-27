import { type MarkdownConfig, parser } from '@lezer/markdown'

const blockParser = Object.assign(parser.configure({}), {
  parseInline: () => [],
})

/**
 * CommonMark's blank-line HTML blocks end on blank container content too.
 * Keep the upstream opener grammar and the explicit-terminator block kinds.
 */
export const ContainerHTML: MarkdownConfig = {
  parseBlock: [
    {
      name: 'ContainerHTML',
      before: 'HTMLBlock',
      parse(cx, line) {
        if (line.next !== 60 || line.indent >= line.baseIndent + 4) return false
        // Outside containers, only a retained CR can hide a blank line.
        if (cx.depth === 1 && !line.text.endsWith('\r')) return false
        const first = line.text.slice(line.pos)
        if (/^<(?:[!?]|(?:script|pre|style|textarea)(?:\s|>|$))/i.test(first))
          return false
        // Ask the base grammar whether a blank line ends this opener.
        const block = blockParser.parse(`${first}\n\nx`).topNode.firstChild
        if (block?.name !== 'HTMLBlock' || block.to > first.length) return false
        const from = cx.lineStart + line.pos
        let to = cx.lineStart + line.text.length
        const marks: typeof line.markers = []
        while (cx.nextLine()) {
          // Lezer's runtime line depth records which composites still match.
          if ((line as typeof line & { depth: number }).depth < cx.depth) break
          if (/^[ \t\r]*$/.test(line.text.slice(line.basePos))) break
          for (const mark of line.markers) marks.push(mark)
          to = cx.lineStart + line.text.length
        }
        cx.addElement(cx.elt('HTMLBlock', from, to, marks))
        return true
      },
    },
  ],
}
