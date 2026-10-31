import { type MarkdownConfig, parser } from '@lezer/markdown'

const blockParser = Object.assign(parser.configure({}), {
  parseInline: () => [],
})

/** Lezer's inline HTML open tag, for `<img>` only. */
const imageTag =
  /<img(?:\s+[a-z:_][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>/iy
/** Lezer's HTML block opener that only a blank line ends, for a lone `<img>` tag. */
const imageLine =
  /^<img(?:\s+[a-z:_][\w.-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*>\s*$/i

/**
 * An `<img>` tag is an `HTMLImage` around its `HTMLTag`, so renderers that
 * draw images visit no other tags.
 */
export const HTMLImage: MarkdownConfig = {
  defineNodes: ['HTMLImage'],
  parseInline: [
    {
      name: 'HTMLImage',
      before: 'HTMLTag',
      parse(cx, next, start) {
        if (next !== 60) return -1
        imageTag.lastIndex = start - cx.offset
        const tag = imageTag.exec(cx.text)
        if (!tag) return -1
        const end = start + tag[0].length
        return cx.addElement(
          cx.elt('HTMLImage', start, end, [cx.elt('HTMLTag', start, end)]),
        )
      },
    },
  ],
}

/**
 * CommonMark's blank-line HTML blocks end on blank container content too.
 * Keep the upstream opener grammar and the explicit-terminator block kinds.
 * A lone `<img>` line reads as the paragraph of a Markdown image, as
 * `<img … />` already does.
 */
export const ContainerHTML: MarkdownConfig = {
  parseBlock: [
    {
      name: 'ContainerHTML',
      before: 'HTMLBlock',
      parse(cx, line) {
        if (line.next !== 60 || line.indent >= line.baseIndent + 4) return false
        const first = line.text.slice(line.pos)
        const image = imageLine.test(first)
        if (!image) {
          // Outside containers, only a retained CR can hide a blank line.
          if (cx.depth === 1 && !line.text.endsWith('\r')) return false
          if (/^<(?:[!?]|(?:script|pre|style|textarea)(?:\s|>|$))/i.test(first))
            return false
          // Ask the base grammar whether a blank line ends this opener.
          const block = blockParser.parse(`${first}\n\nx`).topNode.firstChild
          if (block?.name !== 'HTMLBlock' || block.to > first.length)
            return false
        }
        const from = cx.lineStart + line.pos
        let to = cx.lineStart + line.text.length,
          lone = image
        const marks: typeof line.markers = []
        while (cx.nextLine()) {
          // Lezer's runtime line depth records which composites still match.
          if ((line as typeof line & { depth: number }).depth < cx.depth) break
          if (/^[ \t\r]*$/.test(line.text.slice(line.basePos))) break
          for (const mark of line.markers) marks.push(mark)
          to = cx.lineStart + line.text.length
          lone = false
        }
        cx.addElement(
          lone
            ? cx.elt('Paragraph', from, to, cx.parser.parseInline(first, from))
            : cx.elt('HTMLBlock', from, to, marks),
        )
        return true
      },
    },
  ],
}
