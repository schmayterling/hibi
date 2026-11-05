import { Marked, type MarkedExtension } from 'marked'
import { blockContainers } from '../../shared/marked-blocks.ts'
import { leafBlock } from '../../shared/marked-leaf-blocks.ts'
import { blockStart } from '../_shared/block-start.ts'
import {
  blockMathLine,
  detector,
  mathTokens as grammar,
  mathFlavor as info,
  blockMath as readBlockMath,
} from './grammar.ts'

export { blockMathStart, inlineMath } from './grammar.ts'
export const mathFlavor = info

export function blockMath(source: string) {
  const token = readBlockMath(source)
  return token && leafBlock(token)
}

/**
 * The math tokens while `blocks` says whether display math is on. While it is
 * off, a closed block is kept as written and anything else stays Markdown, as
 * the formatted view reads it: an unclosed `$$` line holds no text.
 */
export const mathTokensWith = (blocks: () => boolean): MarkedExtension => ({
  ...grammar,
  tokenizer: blockContainers,
  extensions: (grammar.extensions ?? []).map((extension) =>
    extension.name === 'blockMath'
      ? {
          ...extension,
          start: blockStart(blockMathLine, blocks),
          tokenizer: (source) => {
            const token = blockMath(source)
            return blocks() || (token?.type === 'blockMath' && token.closed)
              ? token
              : undefined
          },
        }
      : extension,
  ),
})

export const mathTokens = mathTokensWith(() => true)
detector.defaults = new Marked(mathTokens).defaults

export { detector }
