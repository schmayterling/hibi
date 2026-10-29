import { Marked, type MarkedExtension } from 'marked'
import { blockContainers } from '../../shared/marked-blocks.ts'
import { leafBlock } from '../../shared/marked-leaf-blocks.ts'
import { detector, textExtrasMarkdown as grammar } from './grammar.ts'

export {
  detectTextExtras,
  subscriptToken,
  subtextStart,
  subtextToken,
} from './grammar.ts'

export const textExtrasMarkdown: MarkedExtension = {
  ...grammar,
  tokenizer: blockContainers,
  extensions: (grammar.extensions ?? []).map((extension) =>
    extension.name === 'subtext' && 'tokenizer' in extension
      ? {
          ...extension,
          tokenizer(source, tokens) {
            const token = extension.tokenizer.call(this, source, tokens)
            return token && leafBlock(token)
          },
        }
      : extension,
  ),
}
detector.defaults = new Marked(textExtrasMarkdown).defaults

export { detector }
