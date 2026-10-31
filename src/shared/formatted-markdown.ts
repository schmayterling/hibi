import { NodeProp, Tree } from '@lezer/common'
import {
  InlineContext,
  type MarkdownConfig,
  type MarkdownExtension,
  parser,
} from '@lezer/markdown'
import { protectMarkdownParser } from './markdown-flavor-guard.ts'
import { ContainerHTML, HTMLImage } from './markdown-html-syntax.ts'

/** Facts collected while finding a code span's closing fence, kept on its opening mark. */
export const inlineCodeInfo = new NodeProp<{
  longest: number
  blank: boolean
}>({ perNode: true })

const codeParser = parser.configure({
  parseInline: [
    {
      name: 'InlineCode',
      parse(cx, next, start) {
        if (next !== 96 || (start && cx.char(start - 1) === 96)) return -1
        let pos = start + 1
        while (pos < cx.end && cx.char(pos) === 96) pos++
        const size = pos - start
        let run = 0,
          longest = 0,
          blank = true
        for (; pos < cx.end; pos++) {
          const char = cx.char(pos)
          if (char === 96) {
            run++
            if (run === size && cx.char(pos + 1) !== 96) {
              const mark = cx.elt('CodeMark', start, start + size)
              const opening = new Tree(
                cx.parser.nodeSet.types[mark.type]!,
                [],
                [],
                size,
                [[inlineCodeInfo, { longest, blank }]],
              )
              return cx.addElement(
                cx.elt('InlineCode', start, pos + 1, [
                  cx.elt(opening, start),
                  cx.elt('CodeMark', pos + 1 - size, pos + 1),
                ]),
              )
            }
          } else {
            if (run) {
              longest = Math.max(longest, run)
              blank = false
              run = 0
            }
            if (char !== 32 && char !== 10) blank = false
          }
        }
        return -1
      },
    },
  ],
})

/** The core parser's emphasis delimiter rules, over the adjacent Unicode scalars. */
export function emphasisFlanks(marker: number, before: string, after: string) {
  const pBefore = /[\p{P}\p{S}]/u.test(before),
    pAfter = /[\p{P}\p{S}]/u.test(after)
  const sBefore = /\s|^$/.test(before),
    sAfter = /\s|^$/.test(after)
  const left = !sAfter && (!pAfter || sBefore || pBefore)
  const right = !sBefore && (!pBefore || sAfter || pAfter)
  return {
    open: left && (marker === 42 || !right || pBefore),
    close: right && (marker === 42 || !left || pAfter),
  }
}

const UnicodeEmphasis: MarkdownConfig = {
  parseInline: [
    {
      name: 'Emphasis',
      parse(cx, next, from) {
        if (next !== 42 && next !== 95) return -1
        let to = from + 1
        while (cx.char(to) === next) to++
        // A flank is one code point, even when it occupies two UTF-16 units.
        const before =
          cx.slice(Math.max(cx.offset, from - 2), from).match(/.$/su)?.[0] ?? ''
        const after = cx.slice(to, to + 2).match(/^./su)?.[0] ?? ''
        const { open, close } = emphasisFlanks(next, before, after)
        return cx.addDelimiter(
          next === 42
            ? InlineContext.emphasisAsterisk
            : InlineContext.emphasisUnderscore,
          from,
          to,
          open,
          close,
        )
      },
    },
  ],
}

const coreParser = codeParser.configure([UnicodeEmphasis, HTMLImage])

/** The same core grammar and contributed syntax in the formatted view and its worker. */
export function formattedMarkdownParser(
  contributed: readonly MarkdownConfig[],
  extensions: MarkdownExtension = [],
) {
  return protectMarkdownParser(coreParser, [
    { defineNodes: [{ name: 'Frontmatter', block: true }] },
    ContainerHTML,
    ...contributed,
    extensions,
  ])
}

/** The table view's inline-only grammar, shared with worker cell projection. */
export function formattedInlineParser(contributed: readonly MarkdownConfig[]) {
  const inline = protectMarkdownParser(coreParser, contributed)
  const blocks =
    (inline as unknown as { blockNames?: readonly string[] }).blockNames ?? []
  return inline.configure({ remove: [...blocks] })
}
