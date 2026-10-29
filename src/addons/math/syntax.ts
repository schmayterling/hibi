import { Marked, type MarkedExtension } from 'marked'
import { blockContainers } from '../../shared/marked-blocks.ts'
import { leafBlock } from '../../shared/marked-leaf-blocks.ts'
import {
  detector,
  mathTokens as grammar,
  mathFlavor as info,
  blockMath as readBlockMath,
} from './grammar.ts'
import { mathParagraphRule } from './paragraph-rule.ts'

export { blockMathStart, inlineMath } from './grammar.ts'
export { mathParagraphRule } from './paragraph-rule.ts'
export const mathFlavor = { ...info, paragraphRules: [mathParagraphRule] }

export function blockMath(source: string) {
  const token = readBlockMath(source)
  return token && leafBlock(token)
}

export const mathTokens: MarkedExtension = {
  ...grammar,
  tokenizer: blockContainers,
  extensions: (grammar.extensions ?? []).map((extension) =>
    extension.name === 'blockMath'
      ? { ...extension, tokenizer: blockMath }
      : extension,
  ),
}
detector.defaults = new Marked(mathTokens).defaults

export { detector }
