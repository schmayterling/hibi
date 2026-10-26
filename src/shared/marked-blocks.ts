import { Lexer, type MarkedExtension, Tokenizer } from 'marked'

// Keep Marked's start, interruption and underline grammar, but replace its
// per-character (.|newline)+? backtracking with an iterative line scan.
// These delimiters describe the pinned Marked rule; equivalence tests guard it.
const setextRules = new Map(
  [Lexer.rules.block.normal.lheading, Lexer.rules.block.gfm.lheading].map(
    (rule) => {
      const [start, body] = rule.source.split('((?:.|\\n(?!') as [
        string,
        string,
      ]
      const [interrupt, underline] = body.split('))+?)\\n') as [string, string]
      return [
        rule,
        {
          start: new RegExp(start),
          interrupt: new RegExp(`^(?:${interrupt})`),
          underline: new RegExp(`^${underline}`),
        },
      ] as const
    },
  ),
)

export const blockMarkdown: MarkedExtension = {
  tokenizer: {
    lheading(source) {
      return BlockTokenizer.prototype.lheading.call(this, source)
    },
  },
}

export class BlockTokenizer extends Tokenizer {
  override lheading(source: string) {
    const rule = setextRules.get(this.rules.block.lheading)
    if (!rule) return super.lheading(source)
    if (!rule.start.test(source)) return
    let from = 0
    for (;;) {
      const end = source.indexOf('\n', from)
      if (end < 0) return
      // A dot in the original text capture excludes these line terminators.
      if (/[\r\u2028\u2029]/.test(source.slice(from, end))) return
      const rest = source.slice(end + 1)
      const underline = rule.underline.exec(rest)
      if (end > 0 && underline) {
        const text = source.slice(0, end).trim()
        return {
          type: 'heading' as const,
          raw: source
            .slice(0, end + 1 + underline[0].length)
            .replace(/\n+$/, ''),
          depth: underline[1]?.charAt(0) === '=' ? 1 : 2,
          text,
          tokens: this.lexer.inline(text),
        }
      }
      if (rule.interrupt.test(rest)) return
      from = end + 1
    }
  }
}
